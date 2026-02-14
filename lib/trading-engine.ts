
import { getPool } from './db';
import { getPortfolioStatus, getHoldings, executeTrade, updatePortfolioStatus } from './portfolio-db';
import yahooFinance from 'yahoo-finance2'; // We'll use the official wrapper for simpler types if available, or our custom one

// Using our custom yahoo.ts might be better if we need specific crumbing logic, 
// but for now let's use the installed yahoo-finance2 package directly for simplicity if it works,
// or fallback to our lib/yahoo.ts if we need the custom implementation.
// Given strict timeout, let's use the local db + yahoo-finance2 for real-time price checks.

export interface TradeSignal {
    ticker: string;
    action: 'BUY' | 'SELL' | 'HOLD';
    reason: string;
    confidence: number;
}

/**
 * Check if Market is Open
 * (Simple check: Mon-Fri, 9:30 AM - 4:00 PM ET)
 * For cron, we trust the schedule, but this is a double check.
 */
export function isMarketOpen(): boolean {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    // Weekends
    if (day === 0 || day === 6) return false;

    // Market Hours in UTC (approx 14:30 - 21:00)
    // We'll be lenient for pre/post market logic if needed, but strict for "Open"
    const time = hour + minute / 60;
    return time >= 14.5 && time < 21;
}

/**
 * Core Trading Engine
 * 1. Sync Portfolio Prices
 * 2. Generate Signals
 * 3. Execute Trades
 */
export async function runTradingCycle(type: 'OPEN' | 'MID' | 'CLOSE') {
    console.log(`Starting Trading Cycle: ${type}`);
    const db = getPool();

    // 1. Sync Current Prices for Holdings
    const holdings = await getHoldings();
    let totalEquity = 0;

    for (const holding of holdings) {
        try {
            const quote = await yahooFinance.quote(holding.ticker) as any;
            const price = quote.regularMarketPrice;
            if (price) {
                // Update holding in DB (implied by next step, but we can do it explicitly here or just calc equity)
                // For speed, let's just calc equity here and update DB at end
                totalEquity += price * holding.shares;

                // Check for Stop Loss / Take Profit (Simple management)
                if (type !== 'OPEN' && type !== 'CLOSE') { // Mid-day check
                    // Stop Loss: -8%
                    if (price < holding.avg_cost * 0.92) {
                        await executeTrade(holding.ticker, 'SELL', holding.shares, price, 'Stop Loss Hit (-8%)');
                        totalEquity -= price * holding.shares; // Remove from equity
                        totalEquity += price * holding.shares; // Add to cash later (logic needs to handle cash update)
                    }
                    // Take Profit: +20% (Partial sell?) - maybe later
                }
            }
        } catch (e) {
            console.error(`Failed to update price for ${holding.ticker}`, e);
            totalEquity += holding.market_value; // Fallback to last known
        }
    }

    // Update Global Status
    const status = await getPortfolioStatus();
    await updatePortfolioStatus(status.cash_balance, totalEquity);

    // 2. Sell Logic (if not stop-lossed already)
    // Run on OPEN and CLOSE
    if (type === 'OPEN' || type === 'CLOSE') {
        // Re-fetch holdings in case we sold some
        const currentHoldings = await getHoldings();
        for (const holding of currentHoldings) {
            const signal = await analyzeTicker(holding.ticker);
            if (signal.action === 'SELL' && signal.confidence > 70) {
                try {
                    const quote = await yahooFinance.quote(holding.ticker) as any;
                    await executeTrade(holding.ticker, 'SELL', holding.shares, quote.regularMarketPrice, signal.reason);
                    // Update cash
                    const freshStatus = await getPortfolioStatus();
                    await updatePortfolioStatus(freshStatus.cash_balance + (holding.shares * quote.regularMarketPrice), totalEquity - (holding.shares * quote.regularMarketPrice));
                } catch (e) { console.error(e); }
            }
        }
    }

    // 3. Buy Logic
    // Only if we have cash > $5000 and < 15 positions
    const freshStatus = await getPortfolioStatus();
    const currentHoldings = await getHoldings();

    if (freshStatus.cash_balance > 5000 && currentHoldings.length < 15) {
        const candidates = await getBuyCandidates();

        // Buy top 1 or 2 candidates
        for (const candidate of candidates.slice(0, 2)) {
            // Check if already owned
            if (currentHoldings.find(h => h.ticker === candidate.ticker)) continue;

            // Position Sizing: 10% of total portfolio value, capped at cash available
            const positionSize = Math.min(freshStatus.total_value * 0.1, freshStatus.cash_balance);
            if (positionSize < 1000) continue; // Min trade size

            try {
                const quote = await yahooFinance.quote(candidate.ticker) as any;
                const shares = Math.floor(positionSize / quote.regularMarketPrice);

                if (shares > 0) {
                    await executeTrade(candidate.ticker, 'BUY', shares, quote.regularMarketPrice, candidate.reason);
                    // Update cash
                    const postBuyStatus = await getPortfolioStatus();
                    await updatePortfolioStatus(postBuyStatus.cash_balance - (shares * quote.regularMarketPrice), postBuyStatus.total_equity + (shares * quote.regularMarketPrice));
                }
            } catch (e) { console.error(e); }
        }
    }

    console.log('Trading Cycle Completed');
}

