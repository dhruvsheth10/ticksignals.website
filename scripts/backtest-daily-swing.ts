import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import { getPool } from '../lib/db';
import { Candle, MarketDataService } from '../lib/market-data';
import { analyzeTickerFromCandles, calculatePositionSize, StrategyCandle } from '../lib/trading-engine';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

interface Position {
    ticker: string;
    shares: number;
    avgCost: number;
    atr: number;
    highWaterMark: number;
    openedIndex: number;
    partialSells: number;
}

interface TradeRecord {
    date: string;
    ticker: string;
    type: 'BUY' | 'SELL';
    shares: number;
    price: number;
    reason: string;
}

interface BacktestResult {
    generatedAt: string;
    tickers: string[];
    strategy: {
        startDate: string;
        endDate: string;
        initialCapital: number;
        endingCapital: number;
        totalReturnPct: number;
        maxDrawdownPct: number;
        trades: number;
        winRatePct: number;
    };
    benchmark: {
        ticker: string;
        totalReturnPct: number;
    };
    holdout: {
        splitDate: string;
        inSampleReturnPct: number;
        outOfSampleReturnPct: number;
    };
    trades: TradeRecord[];
}

const INITIAL_CAPITAL = 100000;
const MAX_POSITIONS = 8;
const CASH_FLOOR_PCT = 0.2;
const MAX_BUYS_PER_DAY = 2;

function parseCliTickers(): string[] {
    const tickersArg = process.argv.find((arg) => arg.startsWith('--tickers='));
    if (!tickersArg) return [];
    return tickersArg
        .split('=')[1]
        .split(',')
        .map((ticker) => ticker.trim().toUpperCase())
        .filter(Boolean);
}

async function loadUniverse(defaultLimit = 12): Promise<string[]> {
    const cliTickers = parseCliTickers();
    if (cliTickers.length > 0) return cliTickers;

    const db = getPool();
    const result = await db.query('SELECT ticker FROM monitored_prospects ORDER BY score DESC LIMIT $1', [defaultLimit]);
    return (result.rows as Array<{ ticker: string }>).map((row) => row.ticker);
}

function normalizeCandles(candles: Candle[]): StrategyCandle[] {
    return candles.map((candle) => ({
        date: candle.date,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
    }));
}

function getMaxDrawdownPct(equityCurve: number[]): number {
    let peak = equityCurve[0] ?? INITIAL_CAPITAL;
    let maxDrawdown = 0;
    for (const value of equityCurve) {
        peak = Math.max(peak, value);
        if (peak <= 0) continue;
        const drawdown = ((value - peak) / peak) * 100;
        maxDrawdown = Math.min(maxDrawdown, drawdown);
    }
    return maxDrawdown;
}

function buildIndexByDate(candles: StrategyCandle[]): Map<string, number> {
    const index = new Map<string, number>();
    candles.forEach((candle, idx) => {
        index.set(candle.date.slice(0, 10), idx);
    });
    return index;
}

function getPortfolioValue(
    cash: number,
    positions: Map<string, Position>,
    day: string,
    candleMap: Map<string, StrategyCandle[]>,
    indexMap: Map<string, Map<string, number>>
): number {
    let value = cash;
    for (const position of positions.values()) {
        const tickerIndex = indexMap.get(position.ticker)?.get(day);
        const candles = candleMap.get(position.ticker);
        if (tickerIndex === undefined || !candles) continue;
        value += position.shares * candles[tickerIndex].close;
    }
    return value;
}

async function fetchUniverseCandles(tickers: string[]): Promise<Map<string, StrategyCandle[]>> {
    const candleMap = new Map<string, StrategyCandle[]>();

    for (const ticker of tickers) {
        const candles = await MarketDataService.getDailyCandles(ticker, 420);
        const normalized = normalizeCandles(candles);
        if (normalized.length >= 260) {
            candleMap.set(ticker, normalized);
        }
    }

    return candleMap;
}

