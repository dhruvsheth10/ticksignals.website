
import { getPool } from './db';
import { getPortfolioStatus, getHoldings, executeTrade, updatePortfolioStatus, saveAnalysisResult, saveCycleLog, getDailySnapshots, getIntradayBars } from './portfolio-db';
import { MarketDataService } from './market-data';
import { getSentimentScore } from './sentiment';

export interface TradeSignal {
    ticker: string;
    action: 'BUY' | 'SELL' | 'HOLD';
    reason: string;
    confidence: number;
    sentimentBoost?: number; // Additional confidence from sentiment
    indicators?: {
        rsi: number;
        macdHistogram: number;
        volumeRatio: number;
        priceChangePct: number;
        sma50: number;
        sma200: number;
        rvol?: number;   // relative volume vs 30d avg (from Turso snapshots)
        vwap?: number;   // intraday VWAP (from Turso intraday bars)
    };
}

interface TechnicalIndicators {
    sma50: number;
    sma200: number;
    rsi: number;
    macd: { macd: number; signal: number; histogram: number };
    volumeRatio: number; // Current volume vs 20-day average
    bollingerBands: { upper: number; middle: number; lower: number };
    priceChange: number; // % change from 20 days ago
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
 * Core Trading Engine (Enhanced)
 * OPEN/MID/CLOSE: full cycle (sync, sell logic, buy scan).
 * PORTFOLIO_CHECK: sync + stop loss + take profit + sell signals only (no new buys). Use every 15 min when holding.
 * For each holding, sell logic uses full analyzeTicker() — 200d chart, RSI, MACD, Bollinger Bands, volume, sentiment — not just price.
 */
export async function runTradingCycle(type: 'OPEN' | 'MID' | 'CLOSE' | 'PORTFOLIO_CHECK') {
    console.log(`Starting Trading Cycle: ${type}`);
    const db = getPool();
    const summaryLines: string[] = [];

    // 1. Sync Current Prices for Holdings
    const holdings = await getHoldings();
    let totalEquity = 0;
    summaryLines.push(`Holdings: ${holdings.length} (${holdings.map(h => h.ticker).join(', ') || 'none'})`);

    const isPortfolioOnly = type === 'PORTFOLIO_CHECK';

    for (const holding of holdings) {
        try {
            const price = await MarketDataService.getCurrentPrice(holding.ticker);
            if (price) {
                totalEquity += price * holding.shares;

                // Stop Loss / Take Profit (MID, CLOSE, or any PORTFOLIO_CHECK)
                if (type === 'MID' || type === 'CLOSE' || isPortfolioOnly) {
                    const returnPct = ((price - holding.avg_cost) / holding.avg_cost) * 100;
                    const daysHeld = holding.opened_at ? (Date.now() - new Date(holding.opened_at).getTime()) / (1000 * 60 * 60 * 24) : 0;

                    // 1. Tighter Stop Loss (-4%)
                    if (returnPct < -4) {
                        await executeTrade(holding.ticker, 'SELL', holding.shares, price, `Hard Stop Loss (-4%) Hit (${returnPct.toFixed(1)}%)`);
                        summaryLines.push(`  SELL ${holding.ticker}: stop loss -4%`);
                        totalEquity -= price * holding.shares;
                        continue;
                    }

                    // 2. Take Profit (+6% to +8%)
                    if (returnPct >= 6 && holding.shares > 0) {
                        await executeTrade(holding.ticker, 'SELL', holding.shares, price, `Take Profit Target Hit (+6%+)`);
                        summaryLines.push(`  SELL ${holding.ticker}: take profit +6%`);
                        totalEquity -= price * holding.shares;
                        continue;
                    }

                    // 3. Time-Based Drift Logic (> 3 Days)
                    if (daysHeld > 3 && returnPct < 0) {
                        const signal = await analyzeTicker(holding.ticker);
                        if (signal.action === 'SELL' || signal.confidence < 40) {
                            await executeTrade(holding.ticker, 'SELL', holding.shares, price, `Time Exit (>3 days red) + Weak Analysis`);
                            summaryLines.push(`  SELL ${holding.ticker}: time exit (>3d red) + weak analysis`);
                            totalEquity -= price * holding.shares;
                            continue;
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`Failed to update price for ${holding.ticker}`, e);
            totalEquity += holding.market_value;
        }
    }

    // Update Global Status
    const status = await getPortfolioStatus();
    await updatePortfolioStatus(status.cash_balance, totalEquity);

    // 2. Enhanced Sell Logic (runs at OPEN, MID, and CLOSE for more opportunities)
    const currentHoldings = await getHoldings();
    for (const holding of currentHoldings) {
        const signal = await analyzeTicker(holding.ticker);

        // Save Analysis Result (so cloud status updates)
        try {
            await saveAnalysisResult({
                ticker: holding.ticker,
                action: signal.action,
                confidence: signal.confidence,
                reason: signal.reason,
                sentimentScore: signal.sentimentBoost ? signal.sentimentBoost / 10 : undefined,
                sentimentConfidence: signal.sentimentBoost ? Math.abs(signal.sentimentBoost) / 10 : undefined,
                rsi: signal.indicators?.rsi,
                macdHistogram: signal.indicators?.macdHistogram,
                volumeRatio: signal.indicators?.volumeRatio,
                priceChangePct: signal.indicators?.priceChangePct,
                sma50: signal.indicators?.sma50,
                sma200: signal.indicators?.sma200
            });
        } catch (e) { console.error(`Failed to save analysis for ${holding.ticker}`, e); }
        summaryLines.push(`  ${holding.ticker}: ${signal.action} (${signal.confidence}%) - ${signal.reason}`);
        // Lower threshold: 65% (was 70%) for more frequent sells
        if (signal.action === 'SELL' && signal.confidence >= 65) {
            try {
                const currentPrice = await MarketDataService.getCurrentPrice(holding.ticker);
                if (currentPrice) {
                    await executeTrade(holding.ticker, 'SELL', holding.shares, currentPrice, signal.reason);
                    summaryLines.push(`  -> SELL executed ${holding.ticker}`);
                    const freshStatus = await getPortfolioStatus();
                    await updatePortfolioStatus(
                        freshStatus.cash_balance + (holding.shares * currentPrice),
                        totalEquity - (holding.shares * currentPrice)
                    );
                }
            } catch (e) { console.error(e); }
        }
    }

    // Heartbeat so cloud status widget shows last run even when there are no holdings
    try {
        await saveAnalysisResult({
            ticker: '_cycle',
            action: 'HOLD',
            confidence: 0,
            reason: `Cycle ${type} completed`,
        });
    } catch (e) { console.error('Heartbeat save failed', e); }

    // 3. Buy Logic: only on OPEN/MID/CLOSE (skip on PORTFOLIO_CHECK)
    if (isPortfolioOnly) {
        summaryLines.push('PORTFOLIO_CHECK: no buy scan.');
        try { await saveCycleLog(type, summaryLines.join('\n')); } catch (e) { console.error('saveCycleLog failed', e); }
        console.log('PORTFOLIO_CHECK: skipping buy scan.');
        return;
    }

    const freshStatus = await getPortfolioStatus();
    const updatedHoldings = await getHoldings();

    // Max 10 positions, min $3k cash. Buy at most 1–2 per cycle for stable ~5% weekly ROI.
    const MAX_POSITIONS = 10;
    const candidates = await getBuyCandidates();
    const top5 = candidates.slice(0, 5);

    if (freshStatus.cash_balance <= 3000 || updatedHoldings.length >= MAX_POSITIONS) {
        summaryLines.push(`No buy: ${freshStatus.cash_balance <= 3000 ? 'cash ≤ $3k' : 'max positions (10)'}. Top 5 rejected:`);
        for (const c of top5) {
            const reason = freshStatus.cash_balance <= 3000 ? 'low cash' : 'at max positions';
            summaryLines.push(`  ${c.ticker} ${c.confidence}% - ${reason}`);
        }
        try { await saveCycleLog(type, summaryLines.join('\n')); } catch (e) { console.error('saveCycleLog failed', e); }
        console.log('Trading Cycle Completed');
        return;
    }

    let bought: string[] = [];
    for (const candidate of candidates.slice(0, 2)) {
        if (updatedHoldings.find(h => h.ticker === candidate.ticker)) {
            if (top5.some(c => c.ticker === candidate.ticker)) {
                summaryLines.push(`  ${candidate.ticker} ${candidate.confidence}% - already holding (rejected)`);
            }
            continue;
        }

        const baseSize = freshStatus.total_value * 0.1;
        const confidenceMultiplier = candidate.confidence / 100;
        const positionSize = Math.min(
            baseSize * (0.8 + confidenceMultiplier * 0.4),
            freshStatus.cash_balance * 0.7
        );

        if (positionSize < 1000) {
            if (top5.some(c => c.ticker === candidate.ticker)) {
                summaryLines.push(`  ${candidate.ticker} ${candidate.confidence}% - position size < $1000 (rejected)`);
            }
            continue;
        }

        if (candidate.confidence < 68) {
            if (top5.some(c => c.ticker === candidate.ticker)) {
                summaryLines.push(`  ${candidate.ticker} ${candidate.confidence}% - below 68% buy threshold (rejected)`);
            }
            continue;
        }

        try {
            const currentPrice = await MarketDataService.getCurrentPrice(candidate.ticker);

            if (currentPrice) {
                const shares = Math.floor(positionSize / currentPrice);

                if (shares > 0) {
                    await executeTrade(candidate.ticker, 'BUY', shares, currentPrice, candidate.reason);
                    bought.push(`${candidate.ticker} (${shares} shares)`);
                    const postBuyStatus = await getPortfolioStatus();
                    await updatePortfolioStatus(
                        postBuyStatus.cash_balance - (shares * currentPrice),
                        postBuyStatus.total_equity + (shares * currentPrice)
                    );
                }
            }
        } catch (e) { console.error(e); }
    }

    if (bought.length) summaryLines.push('Bought: ' + bought.join(', '));
    else if (top5.length) {
        summaryLines.push('Top 5 candidates not bought:');
        for (const c of top5) {
            const why = updatedHoldings.find(h => h.ticker === c.ticker) ? 'already holding'
                : c.confidence < 68 ? `confidence ${c.confidence}% < 68%`
                    : 'position size or other';
            summaryLines.push(`  ${c.ticker} ${c.confidence}% - ${why}`);
        }
    }
    try { await saveCycleLog(type, summaryLines.join('\n')); } catch (e) { console.error('saveCycleLog failed', e); }
    console.log('Trading Cycle Completed');
}

/**
 * Filter Candidates (Enhanced with more flexibility)
 * Strategy: Slightly relaxed fundamentals + Enhanced technicals + Sentiment
 */
async function getBuyCandidates(): Promise<TradeSignal[]> {
    const db = getPool();

    // 1. Fundamental Filter (slightly relaxed for more opportunities)
    const query = `
    SELECT ticker, sector, price 
    FROM screener_cache 
    WHERE 
      roe_pct > 12  -- Lowered from 15
      AND gross_margin_pct > 8  -- Lowered from 10
      AND debt_to_equity < 1.0  -- Relaxed from 0.8
      AND market_cap > 1000000000  -- Lowered from 2B to include more mid-caps
    ORDER BY pe_ratio ASC, roe_pct DESC
    LIMIT 75  -- Increased from 50
  `;

    const result = await db.query(query);
    const signals: TradeSignal[] = [];

    // 2. Enhanced Technical Analysis + Sentiment on top candidates
    for (const row of result.rows) {
        const analysis = await analyzeTicker(row.ticker);

        // Save Analysis Result (so cloud status updates)
        try {
            await saveAnalysisResult({
                ticker: row.ticker,
                action: analysis.action,
                confidence: analysis.confidence,
                reason: analysis.reason,
                sentimentScore: analysis.sentimentBoost ? analysis.sentimentBoost / 10 : undefined,
                sentimentConfidence: analysis.sentimentBoost ? Math.abs(analysis.sentimentBoost) / 10 : undefined,
                rsi: analysis.indicators?.rsi,
                macdHistogram: analysis.indicators?.macdHistogram,
                volumeRatio: analysis.indicators?.volumeRatio,
                priceChangePct: analysis.indicators?.priceChangePct,
                sma50: analysis.indicators?.sma50,
                sma200: analysis.indicators?.sma200
            });
        } catch (e) { console.error(`Failed to save analysis for ${row.ticker}`, e); }

        // Lower threshold: 68% (was 75%) for more buy opportunities
        if (analysis.action === 'BUY' && analysis.confidence >= 68) {
            signals.push(analysis);
        }
    }

    return signals.sort((a, b) => {
        const totalA = a.confidence + (a.sentimentBoost || 0);
        const totalB = b.confidence + (b.sentimentBoost || 0);
        return totalB - totalA;
    });
}

/**
 * Get historical context from Turso (5-day snapshots + intraday bars).
 * Used to enhance buy/sell/hold with RVOL + VWAP when available.
 */
async function getHistoricalContext(ticker: string): Promise<{ rvol: number; vwap: number } | null> {
    try {
        const [snapshots, intraday] = await Promise.all([
            getDailySnapshots(ticker, 5),
            getIntradayBars(ticker),
        ]);
        if (snapshots.length === 0 && intraday.length === 0) return null;
        const latestSnapshot = snapshots[snapshots.length - 1];
        const latestIntraday = intraday[intraday.length - 1];
        const rvol = latestSnapshot?.rvol ?? 1;
        const vwap = latestIntraday?.vwap ?? latestSnapshot?.vwap ?? 0;
        return { rvol, vwap };
    } catch {
        return null;
    }
}

/**
 * Analyze a Single Ticker (Enhanced with MACD, Volume, Bollinger Bands, Sentiment, RVOL, VWAP)
 */
export async function analyzeTicker(ticker: string): Promise<TradeSignal> {
    try {
        const quotes = await MarketDataService.getDailyCandles(ticker, 200);

        if (quotes.length < 50) return { ticker, action: 'HOLD', reason: 'Not enough data', confidence: 0 }; // Need at least 50 for SMA50

        const current = quotes[quotes.length - 1];
        const closes = quotes.map((q: any) => q.close || 0);
        const volumes = quotes.map((q: any) => q.volume || 0);
        const highs = quotes.map((q: any) => q.high || q.close || 0);
        const lows = quotes.map((q: any) => q.low || q.close || 0);

        // Calculate all technical indicators
        const indicators = calculateIndicators(closes, volumes, highs, lows);

        // Historical context from Turso (RVOL, VWAP)
        const hist = await getHistoricalContext(ticker);
        const rvol = hist?.rvol ?? indicators.volumeRatio;
        const vwap = hist?.vwap ?? 0;
        const priceAboveVwap = vwap > 0 && current.close > vwap;

        // Get sentiment (async, but we'll use it to boost confidence)
        const sentiment = await getSentimentScore(ticker);
        const sentimentBoost = sentiment.score * 10 * sentiment.confidence; // -10 to +10 boost

        // Enhanced Buy Logic
        const buySignals: string[] = [];
        let buyConfidence = 0;

        // 1. Trend Analysis (EMA 10/50)
        // Strong Uptrend: Price > EMA10 > EMA50
        const isUptrend = indicators.sma50 > indicators.sma200; // actually EMA10 > EMA50
        const priceAboveTrend = current.close > indicators.sma200; // Price > EMA50

        if (isUptrend && priceAboveTrend) {
            // 2. RSI Analysis (Dip Buying in Uptrend)
            if (indicators.rsi < 45) {
                buyConfidence += 30; // High confidence for dip buy
                buySignals.push(`RSI ${Math.round(indicators.rsi)} (Dip in Uptrend)`);
            } else if (indicators.rsi < 55 && current.close > indicators.sma50) {
                // Momentum buy: RSI not overbought, price above EMA10
                buyConfidence += 15;
                buySignals.push(`Momentum (Price > EMA10, RSI ${Math.round(indicators.rsi)})`);
            }

            // 3. MACD Analysis
            if (indicators.macd.histogram > 0 && indicators.macd.macd > indicators.macd.signal) {
                buyConfidence += 20;
                buySignals.push('MACD bullish');
            }

            // 4. Volume Confirmation
            if (indicators.volumeRatio > 1.2) {
                buyConfidence += 15;
                buySignals.push(`Volume +${Math.round((indicators.volumeRatio - 1) * 100)}%`);
            }

            // 4b. RVOL from Turso (relative to 30d avg) — unusual volume = potential breakout
            if (rvol > 1.5) {
                buyConfidence += 12;
                buySignals.push(`RVOL ${rvol.toFixed(1)}x (unusual volume)`);
            } else if (rvol > 1.2) {
                buyConfidence += 5;
            }
            // 4c. Price above VWAP = bullish intraday
            if (priceAboveVwap) {
                buyConfidence += 8;
                buySignals.push('Price > VWAP');
            }

            // 5. Bollinger Bands (buy near lower band in uptrend)
            const bbPosition = (current.close - indicators.bollingerBands.lower) /
                (indicators.bollingerBands.upper - indicators.bollingerBands.lower);
            if (bbPosition < 0.3 && isUptrend) {
                buyConfidence += 15;
                buySignals.push('Near BB lower band');
            }

            // 6. Momentum (price change)
            if (indicators.priceChange > 5) {
                buyConfidence += 10;
                buySignals.push(`+${indicators.priceChange.toFixed(1)}% momentum`);
            }

            // 7. Sentiment Boost
            if (sentiment.score > 0.2 && sentiment.confidence > 0.5) {
                buyConfidence += Math.min(10, sentiment.score * 15);
                buySignals.push(`Positive sentiment`);
            }

            if (buyConfidence >= 68) { // Lower threshold for more opportunities
                return {
                    ticker,
                    action: 'BUY',
                    reason: buySignals.join(', '),
                    confidence: Math.min(95, buyConfidence),
                    sentimentBoost,
                    indicators: {
                        rsi: indicators.rsi,
                        macdHistogram: indicators.macd.histogram,
                        volumeRatio: indicators.volumeRatio,
                        priceChangePct: indicators.priceChange,
                        sma50: indicators.sma50,
                        sma200: indicators.sma200,
                        rvol,
                        vwap: vwap || undefined
                    }
                };
            }
        }

        // Enhanced Sell Logic
        const sellSignals: string[] = [];
        let sellConfidence = 0;

        const isDowntrend = indicators.sma50 < indicators.sma200 || current.close < indicators.sma200;
        const isStrongDowntrend = indicators.sma50 < indicators.sma200 * 0.95 && current.close < indicators.sma50;

        if (isDowntrend || isStrongDowntrend) {
            // RSI Overbought in downtrend
            if (indicators.rsi > 65) { // Lowered from 70
                sellConfidence += 30;
                sellSignals.push(`RSI ${Math.round(indicators.rsi)} (overbought)`);
            }

            // MACD Bearish
            if (indicators.macd.histogram < 0 && indicators.macd.macd < indicators.macd.signal) {
                sellConfidence += 25;
                sellSignals.push('MACD bearish');
            }

            // Death Cross (SMA50 crossing below SMA200)
            if (indicators.sma50 < indicators.sma200 &&
                quotes.length >= 51 &&
                quotes[quotes.length - 2].close) {
                const prevSMA50 = quotes.slice(-51, -1).reduce((acc: number, q: any) => acc + (q.close || 0), 0) / 50;
                const prevSMA200 = quotes.slice(-201, -1).reduce((acc: number, q: any) => acc + (q.close || 0), 0) / 200;
                if (prevSMA50 >= prevSMA200 && indicators.sma50 < indicators.sma200) {
                    sellConfidence += 20;
                    sellSignals.push('Death cross');
                }
            }

            // Negative sentiment
            if (sentiment.score < -0.2 && sentiment.confidence > 0.5) {
                sellConfidence += 15;
                sellSignals.push('Negative sentiment');
            }

            // Volume spike on decline
            if (indicators.volumeRatio > 1.5 && current.close < quotes[quotes.length - 2].close) {
                sellConfidence += 10;
                sellSignals.push('High volume decline');
            }
            // Price below VWAP in downtrend = distribution
            if (!priceAboveVwap && vwap > 0) {
                sellConfidence += 8;
                sellSignals.push('Price < VWAP');
            }
            // RVOL spike on decline
            if (rvol > 1.5 && current.close < quotes[quotes.length - 2]?.close) {
                sellConfidence += 7;
                sellSignals.push('RVOL spike on decline');
            }

            if (sellConfidence >= 65) {
                return {
                    ticker,
                    action: 'SELL',
                    reason: sellSignals.join(', '),
                    confidence: Math.min(95, sellConfidence),
                    sentimentBoost,
                    indicators: {
                        rsi: indicators.rsi,
                        macdHistogram: indicators.macd.histogram,
                        volumeRatio: indicators.volumeRatio,
                        priceChangePct: indicators.priceChange,
                        sma50: indicators.sma50,
                        sma200: indicators.sma200,
                        rvol,
                        vwap: vwap || undefined
                    }
                };
            }
        }

        // Neutral/Hold
        return {
            ticker,
            action: 'HOLD',
            reason: `Neutral: RSI ${Math.round(indicators.rsi)}, Trend ${isUptrend ? 'Up' : 'Down'}`,
            confidence: 50,
            indicators: {
                rsi: indicators.rsi,
                macdHistogram: indicators.macd.histogram,
                volumeRatio: indicators.volumeRatio,
                priceChangePct: indicators.priceChange,
                sma50: indicators.sma50,
                sma200: indicators.sma200,
                rvol,
                vwap: vwap || undefined
            }
        };

    } catch (e) {
        console.error(`[Trading] Error analyzing ${ticker}:`, e);
        return { ticker, action: 'HOLD', reason: 'Error', confidence: 0 };
    }
}

/**
 * Calculate all technical indicators
 */
function calculateIndicators(
    closes: number[],
    volumes: number[],
    highs: number[],
    lows: number[]
): TechnicalIndicators {
    const current = closes[closes.length - 1];

    // EMA 10 & 50 (Faster trend detection)
    const ema10Array = calculateEMA(closes, 10);
    const ema50Array = calculateEMA(closes, 50);
    const sma50 = ema10Array[ema10Array.length - 1] || 0; // Using sma50 field for EMA10 to keep interface
    const sma200 = ema50Array[ema50Array.length - 1] || 0; // Using sma200 field for EMA50

    // RSI
    const rsi = calculateRSI(closes, 14);

    // MACD (12, 26, 9)
    const macd = calculateMACD(closes);

    // Volume Ratio (current vs 20-day average)
    const avgVolume20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVolume = volumes[volumes.length - 1] || avgVolume20;
    const volumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 1;

    // Bollinger Bands (20-period, 2 std dev)
    const bollingerBands = calculateBollingerBands(closes, 20, 2);

    // Price Change (20 days)
    const price20DaysAgo = closes[closes.length - 21] || current;
    const priceChange = ((current - price20DaysAgo) / price20DaysAgo) * 100;

    return {
        sma50,
        sma200,
        rsi,
        macd,
        volumeRatio,
        bollingerBands,
        priceChange
    };
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
function calculateMACD(prices: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): {
    macd: number;
    signal: number;
    histogram: number;
} {
    if (prices.length < slowPeriod + signalPeriod) {
        return { macd: 0, signal: 0, histogram: 0 };
    }

    // Calculate EMAs
    const fastEMA = calculateEMA(prices, fastPeriod);
    const slowEMA = calculateEMA(prices, slowPeriod);

    // MACD line
    const macdLine: number[] = [];
    for (let i = 0; i < Math.min(fastEMA.length, slowEMA.length); i++) {
        macdLine.push(fastEMA[i] - slowEMA[i]);
    }

    if (macdLine.length < signalPeriod) {
        return { macd: 0, signal: 0, histogram: 0 };
    }

    // Signal line (EMA of MACD)
    const signalLine = calculateEMA(macdLine, signalPeriod);

    const macd = macdLine[macdLine.length - 1];
    const signal = signalLine[signalLine.length - 1];
    const histogram = macd - signal;

    return { macd, signal, histogram };
}

/**
 * Calculate EMA (Exponential Moving Average)
 */
function calculateEMA(prices: number[], period: number): number[] {
    if (prices.length < period) return [];

    const multiplier = 2 / (period + 1);
    const ema: number[] = [];

    // Start with SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += prices[i];
    }
    ema.push(sum / period);

    // Calculate EMA for rest
    for (let i = period; i < prices.length; i++) {
        ema.push((prices[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }

    return ema;
}

/**
 * Calculate Bollinger Bands
 */
function calculateBollingerBands(prices: number[], period: number, stdDev: number): {
    upper: number;
    middle: number;
    lower: number;
} {
    if (prices.length < period) {
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        return { upper: avg, middle: avg, lower: avg };
    }

    const slice = prices.slice(-period);
    const middle = slice.reduce((a, b) => a + b, 0) / period;

    // Calculate standard deviation
    const variance = slice.reduce((sum, price) => sum + Math.pow(price - middle, 2), 0) / period;
    const standardDev = Math.sqrt(variance);

    return {
        upper: middle + (standardDev * stdDev),
        middle,
        lower: middle - (standardDev * stdDev)
    };
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
