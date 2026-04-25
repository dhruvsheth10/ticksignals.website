import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Link from 'next/link';
import type { MouseHandlerDataParam } from 'recharts';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, ReferenceArea } from 'recharts';
import { ArrowUpRight, ArrowDownRight, RefreshCw, DollarSign, PieChart, Activity, FileText, TrendingUp, TrendingDown } from 'lucide-react';
import BlurText from './BlurText';
import AnimatedNumber from './AnimatedNumber';
import { fetchJsonWithTimeout } from '../lib/fetchWithTimeout';

interface PortfolioData {
    status: {
        cash_balance: number;
        total_equity: number;
        total_value: number;
        last_updated: string;
    };
    holdings: {
        ticker: string;
        shares: number;
        avg_cost: number;
        current_price: number;
        market_value: number;
        return_pct: number;
        day_change_pct: number | null;
        total_return_dollar: number;
    }[];
    transactions: {
        date: string;
        ticker: string;
        type: 'BUY' | 'SELL';
        shares: number;
        price: number;
        total_amount: number;
        company_name?: string | null;
        notes?: string;
    }[];
    history: {
        date: string;
        total_value: number;
    }[];
    detailedHistory?: {
        '1D': { timestamp: string; total_value: number }[];
        '1W': { timestamp: string; total_value: number }[];
        '30D': { timestamp: string; total_value: number }[];
        'MAX': { timestamp: string; total_value: number }[];
    };
}

interface LivePortfolioProps {
    initialTimeframe?: '1D' | '1W' | '30D' | 'MAX';
}

type ReturnMode = 'total_pct' | 'day_pct' | 'total_dollar';
const RETURN_LABELS: Record<ReturnMode, string> = {
    total_pct: 'Total Return %',
    day_pct: "Today's Return %",
    total_dollar: 'Total Return ($)',
};
const RETURN_CYCLE: ReturnMode[] = ['total_pct', 'day_pct', 'total_dollar'];

const parseDate = (d: string) => new Date(d.endsWith('Z') ? d : (d.includes('T') ? d + 'Z' : d.replace(' ', 'T') + 'Z'));

type PortfolioChartRow = { date: string; total_value: number };

/** Horizontal span of the plot (screen px) from Recharts SVG grid lines, or a safe fallback. */
function getRechartsPlotXBounds(wrapper: HTMLElement): { left: number; width: number } | null {
    const svg = wrapper.querySelector('.recharts-surface') as SVGSVGElement | null;
    if (!svg) return null;
    const verticals = svg.querySelectorAll('.recharts-cartesian-grid-vertical line');
    if (verticals.length >= 2) {
        const r0 = (verticals[0] as SVGGraphicsElement).getBoundingClientRect();
        const r1 = (verticals[verticals.length - 1] as SVGGraphicsElement).getBoundingClientRect();
        const left = Math.min(r0.left, r1.left);
        const right = Math.max(r0.right, r1.right);
        return { left, width: Math.max(1, right - left) };
    }
    const rect = svg.getBoundingClientRect();
    const axisReserve = 58;
    const pad = 6;
    const left = rect.left + axisReserve + pad;
    const width = Math.max(1, rect.width - axisReserve - pad * 2);
    return { left, width };
}

