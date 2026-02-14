import type { NextApiRequest, NextApiResponse } from 'next';
import { TICKER_LIST } from '../../lib/tickers';
import { initScreenerTable, upsertScreenerRow, getScreenerData, getScanMetadata } from '../../lib/db';
import https from 'https';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Direct HTTPS GET (no crumb needed) ──
function httpsGet(url: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk));
            res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    });
}

// ── Fetch quote data via v8 chart (NO crumb required) ──
interface ChartData {
    symbol: string;
    price: number;
    fiftyTwoWeekHigh: number;
    fiftyTwoWeekLow: number;
    volume: number;
    name: string;
    marketCap?: number;
    pe?: number;
    dividendYield?: number;
}

async function fetchChart(symbol: string): Promise<ChartData | null> {
    try {
        const res = await httpsGet(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d&includePrePost=false`
        );
        if (res.statusCode === 429) return null; // rate-limited
        if (res.statusCode !== 200) return null;

        const data = JSON.parse(res.body);
        const meta = data.chart?.result?.[0]?.meta;
        if (!meta || !meta.regularMarketPrice) return null;

        return {
            symbol: meta.symbol || symbol,
            price: meta.regularMarketPrice,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
            volume: meta.regularMarketVolume ?? 0,
            name: meta.longName || meta.shortName || symbol,
        };
    } catch {
        return null;
    }
}

// ── Fetch fundamentals via v10 quoteSummary (public, no crumb) ──
interface Fundamentals {
    pe_ratio: number | null;
    market_cap: number | null;
    roe: number | null;
    roa: number | null;
    debtToEquity: number | null;
    grossMargins: number | null;
    dividendYield: number | null;
    totalRevenue: number | null;
    fullTimeEmployees: number | null;
    sector: string | null;
    industry: string | null;
    beta: number | null;
    longName: string | null;
}

async function fetchFundamentals(symbol: string): Promise<Fundamentals | null> {
    try {
        // v10 quoteSummary – public endpoint, no crumb needed
        const res = await httpsGet(
            `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData,summaryDetail,assetProfile,defaultKeyStatistics,price`
        );
        if (res.statusCode === 429 || res.statusCode !== 200) return null;

        const data = JSON.parse(res.body);
        const result = data.quoteSummary?.result?.[0];
        if (!result) return null;

        const fin = result.financialData || {};
        const det = result.summaryDetail || {};
        const prof = result.assetProfile || {};
        const ks = result.defaultKeyStatistics || {};
        const pr = result.price || {};

        return {
            pe_ratio: det.trailingPE?.raw ?? ks.trailingPE?.raw ?? null,
            market_cap: pr.marketCap?.raw ?? det.marketCap?.raw ?? null,
            roe: fin.returnOnEquity?.raw ?? null,
            roa: fin.returnOnAssets?.raw ?? null,
            debtToEquity: fin.debtToEquity?.raw ?? null,
            grossMargins: fin.grossMargins?.raw ?? null,
            dividendYield: det.dividendYield?.raw ?? null,
            totalRevenue: fin.totalRevenue?.raw ?? null,
            fullTimeEmployees: prof.fullTimeEmployees ?? null,
            sector: prof.sector || null,
            industry: prof.industry || null,
            beta: det.beta?.raw ?? null,
            longName: pr.longName || pr.shortName || null,
        };
    } catch {
        return null;
    }
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    try {
        const isVercelCron = req.headers['x-vercel-cron'] === '1'
            || req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;

        // ── GET: return cached data from Neon DB ──
        if (req.method === 'GET' && !isVercelCron) {
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
                return res.status(200).json({
                    stocks: [],
                    totalStocks: 0,
                    lastUpdated: null,
                    error: `Database read failed: ${dbErr.message}`,
                });
            }
        }

        // ── POST / Cron: run scan ──
        if (req.method === 'POST' || isVercelCron) {
            console.log('[Screener] Triggering scan (direct HTTP, no crumb)...');
            const startTime = Date.now();

            await initScreenerTable();

            const allTickers = TICKER_LIST;
            if (allTickers.length === 0) {
                return res.status(500).json({
                    error: 'No tickers loaded from CSV',
                    details: 'vanguard.csv could not be read or is empty',
                });
            }

            console.log(`[Screener] ${allTickers.length} tickers to scan`);

            let totalProcessed = 0;
            let totalFailed = 0;
            let rateLimited = 0;

            // Process tickers in parallel batches
            const CONCURRENCY = 10;

            for (let i = 0; i < allTickers.length; i += CONCURRENCY) {
                const batch = allTickers.slice(i, i + CONCURRENCY);

                // Fetch chart + fundamentals in parallel for each ticker
                const results = await Promise.allSettled(
                    batch.map(async (ticker) => {
                        const chart = await fetchChart(ticker);
                        if (!chart) return null;

                        const fund = await fetchFundamentals(ticker);

                        return { ticker, chart, fund };
                    })
                );

                for (const r of results) {
                    if (r.status !== 'fulfilled' || !r.value) {
                        totalFailed++;
                        continue;
                    }

                    const { ticker, chart, fund } = r.value;

                    try {
                        const totalRevenue = fund?.totalRevenue ?? null;
                        const employees = fund?.fullTimeEmployees ?? null;

                        await upsertScreenerRow({
                            ticker,
                            price: chart.price,
                            market_cap: fund?.market_cap ?? null,
                            pe_ratio: fund?.pe_ratio ?? null,
                            roe_pct: fund?.roe != null ? fund.roe * 100 : null,
                            debt_to_equity: fund?.debtToEquity ?? null,
                            gross_margin_pct: fund?.grossMargins != null ? fund.grossMargins * 100 : null,
                            dividend_yield_pct: fund?.dividendYield != null ? fund.dividendYield * 100 : null,
                            roa_pct: fund?.roa != null ? fund.roa * 100 : null,
                            total_revenue: totalRevenue,
                            revenue_per_employee: totalRevenue && employees ? totalRevenue / employees : null,
                            sector: fund?.sector ?? null,
                            industry: fund?.industry ?? null,
                            company_name: fund?.longName || chart.name || ticker,
                            fifty_two_week_high: chart.fiftyTwoWeekHigh,
                            fifty_two_week_low: chart.fiftyTwoWeekLow,
                            beta: fund?.beta ?? null,
                        });
                        totalProcessed++;
                    } catch (dbErr: any) {
                        console.error(`[Screener] DB upsert ${ticker}: ${dbErr.message}`);
                        totalFailed++;
                    }
                }

                // Rate limit protection
                if (i + CONCURRENCY < allTickers.length) {
                    await sleep(200);
                }

                const done = Math.min(i + CONCURRENCY, allTickers.length);
                if (done % 100 === 0 || done >= allTickers.length) {
                    console.log(`[Screener] Progress: ${done}/${allTickers.length} (${totalProcessed} ok, ${totalFailed} fail)`);
                }
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[Screener] ✅ Done: ${totalProcessed} ok, ${totalFailed} failed in ${duration}s`);

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
        return res.status(500).json({
            error: 'Screener failed',
            details: error.message,
        });
    }
}

export const config = {
    api: {
        responseLimit: false,
        bodyParser: { sizeLimit: '1mb' },
    },
    maxDuration: 300,
};
