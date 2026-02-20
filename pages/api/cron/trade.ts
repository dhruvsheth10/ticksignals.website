/**
 * Cron Trade API
 * Query: type = OPEN | MID | CLOSE | PORTFOLIO_CHECK
 * - OPEN / MID / CLOSE: full cycle (sync, sell logic, buy scan). Use MID hourly during market hours only (e.g. 6:30–12:30 PST = 9:30 AM–4 PM ET).
 * - PORTFOLIO_CHECK: sync + stop/take-profit + sell signals only (no new buys). Run every 15 min when you have holdings.
 * Auth: Bearer CRON_SECRET or query key=CRON_SECRET.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runTradingCycle, isMarketOpen } from '../../../lib/trading-engine';
import { initPortfolioTables } from '../../../lib/portfolio-db';

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    // 1. Security Check (Vercel Cron Secret)
    // Vercel automatically sends this header.
    const authHeader = req.headers['authorization'];
    if (
        process.env.CRON_SECRET &&
        authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        // Allow manual testing with a specific query param if needed, or just rely on Vercel
        req.query.key !== process.env.CRON_SECRET
    ) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type } = req.query; // OPEN, MID, CLOSE, PORTFOLIO_CHECK

    try {
        await initPortfolioTables();

        if (!isMarketOpen() && type !== 'OPEN') {
            console.log('Market Closed. Skipping trade cycle.');
            return res.status(200).json({ status: 'Market Closed', skipped: true });
        }

        if (type === 'OPEN' || type === 'MID' || type === 'CLOSE' || type === 'PORTFOLIO_CHECK') {
            await runTradingCycle(type as 'OPEN' | 'MID' | 'CLOSE' | 'PORTFOLIO_CHECK');
            res.status(200).json({ status: 'Success', type });
        } else {
            res.status(400).json({ error: 'Invalid type. Use OPEN, MID, CLOSE, or PORTFOLIO_CHECK.' });
        }
    } catch (error: any) {
        console.error('Cron Job Failed:', error);
        res.status(500).json({ error: error.message });
    }
}
