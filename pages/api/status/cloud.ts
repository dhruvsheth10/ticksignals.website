import type { NextApiRequest, NextApiResponse } from 'next';
import { getLastAnalysisAt } from '../../../lib/portfolio-db';

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
        const lastAt = await getLastAnalysisAt();

        if (!lastAt) {
            return res.status(200).json({
                ok: false,
                message: 'No runs yet',
                lastAnalysisAt: null,
                lastAnalysisMinutesAgo: null,
            });
        }

        const now = new Date();
        const lastDate = typeof lastAt === 'string' ? new Date(lastAt) : lastAt;
        const diffMs = now.getTime() - lastDate.getTime();
        const diffMinutes = diffMs / (1000 * 60);

        const isRecent = diffMinutes <= 90;

        return res.status(200).json({
            ok: isRecent,
            message: isRecent
                ? 'Cloud trading active'
                : 'Cloud trading idle (last run over 90 minutes ago)',
            lastAnalysisAt: lastDate.toISOString(),
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

