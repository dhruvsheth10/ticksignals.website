
import type { NextApiRequest, NextApiResponse } from 'next';
import { getPortfolioStatus, getHoldings, getTransactions, getHistory, getDetailedHistory, initPortfolioTables, getDayOpenPrices } from '../../lib/portfolio-db';
import { getScreenerData } from '../../lib/db';

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    try {
        await initPortfolioTables();

        const [status, holdings, transactionsRaw, history, screenerData, detail1D, detail1W, detail30D, dayOpens] = await Promise.all([
            getPortfolioStatus(),
            getHoldings(),
            getTransactions(50),
            getHistory(30),
            getScreenerData(),
            getDetailedHistory('1D'),
            getDetailedHistory('1W'),
            getDetailedHistory('30D'),
            getDayOpenPrices(),
        ]);

        const companyMap = new Map(screenerData.map(d => [d.ticker, d.company_name]));

        const transactions = transactionsRaw.map(tx => ({
            ...tx,
            company_name: companyMap.get(tx.ticker) || null
        }));

        // Enrich holdings with day change % and total return $
        const enrichedHoldings = holdings.map(h => {
            const openPrice = dayOpens.get(h.ticker);
            const day_change_pct = openPrice && openPrice > 0
                ? ((h.current_price - openPrice) / openPrice) * 100
                : null;
            const total_return_dollar = (h.current_price - h.avg_cost) * h.shares;
            return { ...h, day_change_pct, total_return_dollar };
        });

        res.status(200).json({
            status,
            holdings: enrichedHoldings,
            transactions,
            history,
            detailedHistory: {
                '1D': detail1D,
                '1W': detail1W,
                '30D': detail30D,
            },
        });
    } catch (error: any) {
        console.error('Portfolio API Error:', error);
        res.status(500).json({ error: 'Failed to fetch portfolio data' });
    }
}
