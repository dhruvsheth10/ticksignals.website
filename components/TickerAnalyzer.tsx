import { useState, useEffect } from 'react';
import {
  Search, DollarSign, Activity, AlertCircle, BarChart3,
  TrendingUp, Percent, Building2, Users, Globe
} from 'lucide-react';
import dynamic from 'next/dynamic';

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false });

interface TickerAnalyzerProps {
  initialTicker?: string;
}

export default function TickerAnalyzer({ initialTicker }: TickerAnalyzerProps) {
  const [ticker, setTicker] = useState(initialTicker || '');
  const [loading, setLoading] = useState(false);
  const [stockData, setStockData] = useState<any>(null);
  const [error, setError] = useState('');

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

  const MetricCard = ({ icon: Icon, label, value, color = 'text-white' }: {
    icon: any; label: string; value: string; color?: string;
  }) => (
    <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50 hover:border-gray-600/50 transition-all">
      <div className="flex items-center gap-2 text-gray-400 text-xs mb-1.5">
        <Icon size={14} />
        <span>{label}</span>
      </div>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Search Bar */}
      <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-5 border border-gray-700/50">
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && analyzeStock()}
              placeholder="Enter ticker symbol (e.g. AAPL)"
              className="w-full bg-gray-900/50 border border-gray-700 rounded-lg pl-11 pr-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-aquamarine-500 focus:border-transparent transition-all"
            />
          </div>
          <button
            onClick={() => analyzeStock()}
            disabled={loading || !ticker}
            className="px-6 py-3 bg-gradient-to-r from-aquamarine-600 to-cyan-600 text-white font-medium rounded-lg hover:from-aquamarine-500 hover:to-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-aquamarine-500/30"
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

          {/* Price Chart */}
          <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-5 border border-gray-700/50">
            <h3 className="text-lg font-bold text-white mb-3">Price Chart</h3>
            <div className="bg-gray-900/50 rounded-lg p-2 -mx-2">
              <Plot
                data={stockData.chart.data}
                layout={{
                  ...stockData.chart.layout,
                  paper_bgcolor: 'rgba(17, 24, 39, 0)',
                  plot_bgcolor: 'rgba(17, 24, 39, 0)',
                  font: { color: '#9CA3AF', family: 'Inter, sans-serif', size: 12 },
                  xaxis: {
                    ...stockData.chart.layout?.xaxis,
                    gridcolor: '#374151',
                    showgrid: true,
                    zeroline: false,
                    showspikes: true,
                    spikecolor: '#14b8a6',
                    spikethickness: 1.5,
                    spikemode: 'toaxis' as const,
                    spikedash: 'solid' as const,
                  },
                  yaxis: {
                    ...stockData.chart.layout?.yaxis,
                    gridcolor: '#374151',
                    showgrid: true,
                    zeroline: false,
                    showspikes: false,
                    autorange: true,
                  },
                  margin: { l: 60, r: 30, t: 30, b: 60 },
                  hovermode: 'x unified' as const,
                  dragmode: 'pan' as const,
                  hoverlabel: {
                    bgcolor: 'rgba(17, 24, 39, 0.95)',
                    bordercolor: '#14b8a6',
                    font: { color: '#F3F4F6', family: 'Inter, sans-serif', size: 11 },
                    align: 'left' as const,
                    namelength: -1,
                  },
                  showlegend: true,
                  legend: {
                    x: 1, y: 0, xanchor: 'right' as const, yanchor: 'bottom' as const,
                    bgcolor: 'rgba(17, 24, 39, 0.8)',
                    bordercolor: '#374151', borderwidth: 1,
                    font: { color: '#9CA3AF', family: 'Inter, sans-serif', size: 11 },
                  },
                }}
                config={{
                  responsive: true,
                  displayModeBar: false,
                  displaylogo: false,
                  scrollZoom: true,
                  doubleClick: 'reset' as const,
                }}
                style={{ width: '100%', height: '500px' }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}