/**
 * Filter Candidates (SQL-First for speed)
 * Strategy: ROE > 15, Margin > 10, Debt < 0.8, Uptrend (Price > SMA200 implicit via screener sort?)
 */
async function getBuyCandidates(): Promise<TradeSignal[]> {
    const db = getPool();

    // 1. Fundamental Filter (SQL)
    // We assume screener_cache is populated.
    const query = `
    SELECT ticker, sector, price 
    FROM screener_cache 
    WHERE 
      roe_pct > 15 
      AND gross_margin_pct > 10 
      AND debt_to_equity < 0.8
      AND market_cap > 2000000000 -- Mid/Large cap only for stability
    ORDER BY pe_ratio ASC, roe_pct DESC
    LIMIT 50
  `;

    const result = await db.query(query);
    const signals: TradeSignal[] = [];

    // 2. Technical Analysis (Node.js) on top 50
    for (const row of result.rows) {
        const analysis = await analyzeTicker(row.ticker);
        if (analysis.action === 'BUY' && analysis.confidence > 75) {
            signals.push(analysis);
        }
    }

    return signals.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Analyze a Single Ticker
 */
async function analyzeTicker(ticker: string): Promise<TradeSignal> {
    try {
        const chart = await yahooFinance.chart(ticker, { period1: '200d', interval: '1d' }) as any;
        const quotes = chart.quotes;

        if (quotes.length < 200) return { ticker, action: 'HOLD', reason: 'Not enough data', confidence: 0 };

        const current = quotes[quotes.length - 1];
        const closes = quotes.map((q: any) => q.close || 0);

        // SMA 200
        const sma200 = closes.reduce((a: number, b: number) => a + b, 0) / closes.length; // Approximate, actually need rolling.
        // Real SMA200 requires last 200 points.
        const sum200 = quotes.slice(-200).reduce((acc: number, q: any) => acc + (q.close || 0), 0);
        const sma200Value = sum200 / 200;

        // SMA 50
        const sum50 = quotes.slice(-50).reduce((acc: number, q: any) => acc + (q.close || 0), 0);
        const sma50Value = sum50 / 50;

        // RSI 14
        const rsi = calculateRSI(closes, 14);

        // Logic
        // Trend
        const isUptrend = sma50Value > sma200Value && current.close > sma200Value;

        if (isUptrend) {
            // Buy Dips
            if (rsi < 45) { // Oversold in uptrend
                return {
                    ticker,
                    action: 'BUY',
                    reason: `Uptrend (Price > SMA200) + RSI Dip (${Math.round(rsi)})`,
                    confidence: 80
                };
            }
            if (rsi < 55 && current.close > sma50Value * 1.02) { // Momentum continuation
                // Weak buy
                return { ticker, action: 'HOLD', reason: 'Momentum ok', confidence: 50 };
            }
        } else {
            // Downtrend
            if (rsi > 70) {
                return {
                    ticker,
                    action: 'SELL',
                    reason: `Downtrend + RSI Overbought (${Math.round(rsi)})`,
                    confidence: 85
                };
            }
            // Death Cross recently?
            // checking history would be better but expensive.
        }

        return { ticker, action: 'HOLD', reason: 'Neutral', confidence: 50 };

    } catch (e) {
        return { ticker, action: 'HOLD', reason: 'Error', confidence: 0 };
    }
}

function calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = prices.length - period; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }

    if (losses === 0) return 100;

    const rs = (gains / period) / (losses / period);
    return 100 - (100 / (1 + rs));
}
