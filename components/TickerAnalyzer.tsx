import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Search, DollarSign, Activity, AlertCircle, BarChart3,
  TrendingUp, Percent, Building2, Users, Globe
} from 'lucide-react';
import BlurText from './BlurText';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
interface ChartPoint {
  date: string;
  close: number;
}

interface StockData {
  ticker: string;
  companyName: string;
  price: string;
  previousClose: number | null;
  marketCap: string;
  volume: string;
  peRatio: string;
  fundamentals: Record<string, string>;
  chart: {
    dates: string[];
    closes: (number | null)[];
    opens: (number | null)[];
    highs: (number | null)[];
    lows: (number | null)[];
    volumes: (number | null)[];
  };
}

type RangeKey = '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | '5Y' | 'ALL';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: '1W', label: '1W' },
  { key: '1M', label: '1M' },
  { key: '3M', label: '3M' },
  { key: '6M', label: '6M' },
  { key: 'YTD', label: 'YTD' },
  { key: '1Y', label: '1Y' },
  { key: '5Y', label: '5Y' },
  { key: 'ALL', label: 'ALL' },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function sliceByRange(points: ChartPoint[], range: RangeKey): ChartPoint[] {
  if (range === 'ALL' || points.length === 0) return points;
  const now = new Date();
  let cutoff: Date;
  switch (range) {
    case '1W': cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7); break;
    case '1M': cutoff = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()); break;
    case '3M': cutoff = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); break;
    case '6M': cutoff = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()); break;
    case 'YTD': cutoff = new Date(now.getFullYear(), 0, 1); break;
    case '1Y': cutoff = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()); break;
    case '5Y': cutoff = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate()); break;
    default: return points;
  }
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const idx = points.findIndex(p => p.date >= cutoffStr);
  return idx >= 0 ? points.slice(idx) : points.slice(-5);
}

