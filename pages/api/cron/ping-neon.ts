/**
 * Keep Neon Postgres warm between the two Vercel crons (trade OPEN/CLOSE).
 * Vercel Hobby allows only 2 scheduled crons — use this URL from cron-job.org (or similar)
 * every 10–15 minutes:
 *
 *   GET https://www.dhruvs.app/api/cron/ping-neon?key=YOUR_CRON_SECRET
 *
 * Same auth as /api/cron/trade (Authorization: Bearer CRON_SECRET or ?key=).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { warmNeon } from '../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authHeader = req.headers.authorization;
    if (
        process.env.CRON_SECRET &&
        authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        req.query.key !== process.env.CRON_SECRET
    ) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await warmNeon();
        return res.status(200).json({ ok: true, at: new Date().toISOString() });
    } catch (e: any) {
        console.error('[ping-neon]', e);
        return res.status(503).json({ ok: false, error: e?.message || 'warmNeon failed' });
    }
}
