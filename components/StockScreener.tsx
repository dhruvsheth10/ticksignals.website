import { useState, useEffect, useMemo, useCallback } from 'react';
import {
    SlidersHorizontal, TrendingUp, ArrowUpDown, ArrowUp, ArrowDown,
    RefreshCw, Download, ChevronDown, ChevronUp, Search, Zap,
    DollarSign, BarChart3, Percent, Building2, X
} from 'lucide-react';

interface StockData {
    ticker: string;
    price: number | null;
    market_cap: number | null;
    pe_ratio: number | null;
    roe_pct: number | null;
    debt_to_equity: number | null;
    gross_margin_pct: number | null;
    dividend_yield_pct: number | null;
    roa_pct: number | null;
    total_revenue: number | null;
    revenue_per_employee: number | null;
    sector: string | null;
    industry: string | null;
    company_name: string | null;
    fifty_two_week_high: number | null;
    fifty_two_week_low: number | null;
    beta: number | null;
    updated_at: string;
}

interface FilterConfig {
    minPrice: number | '';
    maxPrice: number | '';
    minMarketCap: number | '';
    maxMarketCap: number | '';
    minPE: number | '';
    maxPE: number | '';
    minROE: number | '';
    maxROE: number | '';
    minDE: number | '';
    maxDE: number | '';
    minGrossMargin: number | '';
    maxGrossMargin: number | '';
    minDividendYield: number | '';
    maxDividendYield: number | '';
    minROA: number | '';
    maxROA: number | '';
    sector: string;
    searchQuery: string;
}

const EMPTY_FILTERS: FilterConfig = {
    minPrice: '', maxPrice: '',
    minMarketCap: '', maxMarketCap: '',
    minPE: '', maxPE: '',
    minROE: '', maxROE: '',
    minDE: '', maxDE: '',
    minGrossMargin: '', maxGrossMargin: '',
    minDividendYield: '', maxDividendYield: '',
    minROA: '', maxROA: '',
    sector: '',
    searchQuery: '',
};

const DEFAULT_FILTERS: FilterConfig = {
    minPrice: '', maxPrice: '',
    minMarketCap: 2000000000, maxMarketCap: '',
    minPE: '', maxPE: 20,
    minROE: 10, maxROE: '',
    minDE: '', maxDE: 100,
    minGrossMargin: '', maxGrossMargin: '',
    minDividendYield: '', maxDividendYield: '',
    minROA: '', maxROA: '',
    sector: '',
    searchQuery: '',
};

// Preset filter configurations
const PRESETS: { name: string; icon: any; desc: string; filters: Partial<FilterConfig> }[] = [
    {
        name: 'Value Picks',
        icon: DollarSign,
        desc: 'Low P/E, solid fundamentals',
        filters: { minMarketCap: 2e9, maxPE: 20, minROE: 10, maxDE: 100 },
    },
    {
        name: 'Growth Stocks',
        icon: TrendingUp,
        desc: 'High ROE, strong margins',
        filters: { minMarketCap: 5e9, minROE: 20, minGrossMargin: 40 },
    },
    {
        name: 'Dividend Plays',
        icon: Percent,
        desc: 'High yield, low debt',
        filters: { minDividendYield: 2, maxDE: 150, minMarketCap: 1e9 },
    },
    {
        name: 'Large Cap Safe',
        icon: Building2,
        desc: 'Market cap > $50B',
        filters: { minMarketCap: 50e9, maxDE: 200 },
    },
];

type SortKey = keyof StockData;
type SortDir = 'asc' | 'desc';



interface StockScreenerProps {
    onTickerClick?: (ticker: string) => void;
}