function formatDateLabel(dateStr: string, range: RangeKey): string {
  const d = new Date(dateStr + 'T12:00:00');
  if (range === '1W' || range === '1M') {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  if (range === '3M' || range === '6M' || range === 'YTD' || range === '1Y') {
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function formatHoverDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPrice(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------------ */
/*  Canvas Chart Component                                             */
/* ------------------------------------------------------------------ */
function PriceChart({ points, range, accentColor }: { points: ChartPoint[]; range: RangeKey; accentColor: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; point: ChartPoint; idx: number } | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 400 });

  // Margins
  const margin = { top: 20, right: 70, bottom: 36, left: 16 };

  // Responsive sizing
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width } = entries[0].contentRect;
      setDims({ w: width, h: Math.max(320, Math.min(460, width * 0.5)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute scales
  const prices = useMemo(() => points.map(p => p.close), [points]);
  const minPrice = useMemo(() => Math.min(...prices), [prices]);
  const maxPrice = useMemo(() => Math.max(...prices), [prices]);

  const plotW = dims.w - margin.left - margin.right;
  const plotH = dims.h - margin.top - margin.bottom;

  const priceRange = maxPrice - minPrice || 1;
  const pricePad = priceRange * 0.08;
  const yMin = Math.max(0, minPrice - pricePad);
  const yMax = maxPrice + pricePad;

  const xScale = useCallback((i: number) => margin.left + (i / Math.max(points.length - 1, 1)) * plotW, [points.length, plotW, margin.left]);
  const yScale = useCallback((v: number) => margin.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH, [plotH, yMin, yMax, margin.top]);

  // Draw chart
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs || points.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = dims.w * dpr;
    cvs.height = dims.h * dpr;
    cvs.style.width = dims.w + 'px';
    cvs.style.height = dims.h + 'px';
    const ctx = cvs.getContext('2d')!;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.clearRect(0, 0, dims.w, dims.h);

    // Horizontal grid lines + Y labels
    const yTicks = 5;
    ctx.strokeStyle = 'rgba(55, 65, 81, 0.5)';
    ctx.lineWidth = 0.5;
    ctx.fillStyle = '#6B7280';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= yTicks; i++) {
      const val = yMin + ((yMax - yMin) * i) / yTicks;
      const y = yScale(val);
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText('$' + val.toFixed(2), dims.w - 6, y + 4);
    }

    // X labels
    const xLabelCount = dims.w < 500 ? 4 : 6;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#6B7280';
    const step = Math.max(1, Math.floor(points.length / xLabelCount));
    for (let i = 0; i < points.length; i += step) {
      const x = xScale(i);
      ctx.fillText(formatDateLabel(points[i].date, range), x, dims.h - 8);
    }

    // Price line
    ctx.beginPath();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 0; i < points.length; i++) {
      const x = xScale(i);
      const y = yScale(points[i].close);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Gradient fill under line
    const grad = ctx.createLinearGradient(0, margin.top, 0, margin.top + plotH);
    grad.addColorStop(0, accentColor + '30');
    grad.addColorStop(1, accentColor + '00');
    ctx.lineTo(xScale(points.length - 1), margin.top + plotH);
    ctx.lineTo(xScale(0), margin.top + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }, [points, dims, accentColor, range, xScale, yScale, yMin, yMax, plotW, plotH, margin.left, margin.top]);

  // Mouse / touch — fractional index so price/date update smoothly along X (not jump per candle)
  const handlePointer = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const cvs = canvasRef.current;
    if (!cvs || points.length < 2) return;
    const rect = cvs.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const relX = clientX - rect.left;
    const fIdx = ((relX - margin.left) / plotW) * (points.length - 1);
    const clampedF = Math.max(0, Math.min(points.length - 1, fIdx));
    const i0 = Math.floor(clampedF);
    const i1 = Math.min(points.length - 1, i0 + 1);
    const u = clampedF - i0;
    const closeInterp = points[i0].close + (points[i1].close - points[i0].close) * u;
    const t0 = new Date(points[i0].date).getTime();
    const t1 = new Date(points[i1].date).getTime();
    const dateMs = t0 + (t1 - t0) * u;
    const px = margin.left + (clampedF / Math.max(points.length - 1, 1)) * plotW;
    const py = yScale(closeInterp);
    const nearestIdx = u < 0.5 ? i0 : i1;
    setHoverInfo({
      x: px,
      y: py,
      point: { date: new Date(dateMs).toISOString(), close: closeInterp },
      idx: nearestIdx,
    });
  }, [points, plotW, margin.left, yScale]);

  const handleLeave = useCallback(() => setHoverInfo(null), []);

  // Compute period change
  const firstClose = points.length > 0 ? points[0].close : 0;
  const lastClose = points.length > 0 ? points[points.length - 1].close : 0;
  const hoverClose = hoverInfo ? hoverInfo.point.close : lastClose;
  const change = hoverClose - firstClose;
  const changePct = firstClose > 0 ? (change / firstClose) * 100 : 0;
  const isPositive = change >= 0;

  return (
    <div ref={containerRef} className="relative select-none" style={{ touchAction: 'none' }}>
      {/* Hover price header */}
      <div className="flex items-baseline gap-3 mb-2 min-h-[28px]">
        <span className="text-2xl font-bold text-white">
          {hoverInfo ? formatPrice(hoverInfo.point.close) : formatPrice(lastClose)}
        </span>
        <span className={`text-sm font-semibold ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
          {isPositive ? '+' : ''}{change.toFixed(2)} ({isPositive ? '+' : ''}{changePct.toFixed(2)}%)
        </span>
        {hoverInfo && (
          <span className="text-xs text-gray-500 ml-auto">{formatHoverDate(hoverInfo.point.date)}</span>
        )}
      </div>

      {/* Canvas */}
      <div className="relative">
        <canvas
          ref={canvasRef}
          onMouseMove={handlePointer}
          onTouchMove={handlePointer}
          onMouseLeave={handleLeave}
          onTouchEnd={handleLeave}
          className="w-full cursor-crosshair"
          style={{ height: dims.h }}
        />

        {/* Crosshair overlay */}
        {hoverInfo && (
          <div className="pointer-events-none absolute inset-0">
            {/* Vertical line */}
            <div
              className="absolute top-0"
              style={{
                left: hoverInfo.x,
                top: margin.top,
                height: plotH,
                width: 1,
                background: 'rgba(156, 163, 175, 0.4)',
              }}
            />
            {/* Dot */}
            <div
              className="absolute rounded-full border-2"
              style={{
                left: hoverInfo.x - 5,
                top: hoverInfo.y - 5,
                width: 10,
                height: 10,
                backgroundColor: accentColor,
                borderColor: '#111827',
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main TickerAnalyzer Component                                      */
/* ------------------------------------------------------------------ */
interface TickerAnalyzerProps {
  initialTicker?: string;
}

export default function TickerAnalyzer({ initialTicker }: TickerAnalyzerProps) {
  const [ticker, setTicker] = useState(initialTicker || '');
  const [loading, setLoading] = useState(false);
  const [stockData, setStockData] = useState<StockData | null>(null);
  const [error, setError] = useState('');
  const [activeRange, setActiveRange] = useState<RangeKey>('1Y');

  const analyzeStock = async (tickerToAnalyze?: string) => {
    const tickerValue = tickerToAnalyze || ticker;
    if (!tickerValue) return;

    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: tickerValue.toUpperCase() }),
      });

      if (!response.ok) throw new Error('Failed to analyze stock');

      const data = await response.json();
      setStockData(data);
    } catch (err: any) {
      setError(err.message || 'Failed to analyze stock');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialTicker) {
      setTicker(initialTicker);
      analyzeStock(initialTicker);
    }
  }, [initialTicker]);

  // Build clean points array (filter nulls)
  const allPoints: ChartPoint[] = useMemo(() => {
    if (!stockData) return [];
    const pts: ChartPoint[] = [];
    for (let i = 0; i < stockData.chart.dates.length; i++) {
      const c = stockData.chart.closes[i];
      if (c != null && !isNaN(c)) {
        pts.push({ date: stockData.chart.dates[i], close: c });
      }
    }
    return pts;
  }, [stockData]);

  const displayPoints = useMemo(() => sliceByRange(allPoints, activeRange), [allPoints, activeRange]);

  // Determine chart colour based on period performance
  const accentColor = useMemo(() => {
    if (displayPoints.length < 2) return '#14b8a6';
    return displayPoints[displayPoints.length - 1].close >= displayPoints[0].close
      ? '#10b981'  // green
      : '#ef4444'; // red
  }, [displayPoints]);

  const MetricCard = ({ icon: Icon, label, value, color = 'text-white' }: {
    icon: any; label: string; value: string; color?: string;
  }) => (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 hover:border-gray-600 transition-colors">
      <div className="flex items-center gap-2 text-gray-400 text-xs mb-1.5">
        <Icon size={14} />
        <span>{label}</span>
      </div>
      <div className={`text-lg font-bold flex ${color}`}>
        <BlurText text={value} delay={50} />
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Search Bar */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && analyzeStock()}
              placeholder="Enter company symbol"
              className="w-full bg-gray-900/50 border border-gray-700 rounded-lg pl-11 pr-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-aquamarine-500 focus:border-transparent transition-all"
            />
          </div>
          <button
            onClick={() => analyzeStock()}
            disabled={loading || !ticker}
            className="px-6 py-3 bg-aquamarine-600 text-white font-medium rounded-lg hover:bg-aquamarine-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Analyzing...' : 'Analyze'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/50 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="text-red-400" size={20} />
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {/* Results */}
      {stockData && (
        <>
          {/* Company header */}
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-2xl font-bold text-white">{stockData.ticker}</h2>
            <span className="text-gray-400 text-sm">{stockData.companyName}</span>
          </div>

          {/* Price Chart */}
          <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
            {displayPoints.length > 1 ? (
              <>
                <PriceChart points={displayPoints} range={activeRange} accentColor={accentColor} />

                {/* Range buttons */}
                <div className="flex items-center gap-1 mt-4 pt-3 border-t border-gray-700/30">
                  {RANGES.map(r => (
                    <button
                      key={r.key}
                      onClick={() => setActiveRange(r.key)}
                      className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-all ${activeRange === r.key
                        ? 'bg-gray-700 text-white'
                        : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/60'
                        }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-gray-500 text-center py-10">No chart data available for this range.</p>
            )}
          </div>

          {/* Top Metrics Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard icon={DollarSign} label="Price" value={stockData.price} />
            <MetricCard icon={Activity} label="Market Cap" value={stockData.marketCap} />
            <MetricCard icon={TrendingUp} label="Volume" value={stockData.volume} />
            <MetricCard icon={BarChart3} label="P/E Ratio" value={stockData.peRatio} />
          </div>

          {/* Fundamentals Grid */}
          {stockData.fundamentals && (
            <div>
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Fundamentals</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                <MetricCard icon={Percent} label="ROE" value={stockData.fundamentals.roe} />
                <MetricCard icon={Percent} label="ROA" value={stockData.fundamentals.roa} />
                <MetricCard icon={BarChart3} label="Debt/Equity" value={stockData.fundamentals.debtToEquity} />
                <MetricCard icon={Percent} label="Gross Margin" value={stockData.fundamentals.grossMargin} />
                <MetricCard icon={DollarSign} label="Div Yield" value={stockData.fundamentals.dividendYield} />
                <MetricCard icon={Activity} label="Beta" value={stockData.fundamentals.beta} />
                <MetricCard icon={DollarSign} label="Revenue" value={stockData.fundamentals.totalRevenue} />
                <MetricCard icon={Users} label="Rev/Employee" value={stockData.fundamentals.revenuePerEmployee} />
                <MetricCard icon={TrendingUp} label="52W High" value={stockData.fundamentals.fiftyTwoWeekHigh} />
                <MetricCard icon={TrendingUp} label="52W Low" value={stockData.fundamentals.fiftyTwoWeekLow} />
                <MetricCard icon={Building2} label="Sector" value={stockData.fundamentals.sector} color="text-aquamarine-400" />
                <MetricCard icon={Globe} label="Industry" value={stockData.fundamentals.industry} color="text-cyan-400" />
                <MetricCard icon={Users} label="Employees" value={stockData.fundamentals.employees} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}