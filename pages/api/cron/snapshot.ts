/**
 * Cron: Twice-daily snapshot (9:35 ET = OPEN, 2:00 ET = MID).
 * Saves OHLCV + VWAP + RVOL for holdings + buy candidates. Kept 5 days.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runTwiceDailySnapshot } from '../../../lib/snapshot-service';
import { isMarketOpen } from '../../../lib/trading-engine';

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    const auth = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}` ||
        req.query.key === process.env.CRON_SECRET;
    if (process.env.CRON_SECRET && !auth) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type } = req.query; // OPEN | MID
    if (type !== 'OPEN' && type !== 'MID') {
        return res.status(400).json({ error: 'Use type=OPEN or type=MID' });
    }

    // OPEN = 9:35 ET, MID = 2:00 ET — only run during market hours (strict: no PM/AH)
    if (!isMarketOpen()) {
        return res.status(200).json({
            status: 'Market closed',
            skipped: true,
            message: 'Twice-daily snapshot runs only during regular market hours (9:30–4:00 ET).',
        });
    }

    try {
        const { ok, fail } = await runTwiceDailySnapshot(type as 'OPEN' | 'MID');
        res.status(200).json({
            status: 'Success',
            type,
            ok,
            fail,
            message: `${ok} snapshots saved, ${fail} failed`,
        });
    } catch (e: any) {
        console.error('[Cron Snapshot]', e);
        res.status(500).json({ error: e.message });
    }
}