async function main() {
    const tickers = await loadUniverse();
    if (tickers.length === 0) {
        throw new Error('No tickers available for backtest. Populate monitored_prospects first.');
    }

    const allTickers = [...new Set([...tickers, 'SPY'])];
    console.log(`[Backtest] Loading daily candles for ${allTickers.length} tickers...`);
    const candleMap = await fetchUniverseCandles(allTickers);
    const spyCandles = candleMap.get('SPY');

    if (!spyCandles || spyCandles.length < 260) {
        throw new Error('SPY data unavailable for benchmark.');
    }

    const activeTickers = tickers.filter((ticker) => candleMap.has(ticker));
    if (activeTickers.length === 0) {
        throw new Error('No monitored prospects returned enough history for backtesting.');
    }

    const indexMap = new Map<string, Map<string, number>>();
    for (const [ticker, candles] of candleMap.entries()) {
        indexMap.set(ticker, buildIndexByDate(candles));
    }

    const masterDates = spyCandles.map((candle) => candle.date.slice(0, 10));
    const warmup = 210;
    const startIdx = warmup;
    const endIdx = masterDates.length - 2;

    let cash = INITIAL_CAPITAL;
    const positions = new Map<string, Position>();
    const trades: TradeRecord[] = [];
    const equityCurve: number[] = [];
    const portfolioDates: string[] = [];
    let winningSellTrades = 0;
    let completedSellTrades = 0;

    for (let dayIdx = startIdx; dayIdx <= endIdx; dayIdx++) {
        const day = masterDates[dayIdx];

        for (const [ticker, position] of [...positions.entries()]) {
            const tickerIndex = indexMap.get(ticker)?.get(day);
            const candles = candleMap.get(ticker);
            if (tickerIndex === undefined || !candles || tickerIndex + 1 >= candles.length) continue;

            const currentCandle = candles[tickerIndex];
            const nextCandle = candles[tickerIndex + 1];
            position.highWaterMark = Math.max(position.highWaterMark, currentCandle.high);

            const returnPct = ((currentCandle.close - position.avgCost) / position.avgCost) * 100;
            const heldDays = dayIdx - position.openedIndex;
            const trailDistance = Math.max(position.atr * 1.75, position.avgCost * 0.025);
            const trailStop = position.highWaterMark - trailDistance;

            let sellReason = '';
            let sharesToSell = 0;

            if (returnPct <= -5) {
                sellReason = 'Daily hard stop';
                sharesToSell = position.shares;
            } else if (heldDays >= 2 && currentCandle.close < trailStop) {
                sellReason = 'Daily trailing stop';
                sharesToSell = position.shares;
            } else if (returnPct >= 3 && position.partialSells === 0 && position.shares > 1) {
                sellReason = 'Partial profit +3%';
                sharesToSell = Math.max(1, Math.floor(position.shares * 0.33));
            } else if (returnPct >= 6 && position.partialSells === 1 && position.shares > 1) {
                sellReason = 'Partial profit +6%';
                sharesToSell = Math.max(1, Math.floor(position.shares * 0.5));
            } else if (returnPct >= 9 && position.partialSells >= 2) {
                sellReason = 'Full profit +9%';
                sharesToSell = position.shares;
            } else {
                const signal = analyzeTickerFromCandles(ticker, candles.slice(0, tickerIndex + 1));
                const adx = signal.indicators?.adx ?? 25;
                if (signal.action === 'SELL' && signal.confidence >= 60) {
                    sellReason = signal.reason;
                    sharesToSell = position.shares;
                } else if (heldDays > 10 && returnPct < 1 && adx < 18) {
                    sellReason = `Time exit (${heldDays}d, ADX ${adx.toFixed(0)})`;
                    sharesToSell = position.shares;
                }
            }

            if (sharesToSell > 0) {
                const exitPrice = nextCandle.open > 0 ? nextCandle.open : nextCandle.close;
                cash += sharesToSell * exitPrice;
                trades.push({
                    date: nextCandle.date.slice(0, 10),
                    ticker,
                    type: 'SELL',
                    shares: sharesToSell,
                    price: Number(exitPrice.toFixed(2)),
                    reason: sellReason,
                });

                const realizedPct = ((exitPrice - position.avgCost) / position.avgCost) * 100;
                completedSellTrades++;
                if (realizedPct > 0) winningSellTrades++;

                const remainingShares = position.shares - sharesToSell;
                if (remainingShares <= 0) {
                    positions.delete(ticker);
                } else {
                    positions.set(ticker, {
                        ...position,
                        shares: remainingShares,
                        partialSells: position.partialSells + 1,
                    });
                }
            }
        }

        if (positions.size < MAX_POSITIONS) {
            const portfolioValue = getPortfolioValue(cash, positions, day, candleMap, indexMap);
            const cashFloor = portfolioValue * CASH_FLOOR_PCT;
            const buySignals = activeTickers
                .filter((ticker) => !positions.has(ticker))
                .map((ticker) => {
                    const tickerIndex = indexMap.get(ticker)?.get(day);
                    const candles = candleMap.get(ticker);
                    if (tickerIndex === undefined || !candles || tickerIndex + 1 >= candles.length) return null;
                    const signal = analyzeTickerFromCandles(ticker, candles.slice(0, tickerIndex + 1));
                    if (signal.action !== 'BUY' || signal.confidence < 65) return null;
                    return { ticker, signal, nextCandle: candles[tickerIndex + 1] };
                })
                .filter(Boolean) as Array<{
                    ticker: string;
                    signal: ReturnType<typeof analyzeTickerFromCandles>;
                    nextCandle: StrategyCandle;
                }>;

            buySignals
                .sort((a, b) => (b.signal.confidence + (b.signal.sentimentBoost ?? 0)) - (a.signal.confidence + (a.signal.sentimentBoost ?? 0)));

            let buysToday = 0;
            for (const candidate of buySignals) {
                if (positions.size >= MAX_POSITIONS || buysToday >= MAX_BUYS_PER_DAY) break;

                const nextOpen = candidate.nextCandle.open > 0 ? candidate.nextCandle.open : candidate.nextCandle.close;
                if (nextOpen <= 0) continue;

                const latestPortfolioValue = getPortfolioValue(cash, positions, day, candleMap, indexMap);
                const size = calculatePositionSize(
                    candidate.signal.confidence,
                    candidate.signal.indicators?.atr ?? 0,
                    nextOpen,
                    latestPortfolioValue,
                    cash,
                    positions.size
                );

                const maxSpend = Math.max(0, cash - cashFloor);
                const spend = Math.min(size, maxSpend);
                const shares = Math.floor(spend / nextOpen);

                if (shares <= 0) continue;

                cash -= shares * nextOpen;
                positions.set(candidate.ticker, {
                    ticker: candidate.ticker,
                    shares,
                    avgCost: nextOpen,
                    atr: candidate.signal.indicators?.atr ?? 0,
                    highWaterMark: nextOpen,
                    openedIndex: dayIdx + 1,
                    partialSells: 0,
                });
                trades.push({
                    date: candidate.nextCandle.date.slice(0, 10),
                    ticker: candidate.ticker,
                    type: 'BUY',
                    shares,
                    price: Number(nextOpen.toFixed(2)),
                    reason: candidate.signal.reason,
                });
                buysToday++;
            }
        }

        const equity = getPortfolioValue(cash, positions, day, candleMap, indexMap);
        equityCurve.push(equity);
        portfolioDates.push(day);
    }

    const endingCapital = equityCurve[equityCurve.length - 1] ?? INITIAL_CAPITAL;
    const startDate = portfolioDates[0];
    const endDate = portfolioDates[portfolioDates.length - 1];
    const splitIdx = Math.floor(equityCurve.length * 0.7);
    const splitDate = portfolioDates[splitIdx] ?? endDate;
    const inSampleStart = equityCurve[0] ?? INITIAL_CAPITAL;
    const inSampleEnd = equityCurve[splitIdx] ?? endingCapital;
    const outSampleStart = equityCurve[splitIdx] ?? endingCapital;

    const benchmarkStart = spyCandles[startIdx].close;
    const benchmarkEnd = spyCandles[endIdx].close;

    const result: BacktestResult = {
        generatedAt: new Date().toISOString(),
        tickers: activeTickers,
        strategy: {
            startDate,
            endDate,
            initialCapital: INITIAL_CAPITAL,
            endingCapital: Number(endingCapital.toFixed(2)),
            totalReturnPct: Number((((endingCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100).toFixed(2)),
            maxDrawdownPct: Number(getMaxDrawdownPct(equityCurve).toFixed(2)),
            trades: trades.length,
            winRatePct: Number((completedSellTrades > 0 ? (winningSellTrades / completedSellTrades) * 100 : 0).toFixed(2)),
        },
        benchmark: {
            ticker: 'SPY',
            totalReturnPct: Number((((benchmarkEnd - benchmarkStart) / benchmarkStart) * 100).toFixed(2)),
        },
        holdout: {
            splitDate,
            inSampleReturnPct: Number((((inSampleEnd - inSampleStart) / inSampleStart) * 100).toFixed(2)),
            outOfSampleReturnPct: Number((outSampleStart > 0 ? ((endingCapital - outSampleStart) / outSampleStart) * 100 : 0).toFixed(2)),
        },
        trades,
    };

    const outDir = path.join(process.cwd(), 'data', 'backtests');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'daily-swing-latest.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

    console.log(JSON.stringify(result, null, 2));
    console.log(`\n[Backtest] Wrote results to ${outPath}`);

    process.exit(0);
}

main().catch((error) => {
    console.error('[Backtest] Failed:', error);
    process.exit(1);
});
