import type { NextApiRequest, NextApiResponse } from 'next';
import { getLastAnalysisAt } from '../../../lib/portfolio-db';

type CloudStatusResponse = {
    ok: boolean;
    message: string;
    lastAnalysisAt: string | null;
    lastAnalysisMinutesAgo: number | null;
};

// Hard cap the DB lookup at 8s so we always respond before the client's 15s
// fetch timeout — the badge will show "unknown" rather than hang the page.
const DB_TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`db timeout after ${ms}ms`)), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}

export default async function handler(
    _req: NextApiRequest,
    res: NextApiResponse<CloudStatusResponse>
) {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const lastAt = await withTimeout(getLastAnalysisAt(), DB_TIMEOUT_MS);

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

