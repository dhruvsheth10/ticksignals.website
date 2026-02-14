import type { NextApiRequest, NextApiResponse } from 'next';

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

    // Fetch max historical data (unauthenticated chart endpoint)
    const endDate = Math.floor(Date.now() / 1000);
    const startDate = endDate - (20 * 365.25 * 24 * 60 * 60); // 20 years
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${upperTicker}?period1=${Math.floor(startDate)}&period2=${endDate}&interval=1d`;

    const chartRes = await fetch(chartUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });

    if (!chartRes.ok) {
      return res.status(404).json({ error: `Ticker ${upperTicker} not found` });
    }

    const chartData = await chartRes.json();
    const chartResult = chartData.chart?.result?.[0];

    if (!chartResult) {
      return res.status(404).json({ error: `No data found for ticker ${upperTicker}` });
    }

    const meta = chartResult.meta;
    const timestamps: number[] = chartResult.timestamp || [];
    const ohlcv = chartResult.indicators?.quote?.[0] || {};
    const closes: (number | null)[] = ohlcv.close || [];
    const opens: (number | null)[] = ohlcv.open || [];
    const highs: (number | null)[] = ohlcv.high || [];
    const lows: (number | null)[] = ohlcv.low || [];
    const volumes: (number | null)[] = ohlcv.volume || [];

    // Convert timestamps to ISO date strings
    const dates = timestamps.map((ts: number) => new Date(ts * 1000).toISOString().split('T')[0]);

    // Format helpers
    const formatMarketCap = (value: number) => {
      if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
      return `${value.toLocaleString()}`;
    };

    // Fetch fundamentals (may fail silently – that's fine)
    let fundamentalsData: any = null;
    try {
      const summaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${upperTicker}?modules=financialData,summaryDetail,assetProfile,defaultKeyStatistics`;
      const summaryRes = await fetch(summaryUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      });
      if (summaryRes.ok) {
        const summaryJson = await summaryRes.json();
        const result = summaryJson.quoteSummary?.result?.[0];
        if (result) {
          const fin = result.financialData || {};
          const det = result.summaryDetail || {};
          const prof = result.assetProfile || {};
          const stats = result.defaultKeyStatistics || {};
          fundamentalsData = {
            returnOnEquity: fin.returnOnEquity?.raw ?? null,
            returnOnAssets: fin.returnOnAssets?.raw ?? null,
            debtToEquity: fin.debtToEquity?.raw ?? null,
            grossMargins: fin.grossMargins?.raw ?? null,
            totalRevenue: fin.totalRevenue?.raw ?? null,
            fullTimeEmployees: prof.fullTimeEmployees ?? null,
            sector: prof.sector || null,
            industry: prof.industry || null,
            dividendYield: det.dividendYield?.raw ?? null,
            beta: det.beta?.raw ?? null,
            trailingPE: det.trailingPE?.raw ?? stats.trailingPE?.raw ?? null,
          };
        }
      }
    } catch (_) {
      // Fundamentals are optional — silently ignore
    }

    const totalRevenue = fundamentalsData?.totalRevenue;
    const employees = fundamentalsData?.fullTimeEmployees;

    const responseData = {
      ticker: upperTicker,
      companyName: meta.shortName || meta.longName || upperTicker,
      price: meta.regularMarketPrice?.toFixed(2) || 'N/A',
      previousClose: meta.chartPreviousClose ?? null,
      marketCap: meta.marketCap ? formatMarketCap(meta.marketCap) : 'N/A',
      volume: meta.regularMarketVolume ? meta.regularMarketVolume.toLocaleString() : 'N/A',
      peRatio: fundamentalsData?.trailingPE ? fundamentalsData.trailingPE.toFixed(2) : 'N/A',
      fundamentals: {
        roe: fundamentalsData?.returnOnEquity != null ? (fundamentalsData.returnOnEquity * 100).toFixed(1) + '%' : 'N/A',
        roa: fundamentalsData?.returnOnAssets != null ? (fundamentalsData.returnOnAssets * 100).toFixed(1) + '%' : 'N/A',
        debtToEquity: fundamentalsData?.debtToEquity != null ? fundamentalsData.debtToEquity.toFixed(1) : 'N/A',
        grossMargin: fundamentalsData?.grossMargins != null ? (fundamentalsData.grossMargins * 100).toFixed(1) + '%' : 'N/A',
        dividendYield: fundamentalsData?.dividendYield != null ? (fundamentalsData.dividendYield * 100).toFixed(2) + '%' : 'N/A',
        beta: fundamentalsData?.beta != null ? fundamentalsData.beta.toFixed(2) : 'N/A',
        totalRevenue: totalRevenue ? formatMarketCap(totalRevenue) : 'N/A',
        revenuePerEmployee: (totalRevenue && employees && employees > 0)
          ? `$${Math.round(totalRevenue / employees).toLocaleString()}`
          : 'N/A',
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ? `$${meta.fiftyTwoWeekHigh.toFixed(2)}` : 'N/A',
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow ? `$${meta.fiftyTwoWeekLow.toFixed(2)}` : 'N/A',
        sector: fundamentalsData?.sector || 'N/A',
        industry: fundamentalsData?.industry || 'N/A',
        employees: employees ? employees.toLocaleString() : 'N/A',
      },
      // Raw chart data – frontend slices by range
      chart: {
        dates,
        closes,
        opens,
        highs,
        lows,
        volumes,
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