function interpolatePortfolioAtClientX(
    clientX: number,
    bounds: { left: number; width: number },
    rows: PortfolioChartRow[],
): { value: number; dateStr: string } | null {
    if (rows.length < 2) return null;
    const t = (clientX - bounds.left) / bounds.width;
    if (t < -0.02 || t > 1.02) return null;
    const clampedT = Math.max(0, Math.min(1, t));
    const f = clampedT * (rows.length - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(rows.length - 1, i0 + 1);
    const u = f - i0;
    const v0 = rows[i0].total_value;
    const v1 = rows[i1].total_value;
    const t0 = parseDate(rows[i0].date).getTime();
    const t1 = parseDate(rows[i1].date).getTime();
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
    const value = v0 + (v1 - v0) * u;
    const timeMs = t0 + (t1 - t0) * u;
    return { value, dateStr: new Date(timeMs).toISOString() };
}

function formatPortfolioTooltipLabel(dateStr: string, timeframe: '1D' | '1W' | '30D' | 'MAX'): string {
    const d = parseDate(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    if (timeframe === '1D') return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    if (timeframe === '1W') return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

type PortfolioTooltipContentProps = {
    active?: boolean;
    payload?: { value?: number; dataKey?: unknown }[];
    label?: string | number;
    fluid: { value: number; dateStr: string } | null;
    timeframe: '1D' | '1W' | '30D' | 'MAX';
    lineColor: string;
};

function PortfolioTooltipContent({ active, payload, label, fluid, timeframe, lineColor }: PortfolioTooltipContentProps) {
    if (!active || !payload?.length) return null;
    const val = fluid?.value ?? (payload[0]?.value as number);
    const rawLabel = fluid?.dateStr ?? label;
    const labelStr = typeof rawLabel === 'string' ? rawLabel : String(rawLabel ?? '');
    return (
        <div className="rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-[13px] shadow-lg" style={{ color: '#fff' }}>
            <div className="mb-1 text-xs text-gray-400">{formatPortfolioTooltipLabel(labelStr, timeframe)}</div>
            <div className="font-medium tabular-nums" style={{ color: lineColor }}>
                ${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">Value</div>
        </div>
    );
}

/**
 * Extract the return % from a SELL transaction's notes.
 * Handles: Partial Profit, Full Profit Exit, Hard Stop, Trend Exit, Gap-Down Exit, Gap-Fill Protect.
 * Returns null if not parseable (e.g. trailing stops without explicit %).
 */
function parseSellReturnFromNotes(notes?: string): number | null {
    if (!notes) return null;

    // "Partial Profit +2% (1/3 position, 2.1%)"
    let match = notes.match(/position,\s*([-+]?\d+\.?\d*)%\)/);
    if (match) return parseFloat(match[1]);

    // "Full Profit Exit +6% (6.7%)"
    match = notes.match(/Exit\s*\+\d+%\s*\(([-+]?\d+\.?\d*)%\)/);
    if (match) return parseFloat(match[1]);

    // "Hard Stop -5%: -5.5% (cost $133.51)"
    match = notes.match(/Hard Stop.*?:\s*([-+]?\d+\.?\d*)%/);
    if (match) return parseFloat(match[1]);

    // "Trend Exit: ADX 13, 7.0d held, -0.1%"
    match = notes.match(/Trend Exit:[^,]+,[^,]+,\s*([-+]?\d+\.?\d*)%/);
    if (match) return parseFloat(match[1]);

    // "Gap-Down Exit: -3.2% gap, position at -1.5%"
    match = notes.match(/position at\s*([-+]?\d+\.?\d*)%/);
    if (match) return parseFloat(match[1]);

    // "Gap-Fill Protect: 3.5% gap filling, locking 33% at 2.5%"
    match = notes.match(/locking.*?at\s*([-+]?\d+\.?\d*)%/);
    if (match) return parseFloat(match[1]);

    // Trailing Stop — try to extract cost from other notes or compute from matched buy
    // "Trailing Stop: Price $40.98 < Trail $41.02 (HWM $43.54, ATR $1.26)"
    // Can't determine return without cost basis — return null
    return null;
}

/**
 * For trailing stops, compute return by matching against BUY transactions for the same ticker.
 */
function computeSellReturn(
    tx: { ticker: string; price: number; notes?: string },
    allTransactions: { ticker: string; type: string; price: number; date: string }[]
): number | null {
    // First try parsing from notes
    const fromNotes = parseSellReturnFromNotes(tx.notes);
    if (fromNotes !== null) return fromNotes;

    // Fallback: find the most recent BUY for this ticker that happened before this sell
    const buys = allTransactions
        .filter(t => t.ticker === tx.ticker && t.type === 'BUY')
        .sort((a, b) => b.date.localeCompare(a.date)); // newest first

    if (buys.length > 0) {
        const avgCost = buys[0].price; // Use most recent buy's price as cost basis
        return ((tx.price - avgCost) / avgCost) * 100;
    }

    return null;
}


const LivePortfolio = ({ initialTimeframe = '1D' }: LivePortfolioProps = {}) => {
    const [data, setData] = useState<PortfolioData | null>(null);
    const [loading, setLoading] = useState(true);
    const [timeframe, setTimeframe] = useState<'1D' | '1W' | '30D' | 'MAX'>(initialTimeframe);
    const [returnMode, setReturnMode] = useState<ReturnMode>('total_pct');
    const [showAdminLogs, setShowAdminLogs] = useState(false);
    const [adminLoading, setAdminLoading] = useState(false);
    const [adminError, setAdminError] = useState<string | null>(null);
    const [adminLogs, setAdminLogs] = useState<{
        trades: any[];
        analysis: any[];
        cycleLogs?: { cycle_type: string; ran_at: string; summary: string }[];
        dailyPnL?: { date: string; total_value: number; change_dollar: number; change_pct: number }[];
    } | null>(null);

    // Drag-to-select state (Google Finance style)
    const [refAreaLeft, setRefAreaLeft] = useState<string | null>(null);
    const [refAreaRight, setRefAreaRight] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [selectionInfo, setSelectionInfo] = useState<{
        startValue: number;
        endValue: number;
        changeDollar: number;
        changePct: number;
        startLabel: string;
        endLabel: string;
    } | null>(null);

    // Chart fade transition
    const [chartVisible, setChartVisible] = useState(true);

    /** Interpolated hover value (cursor X → between samples) for fluid tooltip */
    const [chartFluidHover, setChartFluidHover] = useState<{ value: number; dateStr: string } | null>(null);

    const pollInterval = useRef<NodeJS.Timeout | null>(null);

    const handleShowLogs = async () => {
        setShowAdminLogs(true);
        if (adminLogs) return; // already loaded
        setAdminLoading(true);
        setAdminError(null);
        try {
            const res = await fetch('/api/admin/trade-logs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ limit: 100 }),
            });
            const json = await res.json();
            if (!res.ok || !json.ok) {
                throw new Error(json.error || 'Failed to load logs');
            }
            setAdminLogs({
                trades: json.trades || [],
                analysis: json.analysis || [],
                cycleLogs: json.cycleLogs || [],
                dailyPnL: json.dailyPnL || [],
            });
        } catch (err: any) {
            setAdminError(err.message || 'Failed to load logs');
        } finally {
            setAdminLoading(false);
        }
    };

    const fetchPortfolio = useCallback(async (silent = false) => {
        try {
            if (!silent) setLoading(true);
            const { data: json } = await fetchJsonWithTimeout<PortfolioData>('/api/portfolio', {
                timeoutMs: 45_000,
            });
            setData(json);
        } catch (err) {
            console.error(err);
        } finally {
            if (!silent) setLoading(false);
        }
    }, []);

    // Initial fetch + polling every 30s
    useEffect(() => {
        fetchPortfolio();
        pollInterval.current = setInterval(() => fetchPortfolio(true), 30_000);

        const handleVisibility = () => {
            if (document.hidden) {
                if (pollInterval.current) clearInterval(pollInterval.current);
            } else {
                fetchPortfolio(true);
                pollInterval.current = setInterval(() => fetchPortfolio(true), 30_000);
            }
        };
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            if (pollInterval.current) clearInterval(pollInterval.current);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [fetchPortfolio]);

    // Smooth transition on timeframe change
    const handleTimeframeChange = useCallback((tf: '1D' | '1W' | '30D' | 'MAX') => {
        if (tf === timeframe) return;
        setChartVisible(false);
        setSelectionInfo(null);
        setRefAreaLeft(null);
        setRefAreaRight(null);
        setChartFluidHover(null);
        setTimeout(() => {
            setTimeframe(tf);
            setChartVisible(true);
        }, 200);
    }, [timeframe]);

    // Build chart data
    const chartData = useMemo(() => {
        if (!data) return [];

        // Use detailed intraday snapshots when we have ≥2 points
        if (data.detailedHistory) {
            const detailed = data.detailedHistory[timeframe];
            if (detailed && detailed.length >= 2) {
                return detailed.map(p => ({
                    date: p.timestamp,
                    total_value: p.total_value,
                }));
            }
        }

        // Fallback: synthesise a reasonable view from coarse daily history
        const currentPoint = { date: new Date().toISOString(), total_value: data.status.total_value };

        if (timeframe === '1D') {
            // Synthesised "today only" view: anchor at today's 9:30 AM ET
            // with the most recent daily close as the baseline, ending at
            // the live current value. Used only when we have no intraday
            // snapshots yet (first cycle of the day).
            const sorted = [...data.history].sort((a, b) => a.date.localeCompare(b.date));
            const lastEntry = sorted[sorted.length - 1];
            const openVal = lastEntry?.total_value ?? data.status.total_value;

            // 9:30 AM ET → UTC. Handles both EST (UTC-5) and EDT (UTC-4)
            // via Intl so this survives DST transitions.
            const now = new Date();
            const todayEtKey = now.toLocaleDateString('sv', { timeZone: 'America/New_York' });
            const openEt = new Date(`${todayEtKey}T09:30:00`);
            const etOffsetMs = openEt.getTime() - new Date(
                openEt.toLocaleString('en-US', { timeZone: 'America/New_York' })
            ).getTime();
            const openTime = new Date(openEt.getTime() + etOffsetMs);
            // If we're before today's open, anchor at "now" so the chart still renders a line
            const anchor = openTime > now ? new Date(now.getTime() - 60_000) : openTime;

            return [
                { date: anchor.toISOString(), total_value: openVal },
                currentPoint,
            ];
        }

        if (timeframe === '1W') {
            const pts = data.history.slice(-7).map(h => ({ date: h.date, total_value: h.total_value }));
            return pts.length >= 2 ? pts : [...pts, currentPoint];
        }

        if (timeframe === '30D') {
            return data.history.map(h => ({ date: h.date, total_value: h.total_value }));
        }

        // MAX
        return data.history.map(h => ({ date: h.date, total_value: h.total_value }));
    }, [data, timeframe]);

    // Determine if the selected timeframe is up or down (for chart colour)
    const chartIsPositive = useMemo(() => {
        if (chartData.length < 2) return true;
        return chartData[chartData.length - 1].total_value >= chartData[0].total_value;
    }, [chartData]);

    // Explicit daily ticks so Recharts never picks two samples that render the
    // same date label (the "Tue Apr 14 × 2" bug). 1D keeps auto-ticks — those
    // are time-of-day so duplicates aren't possible.
    const xAxisTicks = useMemo(() => {
        if (timeframe === '1D' || chartData.length === 0) return undefined;
        const seen = new Map<string, string>();
        for (const p of chartData) {
            // ET date key so the x-axis matches the user's local market day
            const d = new Date(p.date);
            if (isNaN(d.getTime())) continue;
            const key = d.toLocaleDateString('sv', { timeZone: 'America/New_York' });
            if (!seen.has(key)) seen.set(key, p.date);
        }
        const dailyTicks = Array.from(seen.values());
        if (timeframe === '1W') return dailyTicks;
        // 30D: cap to ~8 evenly-spaced daily ticks so labels don't overlap
        const MAX = 8;
        if (dailyTicks.length <= MAX) return dailyTicks;
        const step = (dailyTicks.length - 1) / (MAX - 1);
        const picked: string[] = [];
        for (let i = 0; i < MAX; i++) {
            picked.push(dailyTicks[Math.round(i * step)]);
        }
        return picked;
    }, [chartData, timeframe]);

    // Compute timeframe P&L (persistent display)
    const timeframePnL = useMemo(() => {
        if (chartData.length < 2) return null;
        const first = chartData[0];
        const last = chartData[chartData.length - 1];
        const changeDollar = last.total_value - first.total_value;
        const changePct = first.total_value > 0
            ? ((last.total_value - first.total_value) / first.total_value) * 100
            : 0;
        return { changeDollar, changePct };
    }, [chartData]);

    // Drag handlers for range selection (Recharts 3: first arg is MouseHandlerDataParam)
    const handleMouseDown = useCallback((state: MouseHandlerDataParam) => {
        if (state.activeLabel != null && state.activeLabel !== '') {
            setRefAreaLeft(String(state.activeLabel));
            setRefAreaRight(null);
            setIsDragging(true);
            setSelectionInfo(null);
        }
    }, []);

    const handleChartMouseMove = useCallback(
        (state: MouseHandlerDataParam, e: React.SyntheticEvent) => {
            if (isDragging) {
                if (state.activeLabel != null && state.activeLabel !== '') {
                    setRefAreaRight(String(state.activeLabel));
                }
                return;
            }
            const target = e.currentTarget as HTMLElement;
            const bounds = getRechartsPlotXBounds(target);
            const cx = (e.nativeEvent as MouseEvent).clientX;
            if (bounds && chartData.length >= 2) {
                const interp = interpolatePortfolioAtClientX(cx, bounds, chartData);
                setChartFluidHover(interp);
            } else {
                setChartFluidHover(null);
            }
        },
        [isDragging, chartData],
    );

    const handleMouseUp = useCallback(() => {
        if (!isDragging || !refAreaLeft) {
            setIsDragging(false);
            return;
        }
        setIsDragging(false);

        const left = refAreaLeft;
        const right = refAreaRight || refAreaLeft;
        const leftIdx = chartData.findIndex(d => d.date === left);
        const rightIdx = chartData.findIndex(d => d.date === right);

        if (leftIdx < 0 || rightIdx < 0) {
            setRefAreaLeft(null);
            setRefAreaRight(null);
            return;
        }

        const startIdx = Math.min(leftIdx, rightIdx);
        const endIdx = Math.max(leftIdx, rightIdx);

        if (startIdx === endIdx) {
            setRefAreaLeft(null);
            setRefAreaRight(null);
            setSelectionInfo(null);
            return;
        }

        const startPoint = chartData[startIdx];
        const endPoint = chartData[endIdx];
        const changeDollar = endPoint.total_value - startPoint.total_value;
        const changePct = startPoint.total_value > 0
            ? ((endPoint.total_value - startPoint.total_value) / startPoint.total_value) * 100
            : 0;

        const formatLabel = (dateStr: string) => {
            const d = parseDate(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            if (timeframe === '1D') {
                return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
            }
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        };

        setSelectionInfo({
            startValue: startPoint.total_value,
            endValue: endPoint.total_value,
            changeDollar,
            changePct,
            startLabel: formatLabel(startPoint.date),
            endLabel: formatLabel(endPoint.date),
        });

        setRefAreaLeft(chartData[startIdx].date);
        setRefAreaRight(chartData[endIdx].date);
    }, [isDragging, refAreaLeft, refAreaRight, chartData, timeframe]);

    const clearSelection = useCallback(() => {
        setRefAreaLeft(null);
        setRefAreaRight(null);
        setSelectionInfo(null);
    }, []);

    if (loading) return (
        <div className="flex justify-center items-center h-64 text-aquamarine-400 animate-pulse">
            <Activity className="w-8 h-8 mr-2" /> Loading Live Portfolio...
        </div>
    );

    if (!data) return <div className="text-center text-gray-500 py-10">Portfolio data unavailable.</div>;

    const totalValue = data.status.total_value;
    const cash = data.status.cash_balance;
    const equity = data.status.total_equity;
    const startValue = 100000;
    const totalReturn = ((totalValue - startValue) / startValue) * 100;
    const isPositive = totalReturn >= 0;

    return (
        <div className="space-y-6 animate-fade-in">
            {/* Top Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-gray-800 rounded-xl p-6 relative overflow-hidden transition-colors border border-gray-700 hover:border-gray-500">
                    <h3 className="text-gray-400 text-sm font-medium mb-1 flex items-center gap-2">
                        <Activity size={16} /> Total Portfolio Value
                    </h3>
                    <div className="text-3xl font-bold text-white flex items-baseline gap-2">
                        <AnimatedNumber value={totalValue} prefix="$" decimals={2} className="text-white" />
                        <span className={`text-sm ml-2 font-medium px-2 py-0.5 rounded-full ${isPositive ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                            <AnimatedNumber value={totalReturn} prefix={isPositive ? '+' : ''} suffix="%" decimals={2} className={isPositive ? 'text-green-400' : 'text-red-400'} />
                        </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">Started with $100,000.00</p>
                </div>

                <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 flex flex-col justify-center">
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-gray-400 text-sm">Cash Balance</span>
                        <AnimatedNumber value={cash} prefix="$" decimals={0} className="text-white font-mono" />
                    </div>
                    <div className="w-full bg-gray-700 h-2 rounded-full overflow-hidden mb-4">
                        <div className="bg-emerald-400 h-full" style={{ width: `${(cash / totalValue) * 100}%` }}></div>
                    </div>
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-gray-400 text-sm">Equity (Stocks)</span>
                        <AnimatedNumber value={equity} prefix="$" decimals={0} className="text-white font-mono" />
                    </div>
                    <div className="w-full bg-gray-700 h-2 rounded-full overflow-hidden">
                        <div className="bg-blue-500 h-full" style={{ width: `${(equity / totalValue) * 100}%` }}></div>
                    </div>
                </div>

                <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 flex flex-col justify-center items-center text-center">
                    <PieChart className="w-8 h-8 text-aquamarine-400 mb-2" />
                    <div className="text-2xl font-bold text-white">{data.holdings.length}</div>
                    <div className="text-sm text-gray-400">Active Positions</div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-6">

                    {/* Chart Section */}
                    <div className="bg-gray-800 border border-gray-700 rounded-xl p-6">
                        <div className="flex justify-between items-center mb-3">
                            <div>
                                <h3 className="text-lg font-bold text-white">Portfolio Growth</h3>
                                {/* Persistent timeframe P&L */}
                                {timeframePnL && (
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className={`text-sm font-semibold ${timeframePnL.changeDollar >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                            {timeframePnL.changeDollar >= 0 ? '+' : ''}${timeframePnL.changeDollar.toFixed(2)}
                                        </span>
                                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${timeframePnL.changePct >= 0 ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                                            {timeframePnL.changePct >= 0 ? '+' : ''}{timeframePnL.changePct.toFixed(3)}%
                                        </span>
                                        <span className="text-xs text-gray-500 ml-1">
                                            {timeframe === '1D'
                                                ? 'Today'
                                                : timeframe === '1W'
                                                    ? 'Past 7 Days'
                                                    : timeframe === '30D'
                                                        ? 'Past 30 Days'
                                                        : 'Since inception'}
                                        </span>
                                    </div>
                                )}
                            </div>
                            <div className="flex gap-2 bg-gray-900/50 p-1 rounded-lg">
                                {(['1D', '1W', '30D', 'MAX'] as const).map(tf => (
                                    <button
                                        key={tf}
                                        onClick={() => handleTimeframeChange(tf)}
                                        className={`px-3 py-1 rounded text-sm font-medium transition-colors ${timeframe === tf
                                            ? 'bg-aquamarine-500/20 text-aquamarine-400 border border-aquamarine-500/30'
                                            : 'text-gray-400 hover:text-white hover:bg-gray-800'
                                            }`}
                                    >
                                        {tf}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Selection Info Banner */}
                        {selectionInfo && (
                            <div className="mb-3 flex items-center justify-between bg-gray-900/80 border border-gray-600/50 rounded-lg px-4 py-2.5">
                                <div className="flex items-center gap-4">
                                    <div className="text-xs text-gray-400">
                                        {selectionInfo.startLabel} → {selectionInfo.endLabel}
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <span className={`text-sm font-bold flex items-center gap-1 ${selectionInfo.changeDollar >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                            {selectionInfo.changeDollar >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                                            {selectionInfo.changeDollar >= 0 ? '+' : ''}${selectionInfo.changeDollar.toFixed(2)}
                                        </span>
                                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${selectionInfo.changePct >= 0 ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
                                            {selectionInfo.changePct >= 0 ? '+' : ''}{selectionInfo.changePct.toFixed(3)}%
                                        </span>
                                    </div>
                                </div>
                                <button onClick={clearSelection} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">✕ Clear</button>
                            </div>
                        )}

                        {!selectionInfo && (
                            <div className="text-[10px] text-gray-500 mb-1 select-none">
                                Click and drag on the chart to compare two points
                            </div>
                        )}

                        {(() => {
                            const lineColor = chartIsPositive ? '#10b981' : '#ef4444';
                            const gradientId = `chartGrad-${timeframe}-${chartIsPositive ? 'pos' : 'neg'}`;
                            const gradientColor = chartIsPositive ? '#10b981' : '#ef4444';
                            return (
                                <div
                                    className="h-[300px] w-full select-none"
                                    style={{
                                        outline: 'none',
                                        cursor: isDragging ? 'col-resize' : 'crosshair',
                                        opacity: chartVisible ? 1 : 0,
                                        transition: 'opacity 0.2s ease-in-out',
                                    }}
                                    onMouseLeave={() => {
                                        setChartFluidHover(null);
                                        if (isDragging) handleMouseUp();
                                    }}
                                >
                                    <ResponsiveContainer width="100%" height="100%" style={{ outline: 'none' }}>
                                        <AreaChart
                                            data={chartData}
                                            margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                                            style={{ outline: 'none' }}
                                            onMouseDown={handleMouseDown}
                                            onMouseMove={handleChartMouseMove}
                                            onMouseUp={handleMouseUp}
                                        >
                                            <defs>
                                                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="0%" stopColor={gradientColor} stopOpacity={0.18} />
                                                    <stop offset="100%" stopColor={gradientColor} stopOpacity={0} />
                                                </linearGradient>
                                            </defs>
                                            <XAxis
                                                dataKey="date"
                                                tickFormatter={(str) => {
                                                    const d = parseDate(str);
                                                    if (isNaN(d.getTime())) return '';
                                                    if (timeframe === '1D') return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
                                                    if (timeframe === '1W') return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                                                    if (timeframe === 'MAX') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
                                                    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                                                }}
                                                stroke="#374151"
                                                tick={{ fill: '#6b7280', fontSize: 11 }}
                                                axisLine={false}
                                                tickLine={false}
                                                minTickGap={40}
                                                ticks={xAxisTicks}
                                                interval={xAxisTicks ? 0 : 'preserveStartEnd'}
                                            />
                                            <YAxis
                                                domain={[
                                                    (dataMin: number) => dataMin - Math.max((dataMin) * 0.001, 50),
                                                    (dataMax: number) => dataMax + Math.max((dataMax) * 0.001, 50),
                                                ]}
                                                tickFormatter={(val) => `$${(val / 1000).toFixed(1)}k`}
                                                stroke="#374151"
                                                tick={{ fill: '#6b7280', fontSize: 11 }}
                                                axisLine={false}
                                                tickLine={false}
                                                width={58}
                                            />
                                            <Tooltip
                                                shared
                                                isAnimationActive={false}
                                                allowEscapeViewBox={{ x: true, y: true }}
                                                reverseDirection={{ x: false, y: true }}
                                                offset={32}
                                                cursor={{ stroke: '#6b7280', strokeWidth: 1, strokeDasharray: '4 3' }}
                                                wrapperStyle={{ outline: 'none', zIndex: 20 }}
                                                content={(props) => (
                                                    <PortfolioTooltipContent
                                                        active={props.active}
                                                        payload={props.payload as PortfolioTooltipContentProps['payload']}
                                                        label={props.label}
                                                        fluid={chartFluidHover}
                                                        timeframe={timeframe}
                                                        lineColor={lineColor}
                                                    />
                                                )}
                                            />
                                            {refAreaLeft && refAreaRight && (
                                                <ReferenceArea
                                                    x1={refAreaLeft}
                                                    x2={refAreaRight}
                                                    strokeOpacity={0.3}
                                                    stroke={lineColor}
                                                    fill={lineColor}
                                                    fillOpacity={0.06}
                                                />
                                            )}
                                            <Area
                                                type="monotone"
                                                dataKey="total_value"
                                                stroke={lineColor}
                                                strokeWidth={2}
                                                fillOpacity={1}
                                                fill={`url(#${gradientId})`}
                                                dot={false}
                                                activeDot={{ r: 4, fill: lineColor, stroke: '#111827', strokeWidth: 2 }}
                                                style={{ outline: 'none' }}
                                                isAnimationActive={false}
                                            />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            );
                        })()}
                    </div>

                    {/* Holdings Table */}
                    <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                        <div className="p-4 border-b border-gray-700 flex justify-between items-center">
                            <h3 className="text-lg font-bold text-white">Current Holdings</h3>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="bg-gray-700/30 text-gray-400 text-sm">
                                        <th className="p-4 font-medium">Ticker</th>
                                        <th className="p-4 font-medium text-right">Shares</th>
                                        <th className="p-4 font-medium text-right">Avg Cost</th>
                                        <th className="p-4 font-medium text-right">Price</th>
                                        <th className="p-4 font-medium text-right">Value</th>
                                        <th
                                            className="p-4 font-medium text-right cursor-pointer select-none group"
                                            onClick={() => setReturnMode(prev => RETURN_CYCLE[(RETURN_CYCLE.indexOf(prev) + 1) % RETURN_CYCLE.length])}
                                            title="Click to toggle between Total Return %, Today's Return %, Total Return ($)"
                                        >
                                            <span className="inline-flex items-center gap-1 group-hover:text-aquamarine-400 transition-colors">
                                                {RETURN_LABELS[returnMode]}
                                                <svg className="w-3 h-3 opacity-50 group-hover:opacity-100 transition-opacity" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <path d="M3 5l3-3 3 3M3 7l3 3 3-3" />
                                                </svg>
                                            </span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-700/50">
                                    {data.holdings.length === 0 ? (
                                        <tr>
                                            <td colSpan={6} className="p-8 text-center text-gray-500">
                                                No active holdings.
                                            </td>
                                        </tr>
                                    ) : (
                                        data.holdings.map((h) => {
                                            let displayValue: number;
                                            let prefix = '';
                                            let suffix = '';
                                            let isProfitable: boolean;

                                            if (returnMode === 'total_pct') {
                                                displayValue = h.return_pct;
                                                isProfitable = displayValue >= 0;
                                                prefix = isProfitable ? '+' : '';
                                                suffix = '%';
                                            } else if (returnMode === 'day_pct') {
                                                displayValue = h.day_change_pct ?? 0;
                                                isProfitable = displayValue >= 0;
                                                prefix = isProfitable ? '+' : '';
                                                suffix = '%';
                                            } else {
                                                displayValue = h.total_return_dollar;
                                                isProfitable = displayValue >= 0;
                                                prefix = isProfitable ? '+$' : '-$';
                                                displayValue = Math.abs(displayValue);
                                                suffix = '';
                                            }

                                            return (
                                                <tr key={h.ticker} className="hover:bg-gray-700/20 transition-colors">
                                                    <td className="p-4 font-bold text-white">
                                                        <Link href={`/analyze?ticker=${h.ticker}`} className="hover:text-aquamarine-400 underline decoration-gray-500/30 underline-offset-4 decoration-dashed transition-colors">
                                                            {h.ticker}
                                                        </Link>
                                                    </td>
                                                    <td className="p-4 text-right text-gray-300">{h.shares.toFixed(2)}</td>
                                                    <td className="p-4 text-right text-gray-400">${h.avg_cost.toFixed(2)}</td>
                                                    <td className="p-4 text-right">
                                                        <AnimatedNumber value={h.current_price} prefix="$" decimals={2} className="text-white" />
                                                    </td>
                                                    <td className="p-4 text-right font-medium">
                                                        <AnimatedNumber value={h.market_value} prefix="$" decimals={0} className="text-white" />
                                                    </td>
                                                    <td className="p-4 text-right font-bold">
                                                        {returnMode === 'day_pct' && h.day_change_pct === null ? (
                                                            <span className="text-gray-500">—</span>
                                                        ) : (
                                                            <AnimatedNumber
                                                                value={displayValue}
                                                                prefix={prefix}
                                                                suffix={suffix}
                                                                decimals={returnMode === 'total_dollar' ? 0 : 2}
                                                                className={isProfitable ? 'text-green-400' : 'text-red-400'}
                                                            />
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                {/* Right Column: Trade History */}
                <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden flex flex-col h-full max-h-[800px]">
                    <div className="p-4 border-b border-gray-700 bg-gray-800 sticky top-0 z-10 flex items-center justify-between">
                        <h3 className="text-lg font-bold text-white flex items-center gap-2">
                            <HistoryIcon />
                            Trade History
                        </h3>
                        <button
                            onClick={() => setShowAdminLogs(true)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-600 px-2 py-1 text-xs text-gray-200 hover:bg-gray-700 transition-colors"
                            title="Admin logs (password required)"
                        >
                            <FileText size={14} />
                            Logs
                        </button>
                    </div>
                    <div className="overflow-y-auto flex-1 p-0 custom-scrollbar">
                        {data.transactions.length === 0 ? (
                            <div className="p-8 text-center text-gray-500">No transactions recorded yet.</div>
                        ) : (
                            <div className="divide-y divide-gray-700/50">
                                {data.transactions.map((tx, idx) => {
                                    // Compute sell return
                                    let sellReturn: number | null = null;
                                    if (tx.type === 'SELL') {
                                        sellReturn = computeSellReturn(tx, data.transactions);
                                    }

                                    return (
                                        <div key={idx} className="p-4 hover:bg-gray-700/20 transition-colors flex justify-between items-start">
                                            <div>
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${tx.type === 'BUY' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                                                        }`}>
                                                        {tx.type}
                                                    </span>
                                                    <Link href={`/analyze?ticker=${tx.ticker}`} className="font-bold text-white tracking-wide hover:text-aquamarine-400 transition-colors">
                                                        {tx.ticker}
                                                    </Link>
                                                </div>
                                                {tx.company_name && (
                                                    <div className="text-xs text-gray-400 mb-0.5 max-w-[150px] truncate" title={tx.company_name}>
                                                        {tx.company_name}
                                                    </div>
                                                )}
                                                <div className="text-xs text-gray-500">
                                                    {parseDate(tx.date).toLocaleString(undefined, {
                                                        month: 'short', day: 'numeric',
                                                        hour: 'numeric', minute: 'numeric'
                                                    })}
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className="text-sm text-gray-200">
                                                    {tx.shares.toFixed(0)} @ ${tx.price.toFixed(2)}
                                                </div>
                                                <div className="text-xs text-gray-500">
                                                    ${tx.total_amount.toLocaleString()}
                                                </div>
                                                {/* Sell P&L indicator */}
                                                {tx.type === 'SELL' && sellReturn !== null && (
                                                    <div className={`text-xs font-semibold mt-0.5 ${sellReturn >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                        {sellReturn >= 0 ? '+' : ''}{sellReturn.toFixed(2)}% ROI
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* Admin Logs Modal */}
                {showAdminLogs && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setShowAdminLogs(false); setAdminLogs(null); setAdminError(null); }}>
                        <div className="w-full max-w-6xl rounded-xl bg-gray-900 border border-gray-700 shadow-2xl max-h-[92vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-between border-b border-gray-700 px-5 py-3.5">
                                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                                    <FileText size={16} className="text-aquamarine-400" />
                                    Trade & Signal Logs
                                </h2>
                                <button
                                    type="button"
                                    onClick={() => { setShowAdminLogs(false); setAdminLogs(null); setAdminError(null); }}
                                    className="text-gray-400 hover:text-white text-sm"
                                >
                                    Close
                                </button>
                            </div>

                            {!adminLogs && adminLoading && (
                                <div className="p-8 text-center text-gray-400">Loading logs...</div>
                            )}
                            {!adminLogs && !adminLoading && adminError && (
                                <div className="p-8 text-center text-red-400">{adminError}</div>
                            )}

                            {adminLogs && (
                                <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs text-gray-200">
                                    <div className="flex justify-between items-center">
                                        <h3 className="font-semibold text-white">Trading Logic Logs</h3>
                                        <button
                                            onClick={handleShowLogs}
                                            className="text-xs text-aquamarine-400 hover:text-aquamarine-300 flex items-center gap-1"
                                        >
                                            <RefreshCw size={12} /> Refresh
                                        </button>
                                    </div>

                                    {/* Daily P&L */}
                                    {adminLogs.dailyPnL && adminLogs.dailyPnL.length > 0 && (
                                        <div className="rounded-lg border border-gray-700/60 bg-gray-800/70 overflow-hidden">
                                            <div className="px-4 py-2.5 border-b border-gray-700/50 flex items-center gap-2">
                                                <DollarSign size={14} className="text-aquamarine-400" />
                                                <span className="font-semibold text-white text-xs">Daily P&L Summary</span>
                                            </div>
                                            <div className="divide-y divide-gray-700/30">
                                                {adminLogs.dailyPnL.map((day, idx) => {
                                                    const isUp = day.change_pct >= 0;
                                                    const isFirst = idx === adminLogs.dailyPnL!.length - 1;
                                                    return (
                                                        <div key={idx} className="px-4 py-2.5 flex items-center justify-between hover:bg-gray-700/20 transition-colors">
                                                            <div className="flex items-center gap-3">
                                                                <span className="text-gray-300 font-mono w-[85px]">{day.date}</span>
                                                                <span className="text-gray-400 text-[11px]">${day.total_value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                                                            </div>
                                                            {!isFirst ? (
                                                                <div className="flex items-center gap-2">
                                                                    <span className={`font-bold ${isUp ? 'text-green-400' : 'text-red-400'}`}>
                                                                        {isUp ? '+' : ''}{day.change_pct.toFixed(2)}%
                                                                    </span>
                                                                    <span className={`text-[11px] ${isUp ? 'text-green-500/70' : 'text-red-500/70'}`}>
                                                                        ({isUp ? '+' : ''}${day.change_dollar.toFixed(2)})
                                                                    </span>
                                                                </div>
                                                            ) : (
                                                                <span className="text-gray-500 text-[11px]">—</span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Cycle Logs */}
                                    {adminLogs.cycleLogs && adminLogs.cycleLogs.length > 0 ? (
                                        <div className="space-y-2 mb-6">
                                            {adminLogs.cycleLogs.filter((l: any) => l.cycle_type !== 'PORTFOLIO_CHECK').map((entry: any, idx: number) => (
                                                <div key={idx} className="rounded-md border border-gray-700/60 bg-gray-800/70 p-3 whitespace-pre-wrap font-mono text-[10px] leading-relaxed">
                                                    <div className="text-aquamarine-500 mb-1 border-b border-gray-700/50 pb-1 flex justify-between">
                                                        <span>{entry.cycle_type}</span>
                                                        <span className="text-gray-500">{parseDate(entry.ran_at).toLocaleString()}</span>
                                                    </div>
                                                    <div className="text-gray-300 mt-2">{entry.summary}</div>
                                                </div>
                                            ))}

                                            {adminLogs.cycleLogs.filter((l: any) => l.cycle_type === 'PORTFOLIO_CHECK').length > 0 && (
                                                <details className="rounded-md border border-gray-700/60 bg-gray-800/70 p-3 whitespace-pre-wrap font-mono text-[10px] leading-relaxed group mt-4">
                                                    <summary className="text-aquamarine-500 border-b border-gray-700/50 pb-1 flex justify-between cursor-pointer list-none appearance-none outline-none font-bold">
                                                        <span>1 Min Portfolio Checks ({adminLogs.cycleLogs.filter((l: any) => l.cycle_type === 'PORTFOLIO_CHECK').length}) <span className="text-gray-400 group-open:hidden ml-1">▼</span><span className="text-gray-400 hidden group-open:inline ml-1">▲</span></span>
                                                        <span className="text-gray-500 text-right">Latest: {parseDate(adminLogs.cycleLogs.filter((l: any) => l.cycle_type === 'PORTFOLIO_CHECK')[0].ran_at).toLocaleString()}</span>
                                                    </summary>
                                                    <div className="mt-3 space-y-3 max-h-[300px] overflow-y-auto custom-scrollbar">
                                                        {adminLogs.cycleLogs.filter((l: any) => l.cycle_type === 'PORTFOLIO_CHECK').map((entry: any, idx: number) => (
                                                            <div key={idx} className="border-l-2 border-gray-600 pl-2">
                                                                <div className="text-gray-500 mb-1">{parseDate(entry.ran_at).toLocaleString()}</div>
                                                                <div className="text-gray-400">{entry.summary}</div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </details>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="p-4 border border-dashed border-gray-700 rounded-lg text-center text-gray-500 mb-6">
                                            No cycle logs found. They will appear after the next scheduled trading run.
                                        </div>
                                    )}

                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                        <div>
                                            <h3 className="mb-2 font-semibold text-white">Recent Trades</h3>
                                            {adminLogs.trades.length === 0 ? (
                                                <p className="text-gray-500 text-xs italic">No trades executed yet.</p>
                                            ) : (
                                                <div className="space-y-2">
                                                    {adminLogs.trades.map((tx: any, idx: number) => (
                                                        <div key={idx} className="rounded-md border border-gray-700/60 bg-gray-800/70 p-2">
                                                            <div className="flex justify-between items-center mb-1">
                                                                <Link href={`/analyze?ticker=${tx.ticker}`} className="font-bold hover:text-aquamarine-400 transition-colors">{tx.ticker}</Link>
                                                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${tx.type === 'BUY' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{tx.type}</span>
                                                            </div>
                                                            <div className="flex justify-between text-gray-400">
                                                                <span>{tx.shares} @ ${Number(tx.price).toFixed(2)}</span>
                                                                <span>${Number(tx.total_amount).toLocaleString()}</span>
                                                            </div>
                                                            <div className="mt-1 text-[10px] text-gray-500">
                                                                {parseDate(tx.date).toLocaleString()}
                                                                {tx.notes && ` · ${tx.notes}`}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <div>
                                            <h3 className="mb-2 font-semibold text-white">Recent Signals / Reasons</h3>
                                            {adminLogs.analysis.length === 0 ? (
                                                <p className="text-gray-500 text-xs italic">No analysis data available.</p>
                                            ) : (
                                                <div className="space-y-2">
                                                    {adminLogs.analysis.filter((row: any) => row.ticker !== '_cycle').map((row: any, idx: number) => {
                                                        const isHolding = data.holdings.some(h => h.ticker === row.ticker);
                                                        const displayAction = row.action === 'HOLD' && !isHolding ? 'MONITOR' : row.action;

                                                        return (
                                                            <div key={idx} className="rounded-md border border-gray-700/60 bg-gray-800/70 p-2">
                                                                <div className="flex justify-between items-center mb-1">
                                                                    <Link href={`/analyze?ticker=${row.ticker}`} className="font-bold hover:text-aquamarine-400 transition-colors">{row.ticker}</Link>
                                                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${row.action === 'BUY' ? 'bg-green-500/20 text-green-400' : row.action === 'SELL' ? 'bg-red-500/20 text-red-400' : 'bg-gray-500/20 text-gray-300'
                                                                        }`}>{displayAction} {row.confidence != null ? `(${row.confidence}%)` : ''}</span>
                                                                </div>
                                                                <div className="text-[11px] text-gray-400 mb-1">{row.reason}</div>
                                                                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gray-500">
                                                                    {row.rsi != null && <span>RSI: {row.rsi.toFixed(1)}</span>}
                                                                    {row.macd_histogram != null && <span>MACD hist: {row.macd_histogram.toFixed(3)}</span>}
                                                                    {row.volume_ratio != null && <span>Vol×: {row.volume_ratio.toFixed(2)}</span>}
                                                                    {row.price_change_pct != null && <span>Δ20d: {row.price_change_pct.toFixed(1)}%</span>}
                                                                    {row.sma50 != null && row.sma200 != null && <span>SMA50/SMA200: {row.sma50.toFixed(2)}/{row.sma200.toFixed(2)}</span>}
                                                                </div>
                                                                <div className="mt-1 text-[10px] text-gray-500">{row.analyzed_at && parseDate(row.analyzed_at).toLocaleString()}</div>
                                                            </div>
                                                        )
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

const HistoryIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 12" />
        <path d="M3 3v9h9" />
        <path d="M12 7v5l4 2" />
    </svg>
);

export default LivePortfolio;
