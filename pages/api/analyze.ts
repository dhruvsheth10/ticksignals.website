import type { NextApiRequest, NextApiResponse } from 'next';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

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

    // Fetch quote + summary in parallel
    const [quote, summary, historicalData] = await Promise.all([
      yahooFinance.quote(ticker) as Promise<any>,
      yahooFinance.quoteSummary(ticker, {
        modules: ['financialData', 'summaryDetail', 'assetProfile', 'defaultKeyStatistics'],
      }).catch(() => null),
      // 10 years of history for chart
      (async () => {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setFullYear(startDate.getFullYear() - 10);
        return yahooFinance.historical(ticker, {
          period1: startDate,
          period2: endDate,
          interval: '1d',
        }) as Promise<any>;
      })(),
    ]);

    // Chart data
    const chartDates = historicalData.map((d: any) => d.date.toISOString().split('T')[0]);
    const chartPrices = historicalData.map((d: any) => d.close);

    // SMA calculations
    const calculateSMA = (prices: number[], period: number): number[] => {
      const sma: number[] = [];
      for (let i = 0; i < prices.length; i++) {
        if (i < period - 1) {
          sma.push(NaN);
        } else {
          const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
          sma.push(sum / period);
        }
      }
      return sma;
    };

    const sma50 = calculateSMA(chartPrices, 50);
    const sma200 = calculateSMA(chartPrices, 200);

    // Extract fundamentals
    const fin = summary?.financialData || ({} as any);
    const det = summary?.summaryDetail || ({} as any);
    const prof = summary?.assetProfile || ({} as any);

    const safeNum = (v: any) => (v != null && !isNaN(v) ? v : null);
    const totalRevenue = safeNum(fin.totalRevenue);
    const employees = safeNum(prof.fullTimeEmployees);

    // Format market cap
    const formatMarketCap = (value: number) => {
      if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
      return `${value.toLocaleString()}`;
    };

    const responseData = {
      ticker: ticker.toUpperCase(),
      companyName: quote.shortName || quote.longName || ticker.toUpperCase(),
      price: `${quote.regularMarketPrice?.toFixed(2) || 'N/A'}`,
      marketCap: quote.marketCap ? formatMarketCap(quote.marketCap) : 'N/A',
      volume: quote.regularMarketVolume ? quote.regularMarketVolume.toLocaleString() : 'N/A',
      peRatio: quote.trailingPE ? quote.trailingPE.toFixed(2) : 'N/A',
      // Extended fundamentals
      fundamentals: {
        roe: fin.returnOnEquity != null ? (fin.returnOnEquity * 100).toFixed(1) + '%' : 'N/A',
        roa: fin.returnOnAssets != null ? (fin.returnOnAssets * 100).toFixed(1) + '%' : 'N/A',
        debtToEquity: fin.debtToEquity != null ? fin.debtToEquity.toFixed(1) : 'N/A',
        grossMargin: fin.grossMargins != null ? (fin.grossMargins * 100).toFixed(1) + '%' : 'N/A',
        dividendYield: det.dividendYield != null ? (det.dividendYield * 100).toFixed(2) + '%' : 'N/A',
        beta: det.beta != null ? det.beta.toFixed(2) : 'N/A',
        totalRevenue: totalRevenue ? formatMarketCap(totalRevenue) : 'N/A',
        revenuePerEmployee: (totalRevenue && employees && employees > 0)
          ? `$${Math.round(totalRevenue / employees).toLocaleString()}`
          : 'N/A',
        fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ? `$${quote.fiftyTwoWeekHigh.toFixed(2)}` : 'N/A',
        fiftyTwoWeekLow: quote.fiftyTwoWeekLow ? `$${quote.fiftyTwoWeekLow.toFixed(2)}` : 'N/A',
        sector: prof.sector || 'N/A',
        industry: prof.industry || 'N/A',
        employees: employees ? employees.toLocaleString() : 'N/A',
      },
      chart: {
        data: [
          {
            x: chartDates,
            y: chartPrices,
            type: 'scatter',
            mode: 'lines',
            name: `${ticker.toUpperCase()} Price`,
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
          title: `${quote.shortName || ticker.toUpperCase()} - 10 Year Chart`,
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