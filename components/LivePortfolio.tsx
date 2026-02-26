
import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { ArrowUpRight, ArrowDownRight, RefreshCw, DollarSign, PieChart, Activity, FileText } from 'lucide-react';
import BlurText from './BlurText';

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
    }[];
    transactions: {
        date: string;
        ticker: string;
        type: 'BUY' | 'SELL';
        shares: number;
        price: number;
        total_amount: number;
        company_name?: string | null;
    }[];
    history: {
        date: string;
        total_value: number;
    }[];
    detailedHistory?: {
        '1D': { timestamp: string; total_value: number }[];
        '1W': { timestamp: string; total_value: number }[];
        '30D': { timestamp: string; total_value: number }[];
    };
}

interface LivePortfolioProps {
    initialTimeframe?: '1D' | '1W' | '30D';
}

const parseDate = (d: string) => new Date(d.endsWith('Z') ? d : (d.includes('T') ? d + 'Z' : d.replace(' ', 'T') + 'Z'));

const LivePortfolio = ({ initialTimeframe = '30D' }: LivePortfolioProps = {}) => {
    const [data, setData] = useState<PortfolioData | null>(null);
    const [loading, setLoading] = useState(true);
    const [timeframe, setTimeframe] = useState<'1D' | '1W' | '30D'>(initialTimeframe);
    const [showAdminLogs, setShowAdminLogs] = useState(false);
    const [adminPassword, setAdminPassword] = useState('');
    const [adminLoading, setAdminLoading] = useState(false);
    const [adminError, setAdminError] = useState<string | null>(null);
    const [adminLogs, setAdminLogs] = useState<{
        trades: any[];
        analysis: any[];
        cycleLogs?: { cycle_type: string; ran_at: string; summary: string }[];
    } | null>(null);

    useEffect(() => {
        fetchPortfolio();
    }, []);

    const fetchPortfolio = async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/portfolio');
            const json = await res.json();
            setData(json);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

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
                {/* Total Value Card */}
                <div className="bg-gray-800 rounded-xl p-6 relative overflow-hidden transition-colors border border-gray-700 hover:border-gray-500">
                    <h3 className="text-gray-400 text-sm font-medium mb-1 flex items-center gap-2">
                        <Activity size={16} /> Total Portfolio Value
                    </h3>
                    <div className="text-3xl font-bold text-white flex items-baseline gap-2">
                        $<BlurText text={totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} className="inline-block" delay={50} />
                        <span className={`text-sm ml-2 font-medium px-2 py-0.5 rounded-full ${isPositive ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                            {isPositive ? '+' : ''}{totalReturn.toFixed(2)}%
                        </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">Started with $100,000.00</p>
                </div>

                {/* Cash vs Equity */}
                <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 flex flex-col justify-center">
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-gray-400 text-sm">Cash Balance</span>
                        <span className="text-white font-mono">${cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                    </div>
                    <div className="w-full bg-gray-700 h-2 rounded-full overflow-hidden mb-4">
                        <div className="bg-emerald-400 h-full" style={{ width: `${(cash / totalValue) * 100}%` }}></div>
                    </div>
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-gray-400 text-sm">Equity (Stocks)</span>
                        <span className="text-white font-mono">${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                    </div>
                    <div className="w-full bg-gray-700 h-2 rounded-full overflow-hidden">
                        <div className="bg-blue-500 h-full" style={{ width: `${(equity / totalValue) * 100}%` }}></div>
                    </div>
                </div>

                {/* Quick Stats or Small Chart */}
                {/* For now, just a placeholder or extra stat */}
                <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 flex flex-col justify-center items-center text-center">
                    <PieChart className="w-8 h-8 text-aquamarine-400 mb-2" />
                    <div className="text-2xl font-bold text-white">{data.holdings.length}</div>
                    <div className="text-sm text-gray-400">Active Positions</div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Left Column: Chart & Holdings (2/3 width) */}
                <div className="lg:col-span-2 space-y-6">

                    {/* Chart Section */}
                    <div className="bg-gray-800 border border-gray-700 rounded-xl p-6">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-bold text-white">Portfolio Growth</h3>
                            <div className="flex gap-2 bg-gray-900/50 p-1 rounded-lg">
                                {['1D', '1W', '30D'].map(tf => (
                                    <button
                                        key={tf}
                                        onClick={() => setTimeframe(tf as '1D' | '1W' | '30D')}
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
                        <div className="h-[300px] w-full" style={{ outline: 'none' }}>
                            <ResponsiveContainer width="100%" height="100%" style={{ outline: 'none' }}>
                                <AreaChart
                                    data={(() => {
                                        // Use detailedHistory if available, fallback to legacy history
                                        if (data.detailedHistory) {
                                            const detailed = data.detailedHistory[timeframe];
                                            if (detailed && detailed.length > 0) {
                                                return detailed.map(p => ({
                                                    date: p.timestamp,
                                                    total_value: p.total_value,
                                                }));
                                            }
                                        }
                                        // Fallback to legacy daily history
                                        return timeframe === '1D' ? data.history.slice(-2)
                                            : timeframe === '1W' ? data.history.slice(-7)
                                                : data.history;
                                    })()}
                                    style={{ outline: 'none' }}
                                >
                                    <defs>
                                        <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <XAxis
                                        dataKey="date"
                                        tickFormatter={(str) => {
                                            const d = parseDate(str);
                                            if (isNaN(d.getTime())) return '';
                                            if (timeframe === '1D') {
                                                return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
                                            }
                                            if (timeframe === '1W') {
                                                return d.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric' });
                                            }
                                            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                                        }}
                                        stroke="#4b5563"
                                        fontSize={12}
                                    />
                                    <YAxis
                                        domain={['auto', 'auto']}
                                        tickFormatter={(val) => `$${(val / 1000).toFixed(0)}k`}
                                        stroke="#4b5563"
                                        fontSize={12}
                                    />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#1f2937', borderColor: '#374151', color: '#fff' }}
                                        itemStyle={{ color: '#10b981' }}
                                        formatter={(val: number | undefined) => [`$${(val ?? 0).toLocaleString()}`, 'Value'] as [string, string]}
                                        labelFormatter={(label) => {
                                            const d = parseDate(label);
                                            if (isNaN(d.getTime())) return String(label);
                                            if (timeframe === '1D') {
                                                return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                                            }
                                            if (timeframe === '1W') {
                                                return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' });
                                            }
                                            return d.toLocaleDateString();
                                        }}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="total_value"
                                        stroke="#10b981"
                                        strokeWidth={2}
                                        fillOpacity={1}
                                        fill="url(#colorValue)"
                                        activeDot={{ stroke: 'none', r: 4 }}
                                        style={{ outline: 'none' }}
                                    />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
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
                                        <th className="p-4 font-medium text-right">Return</th>
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
                                            const isProfitable = h.return_pct >= 0;
                                            return (
                                                <tr key={h.ticker} className="hover:bg-gray-700/20 transition-colors">
                                                    <td className="p-4 font-bold text-white">{h.ticker}</td>
                                                    <td className="p-4 text-right text-gray-300">{h.shares.toFixed(2)}</td>
                                                    <td className="p-4 text-right text-gray-400">${h.avg_cost.toFixed(2)}</td>
                                                    <td className="p-4 text-right text-white">${h.current_price.toFixed(2)}</td>
                                                    <td className="p-4 text-right text-white font-medium">${h.market_value.toLocaleString()}</td>
                                                    <td className={`p-4 text-right font-bold ${isProfitable ? 'text-green-400' : 'text-red-400'}`}>
                                                        {isProfitable ? '+' : ''}{h.return_pct.toFixed(2)}%
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

                {/* Right Column: Transactions + Admin Logs (1/3 width) */}
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
                                {data.transactions.map((tx, idx) => (
                                    <div key={idx} className="p-4 hover:bg-gray-700/20 transition-colors flex justify-between items-start">
                                        <div>
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${tx.type === 'BUY' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                                                    }`}>
                                                    {tx.type}
                                                </span>
                                                <span className="font-bold text-white tracking-wide">{tx.ticker}</span>
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
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Admin Logs Modal - outside map so it renders once and Logs button works */}
                {showAdminLogs && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setShowAdminLogs(false); setAdminLogs(null); setAdminPassword(''); setAdminError(null); }}>
                        <div className="w-full max-w-4xl rounded-xl bg-gray-900 border border-gray-700 shadow-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-between border-b border-gray-700 px-4 py-3">
                                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                                    <FileText size={16} className="text-aquamarine-400" />
                                    Trade & Signal Logs
                                </h2>
                                <button
                                    type="button"
                                    onClick={() => { setShowAdminLogs(false); setAdminLogs(null); setAdminPassword(''); setAdminError(null); }}
                                    className="text-gray-400 hover:text-white text-sm"
                                >
                                    Close
                                </button>
                            </div>

                            {!adminLogs && (
                                <div className="p-4 border-b border-gray-800">
                                    <p className="text-xs text-gray-400 mb-2">
                                        Enter admin password
                                    </p>
                                    <form
                                        className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center"
                                        onSubmit={async (e) => {
                                            e.preventDefault();
                                            setAdminLoading(true);
                                            setAdminError(null);
                                            try {
                                                const res = await fetch('/api/admin/trade-logs', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ password: adminPassword, limit: 100 }),
                                                });
                                                const json = await res.json();
                                                if (!res.ok || !json.ok) {
                                                    throw new Error(json.error || 'Failed to load logs');
                                                }
                                                setAdminLogs({
                                                    trades: json.trades || [],
                                                    analysis: json.analysis || [],
                                                    cycleLogs: json.cycleLogs || [],
                                                });
                                            } catch (err: any) {
                                                setAdminError(err.message || 'Failed to load logs');
                                            } finally {
                                                setAdminLoading(false);
                                                setAdminPassword('');
                                            }
                                        }}
                                    >
                                        <input
                                            type="password"
                                            className="flex-1 rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-aquamarine-400"
                                            placeholder="Admin password"
                                            value={adminPassword}
                                            onChange={(e) => setAdminPassword(e.target.value)}
                                        />
                                        <button
                                            type="submit"
                                            disabled={adminLoading || !adminPassword}
                                            className="rounded-md bg-aquamarine-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-60"
                                        >
                                            {adminLoading ? 'Checking…' : 'View logs'}
                                        </button>
                                    </form>
                                    {adminError && <p className="mt-2 text-xs text-red-400">{adminError}</p>}
                                </div>
                            )}

                            {adminLogs && (
                                <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs text-gray-200">
                                    <div className="flex justify-between items-center mb-4">
                                        <h3 className="font-semibold text-white">Trading Logic Logs</h3>
                                        <button
                                            onClick={() => {
                                                const form = document.querySelector('form');
                                                if (form) form.requestSubmit();
                                            }}
                                            className="text-xs text-aquamarine-400 hover:text-aquamarine-300 flex items-center gap-1"
                                        >
                                            <RefreshCw size={12} /> Refresh
                                        </button>
                                    </div>

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
                                                                <span className="font-bold">{tx.ticker}</span>
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
                                                                    <span className="font-bold">{row.ticker}</span>
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
// Simple Icon Component (internal to avoid extra deps if lucide not imported or mismatch)
const HistoryIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 12" />
        <path d="M3 3v9h9" />
        <path d="M12 7v5l4 2" />
    </svg>
);

export default LivePortfolio;
