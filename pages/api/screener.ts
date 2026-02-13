import type { NextApiRequest, NextApiResponse } from 'next';
import YahooFinance from 'yahoo-finance2';
import { initScreenerTable, upsertScreenerRow, getScreenerData, getScanMetadata } from '../../lib/db';
import { TICKER_LIST } from '../../lib/tickers';

const yahooFinance = new YahooFinance();

// Helper: safe number extraction
function safeNum(val: any): number | null {
    if (val === undefined || val === null || isNaN(val)) return null;
    return typeof val === 'number' ? val : parseFloat(val);
}

// Fetch fundamentals for a single ticker
async function fetchTickerData(ticker: string): Promise<any> {
    try {
        const [quote, summary] = await Promise.all([
            yahooFinance.quote(ticker).catch(() => null),
            yahooFinance.quoteSummary(ticker, {
                modules: ['financialData', 'summaryDetail', 'assetProfile', 'defaultKeyStatistics'],
            }).catch(() => null),
        ]);

        if (!quote) return null;

        const fin = summary?.financialData || ({} as any);
        const det = summary?.summaryDetail || ({} as any);
        const prof = summary?.assetProfile || ({} as any);

        const totalRevenue = safeNum(fin.totalRevenue);
        const employees = safeNum(prof.fullTimeEmployees);
        const revenuePerEmployee = (totalRevenue && employees && employees > 0)
            ? totalRevenue / employees
            : null;

        return {
            ticker,
            price: safeNum(quote.regularMarketPrice),
            market_cap: safeNum(quote.marketCap),
            pe_ratio: safeNum(quote.trailingPE) ?? safeNum(det.trailingPE),
            roe_pct: fin.returnOnEquity != null ? (safeNum(fin.returnOnEquity) ?? 0) * 100 : null,
            debt_to_equity: safeNum(fin.debtToEquity),
            gross_margin_pct: fin.grossMargins != null ? (safeNum(fin.grossMargins) ?? 0) * 100 : null,
            dividend_yield_pct: det.dividendYield != null ? (safeNum(det.dividendYield) ?? 0) * 100 : null,
            roa_pct: fin.returnOnAssets != null ? (safeNum(fin.returnOnAssets) ?? 0) * 100 : null,
            total_revenue: totalRevenue,
            revenue_per_employee: revenuePerEmployee,
            sector: prof.sector || null,
            industry: prof.industry || null,
            company_name: quote.shortName || quote.longName || ticker,
            fifty_two_week_high: safeNum(quote.fiftyTwoWeekHigh),
            fifty_two_week_low: safeNum(quote.fiftyTwoWeekLow),
            beta: safeNum(det.beta),
        };
    } catch (err) {
        console.error(`Error fetching ${ticker}:`, err);
        return null;
    }
}

// Process tickers in batches
async function processBatch(tickers: string[], batchSize: number = 5): Promise<number> {
    let processed = 0;

    for (let i = 0; i < tickers.length; i += batchSize) {
        const batch = tickers.slice(i, i + batchSize);
        const results = await Promise.allSettled(
            batch.map(ticker => fetchTickerData(ticker))
        );

        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                try {
                    await upsertScreenerRow(result.value);
                    processed++;
                } catch (dbErr) {
                    console.error('DB upsert error:', dbErr);
                }
            }
        }

        // Small delay between batches to be gentle on Yahoo Finance
        if (i + batchSize < tickers.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    return processed;
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    try {
        await initScreenerTable();

        // Detect Vercel Cron (sends GET with special header)
        const isVercelCron = req.headers['x-vercel-cron'] === '1'
            || req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;

        if (req.method === 'GET' && !isVercelCron) {
            // Normal GET: return cached screener data + metadata
            const [data, meta] = await Promise.all([
                getScreenerData(),
                getScanMetadata(),
            ]);

            return res.status(200).json({
                stocks: data,
                totalStocks: meta.count,
                lastUpdated: meta.lastUpdated,
            });
        }

        // POST (manual trigger) or GET from Vercel Cron → run scan
        if (req.method === 'POST' || isVercelCron) {
            const { subset } = req.body || {};

            // For POST requests (manual), check auth if CRON_SECRET is set
            if (req.method === 'POST' && process.env.CRON_SECRET) {
                const { secret } = req.body || {};
                const authHeader = req.headers.authorization;
                const isAuthorized = secret === process.env.CRON_SECRET
                    || authHeader === `Bearer ${process.env.CRON_SECRET}`;
                // In dev (no CRON_SECRET), allow all. In prod, we still allow
                // manual runs from the UI (no secret needed for user-facing button)
            }

            // Allow processing a subset of tickers (for testing)
            const tickersToProcess = subset
                ? TICKER_LIST.slice(0, parseInt(subset))
                : TICKER_LIST;

            const startTime = Date.now();
            const processed = await processBatch(tickersToProcess, 5);
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            return res.status(200).json({
                success: true,
                processed,
                total: tickersToProcess.length,
                durationSeconds: duration,
                message: `Screener scan complete: ${processed}/${tickersToProcess.length} tickers processed in ${duration}s`,
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

// Allow long-running scans (up to 5 min on Vercel Pro, 60s on Hobby)
export const config = {
    api: {
        responseLimit: false,
        bodyParser: {
            sizeLimit: '1mb',
        },
    },
    maxDuration: 300,
};
