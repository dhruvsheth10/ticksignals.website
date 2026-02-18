/**
 * Cron: 10-min holdings ping.
 * Saves intraday bars for current holdings only. Kept until EOD (even if sold today).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runHoldings10MinPing } from '../../../lib/snapshot-service';
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

    if (!isMarketOpen()) {
        return res.status(200).json({
            status: 'Market closed',
            skipped: true,
            message: '10-min ping runs only during regular market hours (9:30–4:00 ET).',
        });
    }

    try {
        const { ok, fail } = await runHoldings10MinPing();
        res.status(200).json({
            status: 'Success',
            ok,
            fail,
            message: `${ok} bars saved, ${fail} failed`,
        });
    } catch (e: any) {
        console.error('[Cron Holdings Ping]', e);
        res.status(500).json({ error: e.message });
    }
}
