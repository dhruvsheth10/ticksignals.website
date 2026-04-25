import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { getTransactions, getCycleLogs, getAnalysisResults, getHistory } from '../../../lib/portfolio-db';

// Same admin password hash as screener admin (sha256 of plain password)
// Keep this in sync with SCAN_PASSWORD_HASH in pages/api/screener.ts
const ADMIN_PASSWORD_HASH = 'ea4de091b760a4e538140c342585130649e646c54d4939ae7f142bb81d5506fa';

type DailyPnL = {
    date: string;
    total_value: number;
    change_dollar: number;
    change_pct: number;
};

type TradeLogResponse = {
    ok: boolean;
    error?: string;
    trades?: any[];
    analysis?: any[];
    cycleLogs?: { cycle_type: string; ran_at: string; summary: string }[];
    dailyPnL?: DailyPnL[];
};

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<TradeLogResponse>
) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    try {
        const { limit = 50 } = req.body || req.query || {};

        const max = Math.min(Number(limit) || 50, 200);

        const [trades, analysis, cycleLogs, history] = await Promise.all([
            getTransactions(max),
            getAnalysisResults(max).catch(() => []),
            getCycleLogs(max),
            getHistory(30),
        ]);

        // Normalize trades for response (date, ticker, type, shares, price, total_amount, notes)
        const tradesFormatted = trades.map(t => ({
            date: t.date,
            ticker: t.ticker,
            type: t.type,
            shares: t.shares,
            price: t.price,
            total_amount: t.total_amount,
            notes: t.notes,
        }));

        // Calculate daily P&L from history (day-over-day changes)
        const dailyPnL: DailyPnL[] = [];
        const sortedHistory = [...history].sort((a, b) => a.date.localeCompare(b.date));
        for (let i = 0; i < sortedHistory.length; i++) {
            const day = sortedHistory[i];
            const prev = i > 0 ? sortedHistory[i - 1] : null;
            const changeDollar = prev ? day.total_value - prev.total_value : 0;
            const changePct = prev && prev.total_value > 0
                ? ((day.total_value - prev.total_value) / prev.total_value) * 100
                : 0;
            dailyPnL.push({
                date: day.date,
                total_value: day.total_value,
                change_dollar: changeDollar,
                change_pct: changePct,
            });
        }

        return res.status(200).json({
            ok: true,
            trades: tradesFormatted,
            analysis,
            cycleLogs,
            dailyPnL: dailyPnL.reverse(), // most recent first
        });
    } catch (error: any) {
        console.error('[AdminLogs] Error:', error.message);
        return res.status(500).json({ ok: false, error: 'Failed to load logs' });
    }
}
