import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { TICKER_LIST } from '../../lib/tickers';

const SCAN_PASSWORD_HASH = 'ea4de091b760a4e538140c342585130649e646c54d4939ae7f142bb81d5506fa';
import { initScreenerTable, upsertScreenerRow, getScreenerData, getScanMetadata } from '../../lib/db';
import https from 'https';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Low-level HTTPS helpers ──
function rawGet(url: string, headers: Record<string, string> = {}): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: { 'User-Agent': UA, ...headers },
        }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk));
            res.on('end', () => resolve({
                statusCode: res.statusCode || 0,
                headers: res.headers as any,
                body,
            }));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    });
}

// ── Yahoo Session: get cookie + crumb once, reuse for all requests ──
interface YahooSession {
    cookie: string;
    crumb: string;
}

async function getYahooSession(retries = 3): Promise<YahooSession | null> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            // Step 1: Get session cookies
            const initRes = await rawGet('https://fc.yahoo.com/');
            const rawCookies = initRes.headers['set-cookie'];
            let cookie = '';
            if (rawCookies) {
                const arr = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
                cookie = arr.map(c => c.split(';')[0]).join('; ');
            }
            if (!cookie) {
                console.warn(`[Yahoo] No cookies (attempt ${attempt})`);
                await sleep(2000 * attempt);
                continue;
            }

            // Step 2: Get crumb using cookies
            const crumbRes = await rawGet(
                'https://query2.finance.yahoo.com/v1/test/getcrumb',
                { Cookie: cookie }
            );

            if (crumbRes.statusCode === 429) {
                console.warn(`[Yahoo] Crumb rate limited (attempt ${attempt}), waiting...`);
                await sleep(5000 * attempt);
                continue;
            }
            if (crumbRes.statusCode !== 200) {
                console.warn(`[Yahoo] Crumb status ${crumbRes.statusCode} (attempt ${attempt})`);
                await sleep(3000 * attempt);
                continue;
            }

            console.log('[Yahoo] Session established');
            return { cookie, crumb: crumbRes.body };
        } catch (err: any) {
            console.warn(`[Yahoo] Session attempt ${attempt} failed: ${err.message}`);
            if (attempt < retries) await sleep(3000 * attempt);
        }
    }
    return null;
}

// ── Batch v7 quote with existing session (up to ~50 symbols per call) ──
async function batchQuoteV7(
    symbols: string[],
    session: YahooSession
): Promise<any[]> {
    const symbolStr = symbols.join(',');
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolStr)}&crumb=${encodeURIComponent(session.crumb)}`;

    const res = await rawGet(url, { Cookie: session.cookie });

    if (res.statusCode === 429) {
        throw new Error('rate-limited');
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
        throw new Error('auth-expired');
    }
    if (res.statusCode !== 200) {
        throw new Error(`status ${res.statusCode}`);
    }

    const data = JSON.parse(res.body);
    return data.quoteResponse?.result || [];
}

// ── v8 chart fallback (no auth needed) ──
async function chartQuote(symbol: string): Promise<any | null> {
    try {
        const res = await rawGet(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`
        );
        if (res.statusCode !== 200) return null;
        const meta = JSON.parse(res.body).chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) return null;
        return {
            symbol: meta.symbol || symbol,
            regularMarketPrice: meta.regularMarketPrice,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
            regularMarketVolume: meta.regularMarketVolume,
            longName: meta.longName,
            shortName: meta.shortName,
        };
    } catch {
        return null;
    }
}

