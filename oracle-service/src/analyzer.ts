/**
 * Trading Analysis Engine
 * Analyzes stocks using technical indicators and sentiment
 */

import YahooFinance from 'yahoo-finance2';
import { getSentimentScore, SentimentScore } from './sentiment';

// Initialize yahoo-finance2 instance
const yahooFinance = new YahooFinance();

export interface TradeSignal {
    ticker: string;
    action: 'BUY' | 'SELL' | 'HOLD';
    reason: string;
    confidence: number;
    sentimentBoost?: number;
    indicators?: {
        rsi: number;
        macdHistogram: number;
        volumeRatio: number;
        priceChangePct: number;
        sma50: number;
        sma200: number;
    };
}

interface TechnicalIndicators {
    sma50: number;
    sma200: number;
    rsi: number;
    macd: { macd: number; signal: number; histogram: number };
    volumeRatio: number;
    bollingerBands: { upper: number; middle: number; lower: number };
    priceChange: number;
}

/**
 * Analyze a Single Ticker (Enhanced with MACD, Volume, Bollinger Bands, Sentiment)
 */
export async function analyzeTicker(ticker: string): Promise<TradeSignal> {
    try {
        // Calculate date 200 days ago
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 200);
        
        const chart = await yahooFinance.chart(ticker, { 
            period1: startDate, 
            period2: endDate, 
            interval: '1d' 
        }) as any;
        const quotes = chart.quotes;

        if (quotes.length < 200) {
            return { ticker, action: 'HOLD', reason: 'Not enough data', confidence: 0 };
        }

        const current = quotes[quotes.length - 1];
        const closes = quotes.map((q: any) => q.close || 0);
        const volumes = quotes.map((q: any) => q.volume || 0);
        const highs = quotes.map((q: any) => q.high || q.close || 0);
        const lows = quotes.map((q: any) => q.low || q.close || 0);

        // Calculate all technical indicators
        const indicators = calculateIndicators(closes, volumes, highs, lows);

        // Get sentiment (async, but we'll use it to boost confidence)
        const sentiment = await getSentimentScore(ticker);
        const sentimentBoost = sentiment.score * 10 * sentiment.confidence; // -10 to +10 boost

        // Enhanced Buy Logic
        const buySignals: string[] = [];
        let buyConfidence = 0;

        // 1. Trend Analysis
        const isUptrend = indicators.sma50 > indicators.sma200 && current.close > indicators.sma200;
        const isStrongUptrend = indicators.sma50 > indicators.sma200 * 1.05 && current.close > indicators.sma50;

        if (isUptrend || isStrongUptrend) {
            // 2. RSI Analysis
            if (indicators.rsi < 50) {
                buyConfidence += 25;
                buySignals.push(`RSI ${Math.round(indicators.rsi)} (oversold)`);
            } else if (indicators.rsi < 60 && isStrongUptrend) {
                buyConfidence += 15;
                buySignals.push(`RSI ${Math.round(indicators.rsi)} (momentum)`);
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

            // 5. Bollinger Bands
            const bbPosition = (current.close - indicators.bollingerBands.lower) / 
                              (indicators.bollingerBands.upper - indicators.bollingerBands.lower);
            if (bbPosition < 0.3 && isUptrend) {
                buyConfidence += 15;
                buySignals.push('Near BB lower band');
            }

            // 6. Momentum
            if (indicators.priceChange > 5) {
                buyConfidence += 10;
                buySignals.push(`+${indicators.priceChange.toFixed(1)}% momentum`);
            }

            // 7. Sentiment Boost
            if (sentiment.score > 0.2 && sentiment.confidence > 0.5) {
                buyConfidence += Math.min(10, sentiment.score * 15);
                buySignals.push(`Positive sentiment`);
            }

            if (buyConfidence >= 68) {
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
                        sma200: indicators.sma200
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
            if (indicators.rsi > 65) {
                sellConfidence += 30;
                sellSignals.push(`RSI ${Math.round(indicators.rsi)} (overbought)`);
            }

            // MACD Bearish
            if (indicators.macd.histogram < 0 && indicators.macd.macd < indicators.macd.signal) {
                sellConfidence += 25;
                sellSignals.push('MACD bearish');
            }

            // Death Cross
            if (indicators.sma50 < indicators.sma200 && quotes.length >= 51) {
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
                        sma200: indicators.sma200
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
                sma200: indicators.sma200
            }
        };

    } catch (e: any) {
        console.error(`[Analyzer] Error analyzing ${ticker}:`, e.message);
        return { ticker, action: 'HOLD', reason: 'Error', confidence: 0 };
    }
}

function calculateIndicators(
    closes: number[],
    volumes: number[],
    highs: number[],
    lows: number[]
): TechnicalIndicators {
    const current = closes[closes.length - 1];

    // SMA 50 & 200
    const sum50 = closes.slice(-50).reduce((a, b) => a + b, 0);
    const sma50 = sum50 / 50;
    const sum200 = closes.slice(-200).reduce((a, b) => a + b, 0);
    const sma200 = sum200 / 200;

    // RSI
    const rsi = calculateRSI(closes, 14);

    // MACD (12, 26, 9)
    const macd = calculateMACD(closes);

    // Volume Ratio
    const avgVolume20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVolume = volumes[volumes.length - 1] || avgVolume20;
    const volumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 1;

    // Bollinger Bands
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

function calculateMACD(prices: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): {
    macd: number;
    signal: number;
    histogram: number;
} {
    if (prices.length < slowPeriod + signalPeriod) {
        return { macd: 0, signal: 0, histogram: 0 };
    }

    const fastEMA = calculateEMA(prices, fastPeriod);
    const slowEMA = calculateEMA(prices, slowPeriod);

    const macdLine: number[] = [];
    for (let i = 0; i < Math.min(fastEMA.length, slowEMA.length); i++) {
        macdLine.push(fastEMA[i] - slowEMA[i]);
    }

    if (macdLine.length < signalPeriod) {
        return { macd: 0, signal: 0, histogram: 0 };
    }

    const signalLine = calculateEMA(macdLine, signalPeriod);

    const macd = macdLine[macdLine.length - 1];
    const signal = signalLine[signalLine.length - 1];
    const histogram = macd - signal;

    return { macd, signal, histogram };
}

function calculateEMA(prices: number[], period: number): number[] {
    if (prices.length < period) return [];

    const multiplier = 2 / (period + 1);
    const ema: number[] = [];

    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += prices[i];
    }
    ema.push(sum / period);

    for (let i = period; i < prices.length; i++) {
        ema.push((prices[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }

    return ema;
}

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

