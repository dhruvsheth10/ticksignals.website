import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';

type CloudStatusResponse = {
    ok: boolean;
    message: string;
    lastAnalysisAt: string | null;
    lastAnalysisMinutesAgo: number | null;
};

export default async function handler(
    _req: NextApiRequest,
    res: NextApiResponse<CloudStatusResponse>
) {
    try {
        const db = getPool();

        // Check latest analysis from Oracle service (if table exists)
        const result = await db.query(`
            SELECT MAX(analyzed_at) AS last_at
            FROM trading_analysis_results
        `);

        const lastAt: Date | null = result.rows[0]?.last_at || null;

        if (!lastAt) {
            return res.status(200).json({
                ok: false,
                message: 'No analysis data found yet',
                lastAnalysisAt: null,
                lastAnalysisMinutesAgo: null,
            });
        }

        const now = new Date();
        const diffMs = now.getTime() - new Date(lastAt).getTime();
        const diffMinutes = diffMs / (1000 * 60);

        const isRecent = diffMinutes <= 90; // within last 90 minutes

        return res.status(200).json({
            ok: isRecent,
            message: isRecent
                ? 'Cloud analysis active'
                : 'Cloud analysis stale (last run over 90 minutes ago)',
            lastAnalysisAt: new Date(lastAt).toISOString(),
            lastAnalysisMinutesAgo: Number(diffMinutes.toFixed(1)),
        });
    } catch (error: any) {
        console.error('[CloudStatus] Error:', error.message);
        return res.status(200).json({
            ok: false,
            message: 'Failed to connect to database',
            lastAnalysisAt: null,
            lastAnalysisMinutesAgo: null,
        });
    }
}