// ── v10 quoteSummary with session (for fundamentals) ──
async function quoteSummary(
    symbol: string,
    session: YahooSession
): Promise<any | null> {
    try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData,summaryDetail,assetProfile,defaultKeyStatistics,price&crumb=${encodeURIComponent(session.crumb)}`;
        const res = await rawGet(url, { Cookie: session.cookie });
        if (res.statusCode !== 200) return null;
        const data = JSON.parse(res.body);
        return data.quoteSummary?.result?.[0] || null;
    } catch {
        return null;
    }
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    try {
        const isAuthorizedCron = req.headers['x-vercel-cron'] === '1'
            || req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
            || (req.query.key === process.env.CRON_SECRET && process.env.CRON_SECRET);

        // ── GET: return cached data ──
        // Only skip the scan return if we aren't trying to force a scan via GET
        if (req.method === 'GET' && !isAuthorizedCron && req.query.force !== 'true') {
            try {
                await initScreenerTable();
                const stocks = await getScreenerData();
                const meta = await getScanMetadata();
                return res.status(200).json({
                    stocks,
                    totalStocks: meta.count,
                    lastUpdated: meta.lastUpdated,
                });
            } catch (dbErr: any) {
                console.error('[Screener] DB read failed:', dbErr.message);
                return res.status(200).json({ stocks: [], totalStocks: 0, lastUpdated: null });
            }
        }

        // ── POST / Cron / Forced GET: run scan ──
        if (req.method === 'POST' || isAuthorizedCron || (req.method === 'GET' && req.query.force === 'true')) {
            // Security Check
            if (!isAuthorizedCron) {
                if (req.method === 'POST') {
                    const { password } = req.body;
                    if (!password) {
                        return res.status(401).json({ error: 'Password required' });
                    }
                    const hash = crypto.createHash('sha256').update(password).digest('hex');
                    if (hash !== SCAN_PASSWORD_HASH) {
                        return res.status(401).json({ error: 'Invalid password' });
                    }
                } else {
                    // It's a GET with force=true but missing key
                    return res.status(401).json({ error: 'Unauthorized: Missing or invalid key' });
                }
            }

            console.log('[Screener] Starting scan...');
            const startTime = Date.now();
            await initScreenerTable();

            // ── Rate Limiting / Cooldown ──
            // Prevent spam-clicking: if data is < 15 mins old, don't re-scan unless forced or cron
            const meta = await getScanMetadata();
            if (!isAuthorizedCron && req.query.force !== 'true' && meta.lastUpdated) {
                const last = new Date(meta.lastUpdated);
                const now = new Date();
                const diffMs = now.getTime() - last.getTime();
                const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

                if (diffMs < COOLDOWN_MS) {
                    const diffMins = Math.round(diffMs / 60000);
                    console.log(`[Screener] Skipping scan (last run ${diffMins}m ago)`);
                    return res.status(200).json({
                        success: true,
                        processed: 0,
                        failed: 0,
                        total: meta.count,
                        durationSeconds: "0.0",
                        message: `Data is fresh (${diffMins}m ago). Skipping scan.`
                    });
                }
            }

            const allTickers = TICKER_LIST;
            if (!allTickers.length) {
                return res.status(500).json({ error: 'No tickers loaded from CSV' });
            }

            console.log(`[Screener] ${allTickers.length} tickers`);

            // Establish Yahoo session (cookie + crumb) ONCE
            const session = await getYahooSession();
            const hasSession = !!session;
            console.log(`[Screener] Session: ${hasSession ? 'established' : 'FAILED (will use chart fallback only)'}`);

            let totalProcessed = 0;
            let totalFailed = 0;
            const quoteMap: Record<string, any> = {};

            // ── Phase 1: Get quotes ──
            if (hasSession) {
                // Use v7 batch quote (50 at a time) — includes mcap, PE, divYield
                const BATCH = 50;
                // Process batches in parallel chunks (e.g., 5 batches at once) to speed up
                const PARALLEL_BATCHES = 5;
                for (let i = 0; i < allTickers.length; i += BATCH * PARALLEL_BATCHES) {
                    const chunkPromises = [];
                    for (let j = 0; j < PARALLEL_BATCHES; j++) {
                        const start = i + (j * BATCH);
                        if (start >= allTickers.length) break;
                        const batch = allTickers.slice(start, start + BATCH);

                        chunkPromises.push((async () => {
                            try {
                                const quotes = await batchQuoteV7(batch, session!);
                                for (const q of quotes) {
                                    if (q?.symbol) quoteMap[q.symbol] = q;
                                }
                            } catch (err: any) {
                                console.warn(`[Screener] Batch error at ${start}: ${err.message}`);
                            }
                        })());
                    }
                    await Promise.all(chunkPromises);
                    if (i + (BATCH * PARALLEL_BATCHES) < allTickers.length) await sleep(200);
                }
                console.log(`[Screener] Phase 1 (v7): ${Object.keys(quoteMap).length} quotes`);
            }

            // Fallback: use v8 chart for any tickers missing from v7
            const missingTickers = allTickers.filter(t => !quoteMap[t]);
            if (missingTickers.length > 0) {
                console.log(`[Screener] Phase 1b: chart fallback for ${missingTickers.length} tickers`);
                const CHART_CONCURRENCY = 15;
                for (let i = 0; i < missingTickers.length; i += CHART_CONCURRENCY) {
                    const batch = missingTickers.slice(i, i + CHART_CONCURRENCY);
                    const results = await Promise.allSettled(batch.map(t => chartQuote(t)));
                    for (const r of results) {
                        if (r.status === 'fulfilled' && r.value) {
                            quoteMap[r.value.symbol] = r.value;
                        }
                    }
                    if (i + CHART_CONCURRENCY < missingTickers.length) await sleep(100);
                }
                console.log(`[Screener] Phase 1 total: ${Object.keys(quoteMap).length} quotes`);
            }

            if (Object.keys(quoteMap).length === 0) {
                return res.status(500).json({
                    error: 'No quotes obtained from Yahoo Finance',
                    details: 'Both v7 batch and v8 chart endpoints failed',
                });
            }

            // ── Phase 2: Get fundamentals (only if session works) ──
            const tickers = Object.keys(quoteMap);
            const fundMap: Record<string, any> = {};

            if (hasSession) {
                const FUND_CONCURRENCY = 5;
                for (let i = 0; i < tickers.length; i += FUND_CONCURRENCY) {
                    const batch = tickers.slice(i, i + FUND_CONCURRENCY);
                    const results = await Promise.allSettled(
                        batch.map(t => quoteSummary(t, session!))
                    );
                    for (let j = 0; j < batch.length; j++) {
                        const r = results[j];
                        if (r.status === 'fulfilled' && r.value) {
                            fundMap[batch[j]] = r.value;
                        }
                    }
                    if (i + FUND_CONCURRENCY < tickers.length) await sleep(300);

                    const done = Math.min(i + FUND_CONCURRENCY, tickers.length);
                    if (done % 100 === 0 || done >= tickers.length) {
                        console.log(`[Screener] Fundamentals: ${done}/${tickers.length} (${Object.keys(fundMap).length} ok)`);
                    }
                }
            }
            console.log(`[Screener] Phase 2: ${Object.keys(fundMap).length} fundamentals`);

            // ── Phase 3: Upsert to DB ──
            for (const ticker of tickers) {
                const q = quoteMap[ticker];
                const f = fundMap[ticker] || {};
                const fin = f.financialData || {};
                const det = f.summaryDetail || {};
                const prof = f.assetProfile || {};
                const pr = f.price || {};
                const ks = f.defaultKeyStatistics || {};

                const totalRevenue = fin.totalRevenue?.raw ?? null;
                const employees = prof.fullTimeEmployees ?? null;

                try {
                    await upsertScreenerRow({
                        ticker,
                        price: q.regularMarketPrice ?? null,
                        market_cap: q.marketCap ?? pr.marketCap?.raw ?? null,
                        pe_ratio: q.trailingPE ?? det.trailingPE?.raw ?? ks.trailingPE?.raw ?? null,
                        roe_pct: fin.returnOnEquity?.raw != null ? fin.returnOnEquity.raw * 100 : null,
                        debt_to_equity: fin.debtToEquity?.raw ?? null,
                        gross_margin_pct: fin.grossMargins?.raw != null ? fin.grossMargins.raw * 100 : null,
                        dividend_yield_pct: det.dividendYield?.raw != null
                            ? det.dividendYield.raw * 100
                            : q.dividendYield != null
                                ? q.dividendYield * 100
                                : null,
                        roa_pct: fin.returnOnAssets?.raw != null ? fin.returnOnAssets.raw * 100 : null,
                        total_revenue: totalRevenue,
                        revenue_per_employee: totalRevenue && employees ? totalRevenue / employees : null,
                        sector: prof.sector || null,
                        industry: prof.industry || null,
                        company_name: q.longName || q.shortName || pr.longName || ticker,
                        fifty_two_week_high: q.fiftyTwoWeekHigh ?? null,
                        fifty_two_week_low: q.fiftyTwoWeekLow ?? null,
                        beta: det.beta?.raw ?? null,
                    });
                    totalProcessed++;
                } catch (dbErr: any) {
                    console.error(`[Screener] DB error ${ticker}: ${dbErr.message}`);
                    totalFailed++;
                }
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[Screener] ✅ ${totalProcessed} ok, ${totalFailed} fail in ${duration}s`);

            return res.status(200).json({
                success: totalProcessed > 0,
                processed: totalProcessed,
                failed: totalFailed,
                total: allTickers.length,
                durationSeconds: duration,
                message: `${totalProcessed} stocks scanned in ${duration}s`,
            });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (error: any) {
        console.error('Screener API error:', error);
        return res.status(500).json({ error: 'Screener failed', details: error.message });
    }
}

export const config = {
    api: { responseLimit: false, bodyParser: { sizeLimit: '1mb' } },
    maxDuration: 300,
};