export default function StockScreener({ onTickerClick }: StockScreenerProps) {
    const [stocks, setStocks] = useState<StockData[]>([]);
    const [loading, setLoading] = useState(true);
    const [scanning, setScanning] = useState(false);
    const [scanResult, setScanResult] = useState<string>('');
    const [lastUpdated, setLastUpdated] = useState<string | null>(null);
    const [filters, setFilters] = useState<FilterConfig>(EMPTY_FILTERS);
    const [sortKey, setSortKey] = useState<SortKey>('ticker');
    const [sortDir, setSortDir] = useState<SortDir>('asc');
    const [filtersOpen, setFiltersOpen] = useState(true);
    const [activeSectors, setActiveSectors] = useState<string[]>([]);

    // Fetch cached data on mount
    useEffect(() => {
        fetchData();
    }, []);

    // Extract unique sectors
    useEffect(() => {
        const sectors = [...new Set(stocks.map(s => s.sector).filter(Boolean))] as string[];
        setActiveSectors(sectors.sort());
    }, [stocks]);

    const fetchData = async () => {
        setLoading(true);
        try {
            const response = await fetch('/api/screener');
            const data = await response.json();
            setStocks(data.stocks || []);
            setLastUpdated(data.lastUpdated);
        } catch (error) {
            console.error('Failed to fetch screener data:', error);
        } finally {
            setLoading(false);
        }
    };

    const runScreener = async () => {
        const password = window.prompt("Enter admin password to run scan:");
        if (password === null) return; // User cancelled

        setScanning(true);
        setScanResult('Initializing...');
        try {
            const response = await fetch('/api/screener', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });
            const data = await response.json();

            if (response.ok && data.success) {
                setScanResult(`✓ ${data.processed} stocks scanned in ${data.durationSeconds}s`);
                await fetchData();
            } else {
                const errorMsg = data.details || data.error || 'Scan failed';
                setScanResult(`Error: ${errorMsg}`);
                console.error('Scan failed:', data);
            }
        } catch (error: any) {
            setScanResult(`Error: ${error.message}`);
            console.error('Scan error:', error);
        } finally {
            setScanning(false);
        }
    };

    // Apply filters
    const passesFilter = useCallback((stock: StockData): boolean => {
        const f = filters;

        // Search query
        if (f.searchQuery) {
            const q = f.searchQuery.toLowerCase();
            const matchesTicker = stock.ticker.toLowerCase().includes(q);
            const matchesName = stock.company_name?.toLowerCase().includes(q);
            if (!matchesTicker && !matchesName) return false;
        }

        // Sector filter
        if (f.sector && stock.sector !== f.sector) return false;

        // Numeric range filters
        const rangeCheck = (val: number | null, min: number | '', max: number | ''): boolean => {
            if (val === null) return true; // Don't exclude stocks with missing data
            if (min !== '' && val < min) return false;
            if (max !== '' && val > max) return false;
            return true;
        };

        if (!rangeCheck(stock.price, f.minPrice, f.maxPrice)) return false;
        if (!rangeCheck(stock.market_cap, f.minMarketCap, f.maxMarketCap)) return false;
        if (!rangeCheck(stock.pe_ratio, f.minPE, f.maxPE)) return false;
        if (!rangeCheck(stock.roe_pct, f.minROE, f.maxROE)) return false;
        if (!rangeCheck(stock.debt_to_equity, f.minDE, f.maxDE)) return false;
        if (!rangeCheck(stock.gross_margin_pct, f.minGrossMargin, f.maxGrossMargin)) return false;
        if (!rangeCheck(stock.dividend_yield_pct, f.minDividendYield, f.maxDividendYield)) return false;
        if (!rangeCheck(stock.roa_pct, f.minROA, f.maxROA)) return false;

        return true;
    }, [filters]);

    // Filtered and sorted stocks (numeric sort: nulls last; market_cap etc. as numbers)
    const filteredStocks = useMemo(() => {
        let result = stocks.filter(passesFilter);

        result.sort((a, b) => {
            const aVal = a[sortKey];
            const bVal = b[sortKey];

            if (aVal === null && bVal === null) return 0;
            if (aVal === null) return 1;
            if (bVal === null) return -1;

            if (typeof aVal === 'string' && typeof bVal === 'string') {
                // Check if these strings are actually numbers (like '100') which implies BigInt or similar
                const aNum = Number(aVal);
                const bNum = Number(bVal);

                // If both are valid numbers and not empty strings, sort numerically
                if (!isNaN(aNum) && !isNaN(bNum) && aVal.trim() !== '' && bVal.trim() !== '') {
                    return sortDir === 'asc' ? aNum - bNum : bNum - aNum;
                }

                return sortDir === 'asc'
                    ? aVal.localeCompare(bVal)
                    : bVal.localeCompare(aVal);
            }

            const numA = Number(aVal);
            const numB = Number(bVal);
            return sortDir === 'asc' ? numA - numB : numB - numA;
        });

        return result;
    }, [stocks, passesFilter, sortKey, sortDir]);

    const handleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(key);
            setSortDir('desc');
        }
    };

    const applyPreset = (preset: typeof PRESETS[0]) => {
        setFilters({ ...DEFAULT_FILTERS, ...preset.filters });
    };

    const resetFilters = () => {
        setFilters(EMPTY_FILTERS);
        setSortKey('ticker');
        setSortDir('asc');
    };

    const hasActiveFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

    // Check which preset is active
    const getActivePreset = () => {
        for (const preset of PRESETS) {
            const presetFilters = { ...EMPTY_FILTERS, ...preset.filters };
            if (JSON.stringify(filters) === JSON.stringify(presetFilters)) {
                return preset.name;
            }
        }
        return null;
    };

    // Format helpers
    const fmtPrice = (v: number | null) => v != null ? `$${v.toFixed(2)}` : '—';
    const fmtMcap = (v: number | null) => {
        if (v == null) return '—';
        if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
        if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
        if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
        return `$${v.toLocaleString()}`;
    };
    const fmtPct = (v: number | null) => v != null ? `${v.toFixed(1)}%` : '—';
    const fmtRatio = (v: number | null) => v != null ? v.toFixed(2) : '—';
    const fmtRevenue = (v: number | null) => {
        if (v == null) return '—';
        if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
        if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
        if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
        return `$${v.toLocaleString()}`;
    };
    const fmtRevPerEmp = (v: number | null) => {
        if (v == null) return '—';
        if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
        if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
        return `$${v.toFixed(0)}`;
    };

    // Color coding for metrics
    const metricColor = (key: string, val: number | null): string => {
        if (val == null) return 'text-gray-500';
        switch (key) {
            case 'pe_ratio': return val < 15 ? 'text-green-400' : val > 40 ? 'text-red-400' : 'text-gray-300';
            case 'roe_pct': return val > 20 ? 'text-green-400' : val < 5 ? 'text-red-400' : 'text-gray-300';
            case 'debt_to_equity': return val < 50 ? 'text-green-400' : val > 200 ? 'text-red-400' : 'text-gray-300';
            case 'gross_margin_pct': return val > 50 ? 'text-green-400' : val < 20 ? 'text-red-400' : 'text-gray-300';
            case 'dividend_yield_pct': return val > 3 ? 'text-green-400' : val > 0 ? 'text-gray-300' : 'text-gray-500';
            case 'roa_pct': return val > 10 ? 'text-green-400' : val < 2 ? 'text-red-400' : 'text-gray-300';
            default: return 'text-gray-300';
        }
    };

    const formatLastUpdated = (dateStr: string | null) => {
        if (!dateStr) return 'Never';
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMins = Math.floor(diffMs / (1000 * 60));

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHrs < 24) return `${diffHrs}h ago`;
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };

    const exportCSV = () => {
        const headers = ['Ticker', 'Company', 'Price', 'Market Cap', 'P/E', 'ROE %', 'D/E', 'Gross Margin %', 'Div Yield %', 'ROA %', 'Revenue', 'Rev/Employee', 'Sector', 'Industry'];
        const rows = filteredStocks.map(s => [
            s.ticker, s.company_name || '', s.price || '', s.market_cap || '', s.pe_ratio || '',
            s.roe_pct?.toFixed(1) || '', s.debt_to_equity?.toFixed(1) || '', s.gross_margin_pct?.toFixed(1) || '',
            s.dividend_yield_pct?.toFixed(2) || '', s.roa_pct?.toFixed(1) || '', s.total_revenue || '',
            s.revenue_per_employee?.toFixed(0) || '', s.sector || '', s.industry || ''
        ]);
        const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `stock-screener-${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };


    const SortHeader = ({ label, colKey, className = '' }: { label: string; colKey: SortKey; className?: string }) => (
        <th
            className={`text-left py-3 px-3 text-gray-400 font-medium text-xs uppercase tracking-wide cursor-pointer hover:text-aquamarine-400 transition-colors select-none ${className}`}
            onClick={() => handleSort(colKey)}
        >
            <div className="flex items-center gap-1">
                {label}
                {sortKey === colKey ? (
                    sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                ) : (
                    <ArrowUpDown size={10} className="opacity-30" />
                )}
            </div>
        </th>
    );

    return (
        <div className="space-y-4">
            {/* Top Control Bar */}
            <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                            <BarChart3 className="text-aquamarine-400" size={22} />
                            <h2 className="text-xl font-bold text-white">Stock Screener</h2>
                        </div>
                        <span className="text-sm text-gray-400">
                            {filteredStocks.length} of {stocks.length} stocks
                        </span>
                        {lastUpdated && (
                            <span className="text-xs text-gray-500 hidden sm:inline">
                                Updated {formatLastUpdated(lastUpdated)}
                            </span>
                        )}
                    </div>

                    <div className="flex items-center gap-2 w-full sm:w-auto">
                        {/* Search */}
                        <div className="relative flex-1 sm:flex-none">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={14} />
                            <input
                                type="text"
                                value={filters.searchQuery}
                                onChange={(e) => setFilters(prev => ({ ...prev, searchQuery: e.target.value }))}
                                placeholder="Search ticker..."
                                className="w-full sm:w-44 bg-gray-900/50 border border-gray-700/50 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-aquamarine-500/50 transition-all"
                            />
                        </div>

                        <button
                            onClick={() => setFiltersOpen(!filtersOpen)}
                            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all border ${hasActiveFilters
                                ? 'bg-aquamarine-500/10 border-aquamarine-500/30 text-aquamarine-400'
                                : 'bg-gray-800/50 border-gray-700/50 text-gray-400 hover:text-white'
                                }`}
                        >
                            <SlidersHorizontal size={14} />
                            <span className="hidden sm:inline">Filters</span>
                            {filtersOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>

                        <button
                            onClick={exportCSV}
                            disabled={filteredStocks.length === 0}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-gray-800/50 border border-gray-700/50 text-gray-400 hover:text-white transition-all disabled:opacity-40"
                            title="Export CSV"
                        >
                            <Download size={14} />
                        </button>

                        <button
                            onClick={runScreener}
                            disabled={scanning}
                            className="flex items-center gap-1.5 px-4 py-2 bg-aquamarine-600 text-white font-medium rounded-lg hover:bg-aquamarine-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                        >
                            <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
                            {scanning ? 'Scanning...' : 'Run Scan'}
                        </button>
                    </div>
                </div>

                {scanResult && (
                    <div className={`mt-3 text-sm px-3 py-2 rounded-lg ${scanResult.startsWith('Error')
                        ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                        : 'bg-green-500/10 text-green-400 border border-green-500/20'
                        }`}>
                        {scanResult}
                    </div>
                )}
            </div>

            {/* Filter Panel */}
            {filtersOpen && (
                <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 animate-slide-up">
                    {/* Presets */}
                    <div className="flex flex-wrap gap-2 mb-5">
                        {PRESETS.map((preset) => {
                            const Icon = preset.icon;
                            const isActive = getActivePreset() === preset.name;
                            return (
                                <button
                                    key={preset.name}
                                    onClick={() => applyPreset(preset)}
                                    className={`group flex items-center gap-2 px-3 py-2 rounded-lg border transition-all ${isActive
                                        ? 'bg-aquamarine-500/10 border-aquamarine-500/40 text-aquamarine-300'
                                        : 'bg-gray-800/50 border-gray-700/30 hover:border-aquamarine-500/30 hover:bg-aquamarine-500/5'
                                        }`}
                                    title={preset.desc}
                                >
                                    <Icon size={14} className={`transition-opacity ${isActive ? 'text-aquamarine-400 opacity-100' : 'text-aquamarine-400 opacity-60 group-hover:opacity-100'
                                        }`} />
                                    <span className={`text-xs font-medium transition-colors ${isActive ? 'text-aquamarine-200' : 'text-gray-300 group-hover:text-white'
                                        }`}>{preset.name}</span>
                                </button>
                            );
                        })}
                        {hasActiveFilters && (
                            <button
                                onClick={resetFilters}
                                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/20 text-red-400 hover:bg-red-500/10 transition-all text-xs font-medium"
                            >
                                <X size={12} />
                                Clear All
                            </button>
                        )}
                    </div>

                    {/* Filter Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                        <FilterInput
                            label="Min Price"
                            value={filters.minPrice}
                            onChange={(v) => setFilters(prev => ({ ...prev, minPrice: v }))}
                            placeholder="0" prefix="$"
                        />
                        <FilterInput
                            label="Max Price"
                            value={filters.maxPrice}
                            onChange={(v) => setFilters(prev => ({ ...prev, maxPrice: v }))}
                            placeholder="∞" prefix="$"
                        />
                        <FilterInput
                            label="Min Market Cap"
                            value={filters.minMarketCap}
                            onChange={(v) => setFilters(prev => ({ ...prev, minMarketCap: v }))}
                            placeholder="e.g. 2B"
                            isCompact={true}
                        />
                        <FilterInput
                            label="Max Market Cap"
                            value={filters.maxMarketCap}
                            onChange={(v) => setFilters(prev => ({ ...prev, maxMarketCap: v }))}
                            placeholder="e.g. 500B"
                            isCompact={true}
                        />
                        <FilterInput label="Min P/E" value={filters.minPE} onChange={(v) => setFilters(prev => ({ ...prev, minPE: v }))} placeholder="0" />
                        <FilterInput label="Max P/E" value={filters.maxPE} onChange={(v) => setFilters(prev => ({ ...prev, maxPE: v }))} placeholder="∞" />
                        <FilterInput label="Min ROE %" value={filters.minROE} onChange={(v) => setFilters(prev => ({ ...prev, minROE: v }))} placeholder="0" />
                        <FilterInput label="Max ROE %" value={filters.maxROE} onChange={(v) => setFilters(prev => ({ ...prev, maxROE: v }))} placeholder="∞" />
                        <FilterInput label="Min D/E" value={filters.minDE} onChange={(v) => setFilters(prev => ({ ...prev, minDE: v }))} placeholder="0" />
                        <FilterInput label="Max D/E" value={filters.maxDE} onChange={(v) => setFilters(prev => ({ ...prev, maxDE: v }))} placeholder="∞" />
                        <FilterInput label="Min Gross Margin %" value={filters.minGrossMargin} onChange={(v) => setFilters(prev => ({ ...prev, minGrossMargin: v }))} placeholder="0" />
                        <FilterInput label="Max Gross Margin %" value={filters.maxGrossMargin} onChange={(v) => setFilters(prev => ({ ...prev, maxGrossMargin: v }))} placeholder="∞" />
                        <FilterInput label="Min Div Yield %" value={filters.minDividendYield} onChange={(v) => setFilters(prev => ({ ...prev, minDividendYield: v }))} placeholder="0" />
                        <FilterInput label="Max Div Yield %" value={filters.maxDividendYield} onChange={(v) => setFilters(prev => ({ ...prev, maxDividendYield: v }))} placeholder="∞" />
                        <FilterInput label="Min ROA %" value={filters.minROA} onChange={(v) => setFilters(prev => ({ ...prev, minROA: v }))} placeholder="0" />
                        <FilterInput label="Max ROA %" value={filters.maxROA} onChange={(v) => setFilters(prev => ({ ...prev, maxROA: v }))} placeholder="∞" />

                        {/* Sector Select */}
                        <div className="flex flex-col gap-1 col-span-2">
                            <label className="text-xs text-gray-400 font-medium">Sector</label>
                            <select
                                value={filters.sector}
                                onChange={(e) => setFilters(prev => ({ ...prev, sector: e.target.value }))}
                                className="w-full bg-gray-900/60 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-aquamarine-500/50 transition-all"
                            >
                                <option value="">All Sectors</option>
                                {activeSectors.map(s => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>
            )}

            {/* Results Table */}
            <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
                {loading ? (
                    <div className="text-center py-16">
                        <div className="inline-block animate-spin rounded-full h-10 w-10 border-b-2 border-aquamarine-400"></div>
                        <p className="text-gray-400 mt-4">Loading data...</p>
                    </div>
                ) : filteredStocks.length === 0 ? (
                    <div className="text-center py-16">
                        <BarChart3 className="mx-auto text-gray-600 mb-3" size={40} />
                        <p className="text-gray-400 mb-1">
                            {stocks.length === 0 ? 'No data available yet' : 'No stocks match your filters'}
                        </p>
                        <p className="text-gray-500 text-sm">
                            {stocks.length === 0
                                ? 'Click "Run Scan" to fetch stock data'
                                : 'Try adjusting your filter criteria'}
                        </p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[900px]">
                            <thead>
                                <tr className="border-b border-gray-700/50 bg-gray-900/30">
                                    <SortHeader label="Ticker" colKey="ticker" className="sticky left-0 bg-gray-900 z-10 text-center pl-4" />
                                    <SortHeader label="Price" colKey="price" />
                                    <SortHeader label="Mkt Cap" colKey="market_cap" />
                                    <SortHeader label="P/E" colKey="pe_ratio" />
                                    <SortHeader label="ROE %" colKey="roe_pct" />
                                    <SortHeader label="D/E" colKey="debt_to_equity" />
                                    <SortHeader label="Gross M %" colKey="gross_margin_pct" />
                                    <SortHeader label="Div Yld %" colKey="dividend_yield_pct" />
                                    <SortHeader label="ROA %" colKey="roa_pct" />
                                    <SortHeader label="Revenue" colKey="total_revenue" />
                                    <SortHeader label="Rev/Emp" colKey="revenue_per_employee" />
                                    <th className="text-left py-3 px-3 text-gray-400 font-medium text-xs uppercase tracking-wide">Sector</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredStocks.map((stock, idx) => (
                                    <tr
                                        key={stock.ticker}
                                        className={`border-b border-gray-800/30 hover:bg-gray-700/20 transition-colors ${idx % 2 === 0 ? 'bg-gray-800/10' : ''
                                            }`}
                                    >
                                        <td className="py-2.5 px-3 sticky left-0 bg-gray-900 z-10 text-center">
                                            <button
                                                onClick={() => onTickerClick?.(stock.ticker)}
                                                className="group flex flex-col items-center justify-center w-full"
                                            >
                                                <span className="font-bold text-aquamarine-400 group-hover:text-aquamarine-300 transition-colors text-sm">
                                                    {stock.ticker}
                                                </span>
                                                <span className="text-[10px] text-gray-500 max-w-[120px] truncate">
                                                    {stock.company_name}
                                                </span>
                                            </button>
                                        </td>
                                        <td className="py-2.5 px-3 text-white font-mono text-sm">{fmtPrice(stock.price)}</td>
                                        <td className="py-2.5 px-3 text-gray-300 text-sm">{fmtMcap(stock.market_cap)}</td>
                                        <td className={`py-2.5 px-3 text-sm font-mono ${metricColor('pe_ratio', stock.pe_ratio)}`}>
                                            {fmtRatio(stock.pe_ratio)}
                                        </td>
                                        <td className={`py-2.5 px-3 text-sm font-mono ${metricColor('roe_pct', stock.roe_pct)}`}>
                                            {fmtPct(stock.roe_pct)}
                                        </td>
                                        <td className={`py-2.5 px-3 text-sm font-mono ${metricColor('debt_to_equity', stock.debt_to_equity)}`}>
                                            {fmtRatio(stock.debt_to_equity)}
                                        </td>
                                        <td className={`py-2.5 px-3 text-sm font-mono ${metricColor('gross_margin_pct', stock.gross_margin_pct)}`}>
                                            {fmtPct(stock.gross_margin_pct)}
                                        </td>
                                        <td className={`py-2.5 px-3 text-sm font-mono ${metricColor('dividend_yield_pct', stock.dividend_yield_pct)}`}>
                                            {fmtPct(stock.dividend_yield_pct)}
                                        </td>
                                        <td className={`py-2.5 px-3 text-sm font-mono ${metricColor('roa_pct', stock.roa_pct)}`}>
                                            {fmtPct(stock.roa_pct)}
                                        </td>
                                        <td className="py-2.5 px-3 text-gray-300 text-sm">{fmtRevenue(stock.total_revenue)}</td>
                                        <td className="py-2.5 px-3 text-gray-300 text-sm">{fmtRevPerEmp(stock.revenue_per_employee)}</td>
                                        <td className="py-2.5 px-3">
                                            <span className="text-xs text-gray-500 max-w-[100px] truncate block">{stock.sector || '—'}</span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

// Format compact numbers (e.g. 1.5B, 200M)
const formatCompactNumber = (number: number | string) => {
    if (number === '' || number === null || number === undefined) return '';
    const num = Number(number);
    if (isNaN(num)) return number.toString();
    if (num >= 1e12) return +(num / 1e12).toFixed(2) + 'T';
    if (num >= 1e9) return +(num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return +(num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return +(num / 1e3).toFixed(2) + 'K';
    return num.toString();
};

const parseCompactNumber = (text: string) => {
    if (!text) return '';
    const clean = text.toString().toUpperCase().replace(/[^0-9.KMBT]/g, '');
    const multiplier = clean.endsWith('T') ? 1e12 :
        clean.endsWith('B') ? 1e9 :
            clean.endsWith('M') ? 1e6 :
                clean.endsWith('K') ? 1e3 : 1;
    const num = parseFloat(clean);
    if (isNaN(num)) return '';
    return num * multiplier;
};

// Reusable filter input (outside component to prevent focus loss)
const FilterInput = ({
    label,
    value,
    onChange,
    placeholder,
    prefix,
    isCompact
}: {
    label: string;
    value: number | string;
    onChange: (val: number | '') => void;
    placeholder: string;
    prefix?: string;
    isCompact?: boolean;
}) => {
    const [localVal, setLocalVal] = useState(
        value === '' ? '' :
            isCompact ? formatCompactNumber(value) : String(value)
    );

    // Sync with external value changes (e.g. reset or presets)
    useEffect(() => {
        const formatted = value === '' ? '' : isCompact ? formatCompactNumber(value) : String(value);
        setLocalVal(formatted);
    }, [value, isCompact]);

    const handleBlur = () => {
        let newVal: number | '' = localVal as (number | '');
        if (isCompact) {
            const parsed = parseCompactNumber(localVal.toString());
            if (parsed !== '') {
                newVal = parsed;
                setLocalVal(formatCompactNumber(parsed));
            } else {
                newVal = '';
                setLocalVal('');
            }
        } else {
            const num = parseFloat(localVal.toString());
            if (localVal !== '' && !isNaN(num)) {
                newVal = num;
            } else {
                newVal = '';
            }
        }

        onChange(newVal);
    };

    return (
        <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400 font-medium">{label}</label>
            <div className="relative">
                {prefix && (
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-xs">{prefix}</span>
                )}
                <input
                    type="text"
                    value={localVal}
                    onChange={(e) => setLocalVal(e.target.value)}
                    onBlur={handleBlur}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            handleBlur();
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    placeholder={placeholder}
                    className={`w-full bg-gray-900/60 border border-gray-700/50 rounded-lg ${prefix ? 'pl-6' : 'pl-3'} pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-aquamarine-500/50 focus:border-aquamarine-500/50 transition-all`}
                />
            </div>
        </div>
    );
};

