/**
 * Cron: EOD cleanup (run after 4:05 PM ET).
 * - Delete daily_snapshots older than 5 days
 * - Delete intraday_holdings for tickers sold today
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { cleanupOldDailySnapshots, cleanupIntradayForSoldToday, cleanupOldLogs } from '../../../lib/portfolio-db';

/**
 * Check if we're past 4 PM ET (21:00 UTC) — safe to run cleanup
 */
function isPastMarketClose(): boolean {
    const d = new Date();
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const time = h + m / 60;
    return time >= 21; // 4 PM ET = 21:00 UTC (EST) or 20:00 UTC (EDT) — we use 21 for safety
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    const auth = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}` ||
        req.query.key === process.env.CRON_SECRET;
    if (process.env.CRON_SECRET && !auth) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // if (!isPastMarketClose()) {
    //     return res.status(200).json({
    //         status: 'Skipped',
    //         message: 'EOD cleanup runs after 4:05 PM ET (market close).',
    //     });
    // }

    try {
        const [snapshotsDeleted, intradayDeleted, logsDeleted] = await Promise.all([
            cleanupOldDailySnapshots(),
            cleanupIntradayForSoldToday(),
            cleanupOldLogs()
        ]);
        res.status(200).json({
            status: 'Success',
            snapshotsDeleted,
            intradayDeleted,
            logsDeleted,
            message: `Removed ${snapshotsDeleted} old snapshots, ${intradayDeleted} intraday bars for sold tickers, ${logsDeleted.analysis} old analysis logs, ${logsDeleted.cycles} cycle logs`,
        });
    } catch (e: any) {
        console.error('[Cron Cleanup]', e);
        res.status(500).json({ error: e.message });
    }
}
