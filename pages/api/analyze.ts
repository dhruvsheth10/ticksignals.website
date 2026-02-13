import type { NextApiRequest, NextApiResponse } from 'next';
import { batchQuote, getQuoteSummary } from '../../lib/yahoo';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { ticker } = req.body;

    if (!ticker) {
      return res.status(400).json({ error: 'Ticker is required' });
    }

    const upperTicker = ticker.toUpperCase();

    // Fetch quote + fundamentals in parallel using our raw Yahoo client
    const [quotes, fundamentals] = await Promise.all([
      batchQuote([upperTicker]),
      getQuoteSummary(upperTicker),
    ]);

    const quote = quotes[0];
    if (!quote) {
      return res.status(404).json({ error: `Ticker ${upperTicker} not found` });
    }

    // Fetch historical data for chart using yahoo-finance2 (chart endpoint works)
    // We'll use raw fetch for this too
    const endDate = Math.floor(Date.now() / 1000);
    const startDate = endDate - (10 * 365.25 * 24 * 60 * 60); // 10 years
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${upperTicker}?period1=${Math.floor(startDate)}&period2=${endDate}&interval=1d`;

    const chartRes = await fetch(chartUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    const chartData = await chartRes.json();

    const chartResult = chartData.chart?.result?.[0];
    const timestamps = chartResult?.timestamp || [];
    const closes = chartResult?.indicators?.quote?.[0]?.close || [];

    // Convert timestamps to dates
    const chartDates = timestamps.map((ts: number) => {
      const d = new Date(ts * 1000);
      return d.toISOString().split('T')[0];
    });

    // SMA calculations
    const calculateSMA = (prices: number[], period: number): number[] => {
      const sma: number[] = [];
      for (let i = 0; i < prices.length; i++) {
        if (i < period - 1) {
          sma.push(NaN);
        } else {
          let sum = 0, count = 0;
          for (let j = i - period + 1; j <= i; j++) {
            if (prices[j] != null) { sum += prices[j]; count++; }
          }
          sma.push(count > 0 ? sum / count : NaN);
        }
      }
      return sma;
    };

    const sma50 = calculateSMA(closes, 50);
    const sma200 = calculateSMA(closes, 200);

    // Format market cap
    const formatMarketCap = (value: number) => {
      if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
      return `${value.toLocaleString()}`;
    };

    const totalRevenue = fundamentals?.totalRevenue;
    const employees = fundamentals?.fullTimeEmployees;

    const responseData = {
      ticker: upperTicker,
      companyName: quote.shortName || quote.longName || upperTicker,
      price: `${quote.regularMarketPrice?.toFixed(2) || 'N/A'}`,
      marketCap: quote.marketCap ? formatMarketCap(quote.marketCap) : 'N/A',
      volume: (quote as any).regularMarketVolume ? (quote as any).regularMarketVolume.toLocaleString() : 'N/A',
      peRatio: quote.trailingPE ? quote.trailingPE.toFixed(2) : 'N/A',
      fundamentals: {
        roe: fundamentals?.returnOnEquity != null ? (fundamentals.returnOnEquity * 100).toFixed(1) + '%' : 'N/A',
        roa: fundamentals?.returnOnAssets != null ? (fundamentals.returnOnAssets * 100).toFixed(1) + '%' : 'N/A',
        debtToEquity: fundamentals?.debtToEquity != null ? fundamentals.debtToEquity.toFixed(1) : 'N/A',
        grossMargin: fundamentals?.grossMargins != null ? (fundamentals.grossMargins * 100).toFixed(1) + '%' : 'N/A',
        dividendYield: fundamentals?.dividendYield != null ? (fundamentals.dividendYield * 100).toFixed(2) + '%' : 'N/A',
        beta: fundamentals?.beta != null ? fundamentals.beta.toFixed(2) : 'N/A',
        totalRevenue: totalRevenue ? formatMarketCap(totalRevenue) : 'N/A',
        revenuePerEmployee: (totalRevenue && employees && employees > 0)
          ? `$${Math.round(totalRevenue / employees).toLocaleString()}`
          : 'N/A',
        fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ? `$${quote.fiftyTwoWeekHigh.toFixed(2)}` : 'N/A',
        fiftyTwoWeekLow: quote.fiftyTwoWeekLow ? `$${quote.fiftyTwoWeekLow.toFixed(2)}` : 'N/A',
        sector: fundamentals?.sector || 'N/A',
        industry: fundamentals?.industry || 'N/A',
        employees: employees ? employees.toLocaleString() : 'N/A',
      },
      chart: {
        data: [
          {
            x: chartDates,
            y: closes,
            type: 'scatter',
            mode: 'lines',
            name: `${upperTicker} Price`,
            line: { color: '#14b8a6', width: 2 },
            hovertemplate: '<b>%{fullData.name}</b><br>Date: %{x}<br>Price: $%{y:.2f}<extra></extra>',
          },
          {
            x: chartDates,
            y: sma50,
            type: 'scatter',
            mode: 'lines',
            name: 'SMA 50',
            line: { color: '#3b82f6', width: 1.5 },
            hovertemplate: '<b>SMA 50</b><br>Date: %{x}<br>Price: $%{y:.2f}<extra></extra>',
          },
          {
            x: chartDates,
            y: sma200,
            type: 'scatter',
            mode: 'lines',
            name: 'SMA 200',
            line: { color: '#eab308', width: 1.5 },
            hovertemplate: '<b>SMA 200</b><br>Date: %{x}<br>Price: $%{y:.2f}<extra></extra>',
          },
        ],
        layout: {
          title: `${quote.shortName || upperTicker} - 10 Year Chart`,
          xaxis: {
            title: 'Date',
            type: 'date',
            range: chartDates.length > 0 ? [
              chartDates[Math.max(0, chartDates.length - 180)],
              chartDates[chartDates.length - 1],
            ] : undefined,
            autorange: false,
          },
          yaxis: {
            title: 'Price (USD)',
            autorange: true,
            fixedrange: false,
          },
          autosize: true,
        },
      },
    };

    res.status(200).json(responseData);
  } catch (error: any) {
    console.error('Analysis error:', error);
    res.status(500).json({
      error: 'Failed to analyze stock',
      details: error.message,
    });
  }
}