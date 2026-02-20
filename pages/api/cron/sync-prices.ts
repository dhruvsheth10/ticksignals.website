import type { NextApiRequest, NextApiResponse } from 'next';
import { syncPortfolioPrices, isMarketOpen } from '../../../lib/trading-engine';
import { initPortfolioTables } from '../../../lib/portfolio-db';

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    // 1. Security Check (Vercel Cron Secret)
    const authHeader = req.headers['authorization'];
    if (
        process.env.CRON_SECRET &&
        authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        req.query.key !== process.env.CRON_SECRET
    ) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await initPortfolioTables();

        if (!isMarketOpen()) {
            console.log('Market Closed. Skipping price sync.');
            return res.status(200).json({ status: 'Market Closed', skipped: true });
        }

        await syncPortfolioPrices();
        res.status(200).json({ status: 'Success', type: 'PRICE_SYNC' });
    } catch (error: any) {
        console.error('Price Sync Failed:', error);
        res.status(500).json({ error: error.message });
    }
}
