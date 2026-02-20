import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';
import { getScreenerTicker, upsertScreenerRow } from '../../lib/db';
import { getQuoteSummary } from '../../lib/yahoo';

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

    // Fetch fundamentals from local database cache (instant and accurate from our scanner)
    let fundamentalsData: any = null;
    try {
      const dbData = await getScreenerTicker(upperTicker);
      if (dbData) {
        fundamentalsData = {
          returnOnEquity: dbData.roe_pct != null ? Number(dbData.roe_pct) : null,
          returnOnAssets: dbData.roa_pct != null ? Number(dbData.roa_pct) : null,
          debtToEquity: dbData.debt_to_equity != null ? Number(dbData.debt_to_equity) : null,
          grossMargins: dbData.gross_margin_pct != null ? Number(dbData.gross_margin_pct) : null,
          totalRevenue: dbData.total_revenue != null ? Number(dbData.total_revenue) : null,
          fullTimeEmployees: dbData.total_revenue && dbData.revenue_per_employee ? Math.round(Number(dbData.total_revenue) / Number(dbData.revenue_per_employee)) : null,
          sector: dbData.sector || null,
          industry: dbData.industry || null,
          dividendYield: dbData.dividend_yield_pct != null ? Number(dbData.dividend_yield_pct) : null,
          beta: dbData.beta != null ? Number(dbData.beta) : null,
          trailingPE: dbData.pe_ratio != null ? Number(dbData.pe_ratio) : null,
          marketCap: dbData.market_cap != null ? Number(dbData.market_cap) : null,
          fiftyTwoWeekHigh: dbData.fifty_two_week_high != null ? Number(dbData.fifty_two_week_high) : null,
          fiftyTwoWeekLow: dbData.fifty_two_week_low != null ? Number(dbData.fifty_two_week_low) : null,
          companyName: dbData.company_name ?? null
        };
      } else {
        // Fallback: Ticker not in the scanner! Instead of querying Yahoo Fundamentals (which gets rate limited on Vercel IPs), we grab what we have from the chart meta, insert into CSV/DB, and let the Oracle cron job fully populate it later.
        console.log(`[Analyzer] Ticker ${upperTicker} not in DB cache, adding basic info to DB/CSV and letting Cron populate...`);

        fundamentalsData = {
          returnOnEquity: null,
          returnOnAssets: null,
          debtToEquity: null,
          grossMargins: null,
          totalRevenue: null,
          fullTimeEmployees: null,
          sector: null,
          industry: null,
          dividendYield: null,
          beta: null,
          trailingPE: null,
          marketCap: meta.marketCap ?? null,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
          companyName: meta.longName || meta.shortName || upperTicker,
        };

        // 1. ADD IT TO THE CACHED DATABASE IMMEDIATELY (with basic chart-derived info)
        await upsertScreenerRow({
          ticker: upperTicker,
          price: meta.regularMarketPrice ?? null,
          market_cap: meta.marketCap ?? null,
          pe_ratio: null,
          roe_pct: null,
          debt_to_equity: null,
          gross_margin_pct: null,
          dividend_yield_pct: null,
          roa_pct: null,
          total_revenue: null,
          revenue_per_employee: null,
          sector: null,
          industry: null,
          company_name: meta.longName || meta.shortName || upperTicker,
          fifty_two_week_high: meta.fiftyTwoWeekHigh ?? null,
          fifty_two_week_low: meta.fiftyTwoWeekLow ?? null,
          beta: null,
        });

        console.log(`[Analyzer] Added temporary ticker ${upperTicker} to database. Scanner will populate on next run.`);
      }
    } catch (e: any) {
      console.warn('[Analyzer] Fundamentals fetch failed:', e.message);
      // Fundamentals are optional — silently ignore
    }

    const totalRevenue = fundamentalsData?.totalRevenue;
    const employees = fundamentalsData?.fullTimeEmployees;

    const responseData = {
      ticker: upperTicker,
      companyName: fundamentalsData?.companyName || meta.shortName || meta.longName || upperTicker,
      price: meta.regularMarketPrice?.toFixed(2) || 'N/A',
      previousClose: meta.chartPreviousClose ?? null,
      marketCap: (fundamentalsData?.marketCap || meta.marketCap) ? formatMarketCap(fundamentalsData?.marketCap || meta.marketCap) : 'N/A',
      volume: meta.regularMarketVolume ? meta.regularMarketVolume.toLocaleString() : 'N/A',
      peRatio: fundamentalsData?.trailingPE ? fundamentalsData.trailingPE.toFixed(2) : 'N/A',
      fundamentals: {
        roe: fundamentalsData?.returnOnEquity != null ? fundamentalsData.returnOnEquity.toFixed(1) + '%' : 'N/A',
        roa: fundamentalsData?.returnOnAssets != null ? fundamentalsData.returnOnAssets.toFixed(1) + '%' : 'N/A',
        debtToEquity: fundamentalsData?.debtToEquity != null ? fundamentalsData.debtToEquity.toFixed(2) : 'N/A',
        grossMargin: fundamentalsData?.grossMargins != null ? fundamentalsData.grossMargins.toFixed(1) + '%' : 'N/A',
        dividendYield: fundamentalsData?.dividendYield != null ? fundamentalsData.dividendYield.toFixed(2) + '%' : 'N/A',
        beta: fundamentalsData?.beta != null ? fundamentalsData.beta.toFixed(2) : 'N/A',
        totalRevenue: totalRevenue ? formatMarketCap(totalRevenue) : 'N/A',
        revenuePerEmployee: (totalRevenue && employees && employees > 0)
          ? `$${Math.round(totalRevenue / employees).toLocaleString()}`
          : 'N/A',
        fiftyTwoWeekHigh: (fundamentalsData?.fiftyTwoWeekHigh || meta.fiftyTwoWeekHigh) ? `$${(fundamentalsData?.fiftyTwoWeekHigh || meta.fiftyTwoWeekHigh).toFixed(2)}` : 'N/A',
        fiftyTwoWeekLow: (fundamentalsData?.fiftyTwoWeekLow || meta.fiftyTwoWeekLow) ? `$${(fundamentalsData?.fiftyTwoWeekLow || meta.fiftyTwoWeekLow).toFixed(2)}` : 'N/A',
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