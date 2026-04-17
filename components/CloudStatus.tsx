import { useEffect, useState } from 'react';
import { fetchJsonWithTimeout } from '../lib/fetchWithTimeout';

type CloudStatus = {
    ok: boolean;
    message: string;
    lastAnalysisAt: string | null;
    lastAnalysisMinutesAgo: number | null;
};

export default function CloudStatus() {
    const [status, setStatus] = useState<CloudStatus | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const { data } = await fetchJsonWithTimeout<CloudStatus>(
                    '/api/status/cloud',
                    { timeoutMs: 20_000, retries: 1 }
                );
                setStatus(data);
                setError(null);
            } catch (err: unknown) {
                setError(err instanceof Error ? err.message : 'Failed to load cloud status');
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, 60_000);
        return () => clearInterval(interval);
    }, []);

    const indicatorColor = status?.ok ? 'bg-emerald-500' : 'bg-amber-500';
    const textColor = status?.ok ? 'text-emerald-400' : 'text-amber-400';

    return (
        <div className="inline-flex items-center gap-2 rounded-full border border-gray-700 bg-gray-800/80 backdrop-blur-sm px-3 py-1 text-xs shadow-sm">
            <span className={`h-2 w-2 rounded-full ${indicatorColor} animate-pulse`} />
            <span className={`font-medium ${textColor}`}>
                {error
                    ? 'Cloud status: unknown'
                    : status?.ok
                        ? 'Cloud trading: Active'
                        : 'Cloud trading: Paused'}
            </span>
            {status?.lastAnalysisMinutesAgo != null && (
                <span className="text-gray-400">
                    · Last analysis {status.lastAnalysisMinutesAgo.toFixed(0)} min ago
                </span>
            )}
        </div>
    );
}

