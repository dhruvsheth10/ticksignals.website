import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { getPool } from '../../../lib/db';

// Same admin password hash as screener admin (sha256 of plain password)
// Keep this in sync with SCAN_PASSWORD_HASH in pages/api/screener.ts
const ADMIN_PASSWORD_HASH = 'ea4de091b760a4e538140c342585130649e646c54d4939ae7f142bb81d5506fa';

type TradeLogResponse = {
    ok: boolean;
    error?: string;
    trades?: any[];
    analysis?: any[];
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

        const db = getPool();

        const max = Math.min(Number(limit) || 50, 200);

        // Last trades
        const tradesResult = await db.query(
            `
            SELECT date, ticker, type, shares, price, total_amount, notes
            FROM portfolio_transactions
            ORDER BY date DESC
            LIMIT $1
            `,
            [max]
        );

        // Recent analysis logs from Oracle analyzer
        let analysis: any[] = [];
        try {
            const analysisResult = await db.query(
                `
                SELECT ticker,
                       action,
                       confidence,
                       reason,
                       sentiment_score,
                       sentiment_confidence,
                       rsi,
                       macd_histogram,
                       volume_ratio,
                       price_change_pct,
                       sma50,
                       sma200,
                       analyzed_at
                FROM trading_analysis_results
                ORDER BY analyzed_at DESC
                LIMIT $1
                `,
                [max]
            );
            analysis = analysisResult.rows;
        } catch (err: any) {
            // If table doesn't exist yet, just skip analysis logs
            console.warn('[AdminLogs] trading_analysis_results not available:', err.message);
        }

        return res.status(200).json({
            ok: true,
            trades: tradesResult.rows,
            analysis,
        });
    } catch (error: any) {
        console.error('[AdminLogs] Error:', error.message);
        return res.status(500).json({ ok: false, error: 'Failed to load logs' });
    }
}

