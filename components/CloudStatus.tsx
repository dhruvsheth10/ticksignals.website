import { useEffect, useState } from 'react';

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
                const res = await fetch('/api/status/cloud');
                const data = await res.json();
                setStatus(data);
                setError(null);
            } catch (err: any) {
                setError(err.message || 'Failed to load cloud status');
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, 60_000); // refresh every minute
        return () => clearInterval(interval);
    }, []);

    const indicatorColor = status?.ok ? 'bg-emerald-500' : 'bg-amber-500';
    const textColor = status?.ok ? 'text-emerald-600' : 'text-amber-600';

    return (
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs shadow-sm">
            <span className={`h-2 w-2 rounded-full ${indicatorColor} animate-pulse`} />
            <span className={`font-medium ${textColor}`}>
                {error
                    ? 'Cloud status: unknown'
                    : status?.ok
                    ? 'Cloud trading: Active'
                    : 'Cloud trading: Idle'}
            </span>
            {status?.lastAnalysisMinutesAgo != null && (
                <span className="text-slate-500">
                    · Last analysis {status.lastAnalysisMinutesAgo.toFixed(1)} min ago
                </span>
            )}
        </div>
    );
}

