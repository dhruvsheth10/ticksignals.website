import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { getTransactions, getCycleLogs, getAnalysisResults } from '../../../lib/portfolio-db';

// Same admin password hash as screener admin (sha256 of plain password)
// Keep this in sync with SCAN_PASSWORD_HASH in pages/api/screener.ts
const ADMIN_PASSWORD_HASH = 'ea4de091b760a4e538140c342585130649e646c54d4939ae7f142bb81d5506fa';

type TradeLogResponse = {
    ok: boolean;
    error?: string;
    trades?: any[];
    analysis?: any[];
    cycleLogs?: { cycle_type: string; ran_at: string; summary: string }[];
};

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<TradeLogResponse>
) {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    try {
        const { password, limit = 50 } = req.body || {};

        if (!password) {
            return res.status(401).json({ ok: false, error: 'Password required' });
        }

        const hash = crypto.createHash('sha256').update(password).digest('hex');
        if (hash !== ADMIN_PASSWORD_HASH) {
            return res.status(401).json({ ok: false, error: 'Invalid password' });
        }

        const max = Math.min(Number(limit) || 50, 200);

        const [trades, analysis, cycleLogs] = await Promise.all([
            getTransactions(max),
            getAnalysisResults(max).catch(() => []),
            getCycleLogs(max),
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

        return res.status(200).json({
            ok: true,
            trades: tradesFormatted,
            analysis,
            cycleLogs,
        });
    } catch (error: any) {
        console.error('[AdminLogs] Error:', error.message);
        return res.status(500).json({ ok: false, error: 'Failed to load logs' });
    }
}

