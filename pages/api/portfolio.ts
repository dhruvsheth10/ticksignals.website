
import type { NextApiRequest, NextApiResponse } from 'next';
import { getPortfolioStatus, getHoldings, getTransactions, getHistory, initPortfolioTables } from '../../lib/portfolio-db';
import { getScreenerData } from '../../lib/db';

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    try {
        await initPortfolioTables();

        const [status, holdings, transactionsRaw, history, screenerData] = await Promise.all([
            getPortfolioStatus(),
            getHoldings(),
            getTransactions(50),
            getHistory(30),
            getScreenerData()
        ]);

        const companyMap = new Map(screenerData.map(d => [d.ticker, d.company_name]));

        const transactions = transactionsRaw.map(tx => ({
            ...tx,
            company_name: companyMap.get(tx.ticker) || null
        }));

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
