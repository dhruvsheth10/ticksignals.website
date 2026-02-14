import type { NextApiRequest, NextApiResponse } from 'next';
import { TICKER_LIST } from '../../lib/tickers';
import { initScreenerTable, upsertScreenerRow, getScreenerData, getScanMetadata } from '../../lib/db';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
            console.log('[Screener] Triggering scan...');
            const startTime = Date.now();

            const YahooFinance = (await import('yahoo-finance2')).default;
            const yf = new YahooFinance();

            await initScreenerTable();

            const allTickers = TICKER_LIST;
            if (allTickers.length === 0) {
                return res.status(500).json({
                    error: 'No tickers loaded from CSV',
                    details: 'The vanguard.csv file could not be read or is empty',
                });
            }

            console.log(`[Screener] ${allTickers.length} tickers to scan`);

            let totalProcessed = 0;
            let totalFailed = 0;

            // ── Phase 1: Batch quote() for price, mcap, P/E, 52wk, divYield ──
            // quote() accepts string[] → one API call per batch of ~50 symbols
            const QUOTE_BATCH = 50;
            const quoteMap: Record<string, any> = {};

            for (let i = 0; i < allTickers.length; i += QUOTE_BATCH) {
                const batch = allTickers.slice(i, i + QUOTE_BATCH);
                try {
                    const quotes: any[] = await yf.quote(batch, {}, { validateResult: false });
                    if (Array.isArray(quotes)) {
                        for (const q of quotes) {
                            if (q && q.symbol) {
                                quoteMap[q.symbol] = q;
                            }
                        }
                    }
                    console.log(`[Screener] Batch quote ${i}–${i + batch.length}: ${Object.keys(quoteMap).length - i > 0 ? 'ok' : 'partial'}`);
                } catch (err: any) {
                    console.warn(`[Screener] Batch quote ${i}–${i + batch.length} failed: ${err.message}`);
                }
                if (i + QUOTE_BATCH < allTickers.length) {
                    await sleep(300);
                }
            }

            console.log(`[Screener] Phase 1 done: ${Object.keys(quoteMap).length} quotes`);

            // ── Phase 2: quoteSummary() for fundamentals (ROE, ROA, margins, sector) ──
            // These are individual calls, so we throttle carefully
            const tickersWithQuotes = Object.keys(quoteMap);
            const FUND_CONCURRENCY = 5;
            const fundMap: Record<string, any> = {};

            for (let i = 0; i < tickersWithQuotes.length; i += FUND_CONCURRENCY) {
                const batch = tickersWithQuotes.slice(i, i + FUND_CONCURRENCY);
                const results = await Promise.allSettled(
                    batch.map(async (ticker) => {
                        try {
                            const summary = await yf.quoteSummary(ticker, {
                                modules: ['financialData', 'summaryDetail', 'assetProfile'],
                            });
                            return { ticker, data: summary };
                        } catch {
                            return { ticker, data: null };
                        }
                    })
                );
                for (const r of results) {
                    if (r.status === 'fulfilled' && r.value.data) {
                        fundMap[r.value.ticker] = r.value.data;
                    }
                }
                if (i + FUND_CONCURRENCY < tickersWithQuotes.length) {
                    await sleep(400);
                }
                // Progress log every 50
                const done = Math.min(i + FUND_CONCURRENCY, tickersWithQuotes.length);
                if (done % 50 === 0 || done >= tickersWithQuotes.length) {
                    console.log(`[Screener] Fundamentals: ${done}/${tickersWithQuotes.length}`);
                }
            }

            console.log(`[Screener] Phase 2 done: ${Object.keys(fundMap).length} fundamentals`);

            // ── Phase 3: Upsert into DB ──
            for (const ticker of tickersWithQuotes) {
                const q = quoteMap[ticker];
                const f = fundMap[ticker] || {};
                const fin = f.financialData || {};
                const det = f.summaryDetail || {};
                const prof = f.assetProfile || {};

                const totalRevenue = fin.totalRevenue ?? null;
                const employees = prof.fullTimeEmployees ?? null;

                try {
                    await upsertScreenerRow({
                        ticker,
                        price: q.regularMarketPrice ?? null,
                        market_cap: q.marketCap ?? null,
                        pe_ratio: q.trailingPE ?? null,
                        roe_pct: fin.returnOnEquity != null ? fin.returnOnEquity * 100 : null,
                        debt_to_equity: fin.debtToEquity ?? null,
                        gross_margin_pct: fin.grossMargins != null ? fin.grossMargins * 100 : null,
                        dividend_yield_pct: det.dividendYield != null
                            ? det.dividendYield * 100
                            : q.dividendYield != null
                                ? q.dividendYield * 100
                                : null,
                        roa_pct: fin.returnOnAssets != null ? fin.returnOnAssets * 100 : null,
                        total_revenue: totalRevenue,
                        revenue_per_employee: totalRevenue && employees ? totalRevenue / employees : null,
                        sector: prof.sector ?? null,
                        industry: prof.industry ?? null,
                        company_name: q.longName || q.shortName || ticker,
                        fifty_two_week_high: q.fiftyTwoWeekHigh ?? null,
                        fifty_two_week_low: q.fiftyTwoWeekLow ?? null,
                        beta: det.beta ?? null,
                    });
                    totalProcessed++;
                } catch (dbErr: any) {
                    console.error(`[Screener] DB upsert ${ticker}: ${dbErr.message}`);
                    totalFailed++;
                }
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[Screener] ✅ Scan complete: ${totalProcessed} ok, ${totalFailed} failed in ${duration}s`);

            return res.status(200).json({
                success: true,
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
