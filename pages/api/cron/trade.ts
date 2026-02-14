
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

    const { type } = req.query; // OPEN, MID, CLOSE

    try {
        // 0. Ensure Tables Exist (One-time lazy init)
        await initPortfolioTables();

        // 2. Check Market Status
        if (!isMarketOpen() && type !== 'OPEN') { // Allow OPEN to run pre-market setup if needed
            // Optional: Log 'Market Closed' but don't error
            console.log('Market Closed. Skipping trade cycle.');
            return res.status(200).json({ status: 'Market Closed', skipped: true });
        }

        // 3. Run Trading Cycle
        // We use setImmediate or just await if it's fast enough. 
        // Vercel functions have 10s timeout (Free) / 60s (Pro).
        // Our optimized engine should be fast.
        if (type === 'OPEN' || type === 'MID' || type === 'CLOSE') {
            await runTradingCycle(type);
            res.status(200).json({ status: 'Success', type });
        } else {
            res.status(400).json({ error: 'Invalid type. Use OPEN, MID, or CLOSE.' });
        }
    } catch (error: any) {
        console.error('Cron Job Failed:', error);
        res.status(500).json({ error: error.message });
    }
}
