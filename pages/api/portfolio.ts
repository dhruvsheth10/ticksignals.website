
import type { NextApiRequest, NextApiResponse } from 'next';
import { getPortfolioStatus, getHoldings, getTransactions, getHistory, initPortfolioTables } from '../../lib/portfolio-db';

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    try {
        // Lazy init - ensure tables exist on first load if not already
        // Ideally this runs once at build/deploy, but safe to check here
        await initPortfolioTables();

        // Parallel fetch for speed
        const [status, holdings, transactions, history] = await Promise.all([
            getPortfolioStatus(),
            getHoldings(),
            getTransactions(50),
            getHistory(30)
        ]);

        res.status(200).json({
            status,
            holdings,
            transactions,
            history
        });
    } catch (error: any) {
        console.error('Portfolio API Error:', error);
        res.status(500).json({ error: 'Failed to fetch portfolio data' });
    }
}
