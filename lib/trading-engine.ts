
import { getPool } from './db';
import { getPortfolioStatus, getHoldings, executeTrade, updatePortfolioStatus, saveAnalysisResult, saveCycleLog, getDailySnapshots, getIntradayBars, updateHoldingPrice, updateHighWaterMark, saveHistorySnapshot, savePortfolioSnapshot, cleanupOldSnapshots, getRecentStopLossSells } from './portfolio-db';
import { MarketDataService } from './market-data';
import { getSentimentScore } from './sentiment';

// ══════════════════════════════════════════════════════════════════════
// INTERFACES
// ══════════════════════════════════════════════════════════════════════

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
        rvol?: number;
        vwap?: number;
        atr?: number;
        adx?: number;
        stochRsi?: number;
        obv?: number;
    };
}

interface TechnicalIndicators {
    ema10: number;
    ema50: number;
    rsi: number;
    macd: { macd: number; signal: number; histogram: number };
    volumeRatio: number;
    bollingerBands: { upper: number; middle: number; lower: number };
    priceChange: number;
    atr: number;
    adx: number;
    stochRsi: number;
    obvTrend: number; // positive = accumulation, negative = distribution
}

// ══════════════════════════════════════════════════════════════════════
// MARKET HOURS
// ══════════════════════════════════════════════════════════════════════

export function isMarketOpen(): boolean {
    const now = new Date();
    const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const et = new Date(etStr);
    const day = et.getDay();
    const hour = et.getHours();
    const minute = et.getMinutes();
    if (day === 0 || day === 6) return false;
    const time = hour + minute / 60;
    return time >= 9.5 && time < 16;
}

// ══════════════════════════════════════════════════════════════════════
// CORE TRADING ENGINE
// ══════════════════════════════════════════════════════════════════════

/**
 * Core Trading Cycle — Revamped for multi-position intraday/swing trading.
 *
 * OPEN/MID/CLOSE: full cycle (sync → sell logic → buy scan)
 * PORTFOLIO_CHECK: sync + trailing stops + partial profits + sell signals (no new buys)
 *
 * Key improvements over v1:
 * - ATR-based trailing stops instead of fixed -4%
 * - Partial profit taking at +2%/+4%/+6%
 * - Gap protection (gap-down exit, gap-fill partial)
 * - Up to 4 buys per cycle (was 1-2)
 * - Dynamic position sizing by confidence + risk
 * - ADX trend strength filter
 * - StochRSI timing + OBV confirmation
 */
export async function runTradingCycle(type: 'OPEN' | 'MID' | 'CLOSE' | 'PORTFOLIO_CHECK') {
    console.log(`[Engine] Starting Trading Cycle: ${type}`);
    const db = getPool();
    const summaryLines: string[] = [];
    const isPortfolioOnly = type === 'PORTFOLIO_CHECK';

    // ── 1. Sync Current Prices + Update High Water Marks ──
    const holdings = await getHoldings();
    let totalEquity = 0;
    summaryLines.push(`Holdings: ${holdings.length} (${holdings.map(h => h.ticker).join(', ') || 'none'})`);

    for (const holding of holdings) {
        try {
            const price = await MarketDataService.getCurrentPrice(holding.ticker);
            if (price) {
                totalEquity += price * holding.shares;
                await updateHoldingPrice(holding.ticker, price).catch(() => { });
                // Always update high water mark for trailing stop
                await updateHighWaterMark(holding.ticker, price).catch(() => { });
            } else {
                totalEquity += holding.market_value;
            }
        } catch (e) {
            console.error(`[Engine] Price sync failed for ${holding.ticker}`, e);
            totalEquity += holding.market_value;
        }
    }

    // Update global status
    const status = await getPortfolioStatus();
    await updatePortfolioStatus(status.cash_balance, totalEquity);

    // ── 2. Sell Logic: Trail Stops, Partial Profits, Signals ──
    const currentHoldings = await getHoldings(); // re-fetch after price sync
    // Cache analyzeTicker results within this cycle so each ticker is only analyzed once.
    const analysisCache = new Map<string, TradeSignal>();
    const getCachedSignal = async (ticker: string): Promise<TradeSignal> => {
        if (!analysisCache.has(ticker)) {
            analysisCache.set(ticker, await analyzeTicker(ticker));
        }
        return analysisCache.get(ticker)!;
    };
    for (const holding of currentHoldings) {
        const price = holding.current_price;
        if (!price || price <= 0) continue;

        const returnPct = ((price - holding.avg_cost) / holding.avg_cost) * 100;
        const daysHeld = holding.opened_at
            ? (Date.now() - new Date(holding.opened_at).getTime()) / (1000 * 60 * 60 * 24)
            : 0;

        // ─── 2a. ATR-Based Trailing Stop ───
        // If no ATR stored, use 3% of avg_cost as fallback (2% was too tight)
        const atr = holding.atr > 0 ? holding.atr : (holding.avg_cost * 0.03);
        // Tighten the trailing stop if we're decently in profit (> 2%)
        const trailMultiplier = returnPct > 2 ? 1.5 : 2.0;
        const trailDistance = trailMultiplier * atr;
        const hwm = holding.high_water_mark || holding.avg_cost;
        const trailStopPrice = hwm - trailDistance;

        // Hard stop: if down more than 5% from cost basis, exit regardless
        if (returnPct <= -5) {
            const sellShares = holding.shares;
            await executeTrade(holding.ticker, 'SELL', sellShares, price,
                `Hard Stop -5%: ${returnPct.toFixed(1)}% (cost $${holding.avg_cost.toFixed(2)})`);
            summaryLines.push(`  SELL ${holding.ticker}: hard stop -5% (${returnPct.toFixed(1)}%)`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (sellShares * price), totalEquity - (sellShares * price));
            totalEquity -= sellShares * price;
            continue;
        }

        // Trailing stop activation: require HWM to have reached a meaningful level
        // above entry before the trail can trigger. This prevents noise kills on
        // positions that never confirmed the thesis. 6 of 10 trailing stop losses
        // in the last 10 days occurred on positions where HWM was < 1% above entry.
        const trailActivationMin = holding.avg_cost + Math.min(holding.avg_cost * 0.015, atr);
        const trailIsActive = hwm >= trailActivationMin;

        if (daysHeld >= 0.5 && trailIsActive && price < trailStopPrice) {
            const sellShares = holding.shares;
            await executeTrade(holding.ticker, 'SELL', sellShares, price,
                `Trailing Stop: Price $${price.toFixed(2)} < Trail $${trailStopPrice.toFixed(2)} (HWM $${hwm.toFixed(2)}, ATR $${atr.toFixed(2)})`);
            summaryLines.push(`  SELL ${holding.ticker}: trailing stop (${returnPct.toFixed(1)}%)`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (sellShares * price), totalEquity - (sellShares * price));
            totalEquity -= sellShares * price;
            continue;
        }

        // ─── 2b. Gap Protection ───
        // If today's open gapped significantly from yesterday's close:
        // - Gap DOWN > 3% on a losing position → exit immediately (don't wait for -5% hard stop)
        // - Gap UP > 3% but price filling below open → lock in early partial to protect gains
        const partialSells = holding.partial_sells || 0;
        try {
            const gapCandles = await MarketDataService.getDailyCandles(holding.ticker, 5);
            if (gapCandles.length >= 2) {
                const todayCandle = gapCandles[gapCandles.length - 1];
                const yesterdayCandle = gapCandles[gapCandles.length - 2];
                const gapPct = ((todayCandle.open - yesterdayCandle.close) / yesterdayCandle.close) * 100;

                // Gap-down: opened sharply lower and position is underwater → bail out
                if (gapPct < -3 && returnPct < 0) {
                    await executeTrade(holding.ticker, 'SELL', holding.shares, price,
                        `Gap-Down Exit: ${gapPct.toFixed(1)}% gap, position at ${returnPct.toFixed(1)}%`);
                    summaryLines.push(`  SELL ${holding.ticker}: gap-down ${gapPct.toFixed(1)}% exit (${returnPct.toFixed(1)}%)`);
                    const fresh = await getPortfolioStatus();
                    await updatePortfolioStatus(fresh.cash_balance + (holding.shares * price), totalEquity - (holding.shares * price));
                    totalEquity -= holding.shares * price;
                    continue;
                }

                // Gap-up fill: big gap up but price reversing below open → protect gains
                if (gapPct > 3 && price < todayCandle.open && returnPct > 0 && partialSells === 0 && holding.shares > 1) {
                    const sellShares = Math.max(1, Math.floor(holding.shares * 0.33));
                    await executeTrade(holding.ticker, 'SELL', sellShares, price,
                        `Gap-Fill Protect: ${gapPct.toFixed(1)}% gap filling, locking 33% at ${returnPct.toFixed(1)}%`);
                    summaryLines.push(`  PARTIAL SELL ${holding.ticker}: gap-fill protection (${gapPct.toFixed(1)}% gap)`);
                    const fresh = await getPortfolioStatus();
                    await updatePortfolioStatus(fresh.cash_balance + (sellShares * price), totalEquity - (sellShares * price));
                    totalEquity -= sellShares * price;
                    continue;
                }
            }
        } catch (e) { console.error(`[Engine] Gap check failed for ${holding.ticker}`, e); }

        // ─── 2c. Scaled Partial Profit Taking ───

        // +2% → sell 33% (first partial)
        if (returnPct >= 2 && partialSells === 0 && holding.shares > 1) {
            const sellShares = Math.max(1, Math.floor(holding.shares * 0.33));
            await executeTrade(holding.ticker, 'SELL', sellShares, price,
                `Partial Profit +2% (1/3 position, ${returnPct.toFixed(1)}%)`);
            summaryLines.push(`  PARTIAL SELL ${holding.ticker}: +2% lock 33%`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (sellShares * price), totalEquity - (sellShares * price));
            totalEquity -= sellShares * price;
            continue; // let the next cycle handle the remaining shares
        }

        // +4% → sell another 33% (second partial)
        if (returnPct >= 4 && partialSells === 1 && holding.shares > 1) {
            const sellShares = Math.max(1, Math.floor(holding.shares * 0.5)); // 50% of remaining ≈ 33% original
            await executeTrade(holding.ticker, 'SELL', sellShares, price,
                `Partial Profit +4% (2/3 position, ${returnPct.toFixed(1)}%)`);
            summaryLines.push(`  PARTIAL SELL ${holding.ticker}: +4% lock 50% remaining`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (sellShares * price), totalEquity - (sellShares * price));
            totalEquity -= sellShares * price;
            continue;
        }

        // +6% or more → sell remaining (full exit)
        if (returnPct >= 6 && partialSells >= 2) {
            await executeTrade(holding.ticker, 'SELL', holding.shares, price,
                `Full Profit Exit +6% (${returnPct.toFixed(1)}%)`);
            summaryLines.push(`  SELL ${holding.ticker}: full exit at +6%`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (holding.shares * price), totalEquity - (holding.shares * price));
            totalEquity -= holding.shares * price;
            continue;
        }

        // ─── 2d. ADX Trend Death + Time Exit ───
        // If held > 2 days, trend is dying (ADX < 15), and position is flat/red → exit
        if (daysHeld > 2 && returnPct < 1) {
            const signal = await getCachedSignal(holding.ticker);
            const adx = signal.indicators?.adx ?? 25;

            if (adx < 15 || (signal.action === 'SELL' && signal.confidence >= 60)) {
                await executeTrade(holding.ticker, 'SELL', holding.shares, price,
                    `Trend Exit: ADX ${adx.toFixed(0)}, ${daysHeld.toFixed(1)}d held, ${returnPct.toFixed(1)}%`);
                summaryLines.push(`  SELL ${holding.ticker}: trend died (ADX ${adx.toFixed(0)}, ${daysHeld.toFixed(1)}d)`);
                const fresh = await getPortfolioStatus();
                await updatePortfolioStatus(fresh.cash_balance + (holding.shares * price), totalEquity - (holding.shares * price));
                totalEquity -= holding.shares * price;
                continue;
            }
        }

        // ─── 2e. Full Analysis Sell Signal ───
        // Only run full analysis if not already handled above
        if (type !== 'PORTFOLIO_CHECK' || daysHeld > 1) {
            const signal = await getCachedSignal(holding.ticker);
            try {
                await saveAnalysisResult({
                    ticker: holding.ticker, action: signal.action,
                    confidence: signal.confidence, reason: signal.reason,
                    sentimentScore: signal.sentimentBoost ? signal.sentimentBoost / 10 : undefined,
                    sentimentConfidence: signal.sentimentBoost ? Math.abs(signal.sentimentBoost) / 10 : undefined,
                    rsi: signal.indicators?.rsi, macdHistogram: signal.indicators?.macdHistogram,
                    volumeRatio: signal.indicators?.volumeRatio, priceChangePct: signal.indicators?.priceChangePct,
                    sma50: signal.indicators?.sma50, sma200: signal.indicators?.sma200,
                });
            } catch (e) { console.error(`Failed to save analysis for ${holding.ticker}`, e); }

            summaryLines.push(`  ${holding.ticker}: ${signal.action} (${signal.confidence}%) - ${signal.reason}`);

            if (signal.action === 'SELL' && signal.confidence >= 60) {
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
                        totalEquity -= holding.shares * currentPrice;
                    }
                } catch (e) { console.error(e); }
            }
        }
    }

    // Heartbeat
    try {
        await saveAnalysisResult({
            ticker: '_cycle', action: 'HOLD', confidence: 0,
            reason: `Cycle ${type} completed`,
        });
    } catch (e) { console.error('Heartbeat save failed', e); }

    // ── 3. Buy Logic (OPEN/MID/CLOSE only) ──
    if (isPortfolioOnly) {
        summaryLines.push('PORTFOLIO_CHECK: no buy scan.');
        try { await saveCycleLog(type, summaryLines.join('\n')); } catch (e) { console.error('saveCycleLog failed', e); }
        // Save high-frequency portfolio snapshot for chart
        try { await savePortfolioSnapshot(); } catch (e) { console.error('savePortfolioSnapshot failed', e); }
        console.log('[Engine] PORTFOLIO_CHECK complete, skipping buy scan.');
        return;
    }

    const freshStatus = await getPortfolioStatus();
    const updatedHoldings = await getHoldings();

    // Dynamic cash floor: keep 20% of portfolio liquid (min $1000)
    const cashFloor = Math.max(1000, freshStatus.total_value * 0.20);
    // Hard ceiling at 15. Research: 12-20 stocks cuts ~80% of idiosyncratic risk.
    // With ~$100K and confidence-weighted sizing, 8-12 is the practical sweet spot;
    // 15 is a hard cap for exceptional signals only.
    const MAX_POSITIONS = 15;
    const isFirstCycleToday = updatedHoldings.length <= 1;
    const MAX_BUYS_PER_CYCLE = isFirstCycleToday ? 4 : 2;

    const candidates = await getBuyCandidates();
    const top5 = candidates.slice(0, 5);

    if (freshStatus.cash_balance <= cashFloor || updatedHoldings.length >= MAX_POSITIONS) {
        summaryLines.push(`No buy: ${freshStatus.cash_balance <= cashFloor ? `cash ≤ floor $${cashFloor.toFixed(0)}` : `max positions (${MAX_POSITIONS})`}. Top 5:`);
        for (const c of top5) {
            summaryLines.push(`  ${c.ticker} ${c.confidence}% - ${freshStatus.cash_balance <= cashFloor ? 'low cash' : 'at max positions'}`);
        }
        try { await saveCycleLog(type, summaryLines.join('\n')); } catch (e) { console.error('saveCycleLog failed', e); }
        try { await savePortfolioSnapshot(); } catch (e) { console.error('savePortfolioSnapshot failed', e); }
        console.log('[Engine] Trading Cycle Completed (no buys)');
        return;
    }

    let bought: string[] = [];
    let buyCount = 0;

    // ─── Re-Entry Cooldown: prevent whipsaw (stop-loss → immediate re-buy) ───
    let recentlyStoppedOut = new Set<string>();
    try {
        recentlyStoppedOut = await getRecentStopLossSells(3); // 3-day cooldown
    } catch (e) { console.error('[Engine] Failed to fetch recent stop-loss sells', e); }

    for (const candidate of candidates) {
        if (buyCount >= MAX_BUYS_PER_CYCLE) break;

        // Skip if already holding
        if (updatedHoldings.find(h => h.ticker === candidate.ticker)) {
            if (top5.some(c => c.ticker === candidate.ticker)) {
                summaryLines.push(`  ${candidate.ticker} ${candidate.confidence}% - already holding (skip)`);
            }
            continue;
        }

        // Skip if recently stopped out (3-day cooldown to prevent whipsaw)
        if (recentlyStoppedOut.has(candidate.ticker)) {
            if (top5.some(c => c.ticker === candidate.ticker)) {
                summaryLines.push(`  ${candidate.ticker} ${candidate.confidence}% - cooldown (recently stopped out, skip)`);
            }
            continue;
        }

        // ─── Dynamic Position Sizing ───
        const positionSize = calculatePositionSize(
            candidate.confidence,
            candidate.indicators?.atr || 0,
            freshStatus.total_value,
            freshStatus.cash_balance,
            updatedHoldings.length + buyCount
        );

        if (positionSize < 500) {
            if (top5.some(c => c.ticker === candidate.ticker)) {
                summaryLines.push(`  ${candidate.ticker} ${candidate.confidence}% - position too small $${positionSize.toFixed(0)} (skip)`);
            }
            continue;
        }

        // Dynamic confidence gate — tuned for 8-12 position sweet spot.
        // Below 8: base 65% lets the portfolio build up quickly.
        // 8-9: 72% is achievable but filters out marginal setups.
        // 10-11: 80% demands strong signals to justify incremental positions.
        // 12+: 88% makes additional positions exceptional-only.
        let requiredConfidence = 65;
        const currentCount = updatedHoldings.length + buyCount;
        if (currentCount >= 12) requiredConfidence = 88;
        else if (currentCount >= 10) requiredConfidence = 80;
        else if (currentCount >= 8) requiredConfidence = 72;

        if (candidate.confidence < requiredConfidence) {
            if (top5.some(c => c.ticker === candidate.ticker)) {
                summaryLines.push(`  ${candidate.ticker} ${candidate.confidence}% - below dynamic threshold ${requiredConfidence}% (skip)`);
            }
            continue;
        }

        // Don't spend more than available - cashFloor
        const maxSpend = freshStatus.cash_balance - cashFloor;
        const actualSize = Math.min(positionSize, maxSpend);
        if (actualSize < 500) continue;

        try {
            const currentPrice = await MarketDataService.getCurrentPrice(candidate.ticker);
            if (currentPrice && currentPrice > 0) {
                const shares = Math.floor(actualSize / currentPrice);
                if (shares > 0) {
                    await executeTrade(
                        candidate.ticker, 'BUY', shares, currentPrice,
                        candidate.reason,
                        { atr: candidate.indicators?.atr || 0 }
                    );
                    bought.push(`${candidate.ticker} (${shares}×$${currentPrice.toFixed(2)}, conf ${candidate.confidence}%)`);
                    const postBuyStatus = await getPortfolioStatus();
                    await updatePortfolioStatus(
                        postBuyStatus.cash_balance - (shares * currentPrice),
                        postBuyStatus.total_equity + (shares * currentPrice)
                    );
                    buyCount++;
                }
            }
        } catch (e) { console.error(e); }
    }

    if (bought.length) summaryLines.push('Bought: ' + bought.join(', '));
    else if (top5.length) {
        summaryLines.push('Top candidates not bought:');
        for (const c of top5) {
            const why = updatedHoldings.find(h => h.ticker === c.ticker) ? 'already holding'
                : c.confidence < 65 ? `confidence ${c.confidence}% < 65%`
                    : 'position size or cash';
            summaryLines.push(`  ${c.ticker} ${c.confidence}% - ${why}`);
        }
    }

    try { await saveCycleLog(type, summaryLines.join('\n')); } catch (e) { console.error('saveCycleLog failed', e); }

    // Save high-frequency portfolio snapshot for chart
    try { await savePortfolioSnapshot(); } catch (e) { console.error('savePortfolioSnapshot failed', e); }

    // Save EOD History + cleanup
    if (type === 'CLOSE') {
        try {
            await saveHistorySnapshot();
            console.log('[Engine] EOD portfolio history snapshot saved.');
        } catch (e) { console.error('Failed to save daily history snapshot', e); }
        try {
            const cleaned = await cleanupOldSnapshots();
            if (cleaned > 0) console.log(`[Engine] Cleaned ${cleaned} old portfolio snapshots.`);
        } catch (e) { console.error('cleanupOldSnapshots failed', e); }
    }

    console.log('[Engine] Trading Cycle Completed');
}

// ══════════════════════════════════════════════════════════════════════
// DYNAMIC POSITION SIZING
// ══════════════════════════════════════════════════════════════════════

/**
 * Calculate position size dynamically based on confidence factor.
 *
 * Confidence-weighted sizing rewards high-conviction setups:
 *   ~65% confidence -> ~5.5% of portfolio  (threshold entry)
 *   ~75% confidence -> ~8.4%               (good setup)
 *   ~85% confidence -> ~12.3%              (strong setup, near cap)
 *   ~90% confidence -> ~14.6%              (capped to 12%)
 *
 * Hard cap: 12% of total portfolio per position to prevent concentration risk.
 * NEM at 13.5% was the largest single-trade loss in the last 10 days.
 */
function calculatePositionSize(
    confidence: number,
    atr: number,
    totalValue: number,
    cashAvailable: number,
    currentPositions: number
): number {
    const confidenceRatio = Math.max(0, Math.min(100, confidence)) / 100;
    const basePct = Math.pow(confidenceRatio, 3) * 0.20;

    let size = totalValue * basePct;

    // Hard cap: no single position larger than 12% of total portfolio
    size = Math.min(size, totalValue * 0.12);

    // Cash guard: never use more than 40% of remaining liquid cash
    // (was 50%, but caused outsized bets when cash was high after sells)
    size = Math.min(size, cashAvailable * 0.40);

    // ATR risk adjustment: volatile stocks get smaller positions
    if (atr > 0) {
        const estimatedPrice = size > 0 ? cashAvailable / 10 : 100;
        const atrPctOfPrice = (atr / estimatedPrice) * 100;
        if (atrPctOfPrice > 5) {
            size *= 0.5;
        } else if (atrPctOfPrice > 3) {
            size *= 0.7;
        }
    }

    return Math.max(0, size);
}

// ══════════════════════════════════════════════════════════════════════
// BUY CANDIDATE SCREENING
// ══════════════════════════════════════════════════════════════════════

async function getBuyCandidates(): Promise<TradeSignal[]> {
    const db = getPool();

    // Fetch monitored prospects (updated by external scan)
    const query = `SELECT ticker FROM monitored_prospects ORDER BY score DESC`;
    const result = await db.query(query);
    const signals: TradeSignal[] = [];

    for (const row of result.rows) {
        const analysis = await analyzeTicker((row as any).ticker);

        try {
            await saveAnalysisResult({
                ticker: (row as any).ticker,
                action: analysis.action, confidence: analysis.confidence,
                reason: analysis.reason,
                sentimentScore: analysis.sentimentBoost ? analysis.sentimentBoost / 10 : undefined,
                sentimentConfidence: analysis.sentimentBoost ? Math.abs(analysis.sentimentBoost) / 10 : undefined,
                rsi: analysis.indicators?.rsi, macdHistogram: analysis.indicators?.macdHistogram,
                volumeRatio: analysis.indicators?.volumeRatio, priceChangePct: analysis.indicators?.priceChangePct,
                sma50: analysis.indicators?.sma50, sma200: analysis.indicators?.sma200,
            });
        } catch (e) { console.error(`Failed to save analysis for ${(row as any).ticker}`, e); }

        // Lower threshold: 65% (was 68%) for more buy opportunities
        if (analysis.action === 'BUY' && analysis.confidence >= 65) {
            signals.push(analysis);
        }
    }

    // Sort by total confidence (including sentiment boost)
    return signals.sort((a, b) => {
        const totalA = a.confidence + (a.sentimentBoost || 0);
        const totalB = b.confidence + (b.sentimentBoost || 0);
        return totalB - totalA;
    });
}

// ══════════════════════════════════════════════════════════════════════
// HISTORICAL CONTEXT (Turso RVOL + VWAP)
// ══════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════
// TICKER ANALYSIS (Enhanced with ATR, ADX, StochRSI, OBV)
// ══════════════════════════════════════════════════════════════════════

/**
 * Analyze a single ticker with enhanced indicator suite.
 * Uses: EMA10/50, RSI, MACD, Bollinger Bands, ATR, ADX, StochRSI, OBV,
 *       RVOL, VWAP, Sentiment, Macro (FRED VIX), Fundamentals (FMP).
 */
export async function analyzeTicker(ticker: string): Promise<TradeSignal> {
    try {
        const quotes = await MarketDataService.getDailyCandles(ticker, 200);
        if (quotes.length < 50) return { ticker, action: 'HOLD', reason: 'Not enough data', confidence: 0 };

        const current = quotes[quotes.length - 1];
        const closes = quotes.map((q: any) => q.close || 0);
        const volumes = quotes.map((q: any) => q.volume || 0);
        const highs = quotes.map((q: any) => q.high || q.close || 0);
        const lows = quotes.map((q: any) => q.low || q.close || 0);

        const ind = calculateIndicators(closes, volumes, highs, lows);

        // Historical context (RVOL, VWAP)
        const hist = await getHistoricalContext(ticker);
        const rvol = hist?.rvol ?? ind.volumeRatio;
        const vwap = hist?.vwap ?? 0;
        const priceAboveVwap = vwap > 0 && current.close > vwap;

        // Sentiment
        const sentiment = await getSentimentScore(ticker);
        const sentimentBoost = sentiment.score * 10 * sentiment.confidence;

        // Helper to build indicator object
        const makeIndicators = () => ({
            rsi: ind.rsi,
            macdHistogram: ind.macd.histogram,
            volumeRatio: ind.volumeRatio,
            priceChangePct: ind.priceChange,
            sma50: ind.ema10,
            sma200: ind.ema50,
            rvol,
            vwap: vwap || undefined,
            atr: ind.atr,
            adx: ind.adx,
            stochRsi: ind.stochRsi,
            obv: ind.obvTrend,
        });

        // ═══════ BUY SIGNAL ANALYSIS ═══════
        const buySignals: string[] = [];
        let buyConfidence = 0;

        // 1. Trend: EMA10 > EMA50 and price > EMA50
        const isUptrend = ind.ema10 > ind.ema50;
        const priceAboveTrend = current.close > ind.ema50;

        if (isUptrend && priceAboveTrend) {
            // 2. ADX Trend Strength — require confirmed trend (>= 25)
            // ADX 20-24 ("trend developing") entries had ~10% win rate vs ~50%+ for ADX >= 25.
            // Eliminating the 20-24 tier removes the largest single source of losing trades.
            if (ind.adx >= 25) {
                buyConfidence += 15;
                buySignals.push(`ADX ${ind.adx.toFixed(0)} (trend confirmed)`);
            } else {
                return {
                    ticker, action: 'HOLD',
                    reason: `ADX too low (${ind.adx.toFixed(0)}) — trend not confirmed`,
                    confidence: 30, indicators: makeIndicators(),
                };
            }

            // 3. RSI Dip Buy in Uptrend
            if (ind.rsi < 40 && ind.rsi > 25) {
                buyConfidence += 25;
                buySignals.push(`RSI ${Math.round(ind.rsi)} (oversold dip buy)`);
            } else if (ind.rsi <= 25) {
                // Extremely oversold — could be in freefall, not a dip
                buyConfidence += 5;
                buySignals.push(`RSI ${Math.round(ind.rsi)} (extreme oversold, caution)`);
            } else if (ind.rsi < 50 && current.close > ind.ema10) {
                buyConfidence += 15;
                buySignals.push(`RSI ${Math.round(ind.rsi)} (momentum pullback)`);
            } else if (ind.rsi < 60) {
                buyConfidence += 5;
                buySignals.push(`RSI ${Math.round(ind.rsi)} (neutral)`);
            } else if (ind.rsi >= 65) {
                // Overbought — penalize, don't buy into extended moves
                buyConfidence -= 10;
                buySignals.push(`RSI ${Math.round(ind.rsi)} (overbought, risky entry)`);
            }

            // 4. StochRSI Cross-Up (buy timing)
            // Recalibrated: was +20 for oversold bounce, capped at +12 to prevent
            // confidence inflation from this single indicator.
            if (ind.stochRsi > 5 && ind.stochRsi < 30) {
                buyConfidence += 12;
                buySignals.push(`StochRSI ${ind.stochRsi.toFixed(0)} (oversold bounce)`);
            } else if (ind.stochRsi >= 30 && ind.stochRsi < 50) {
                buyConfidence += 5;
                buySignals.push(`StochRSI ${ind.stochRsi.toFixed(0)}`);
            } else if (ind.stochRsi <= 5) {
                // Hard gate: StochRSI <= 5 entries lost $938 in 10 days.
                // Wait for bounce above 10 before considering entry.
                return {
                    ticker, action: 'HOLD',
                    reason: `StochRSI ${ind.stochRsi.toFixed(0)} — falling knife, waiting for bounce`,
                    confidence: 20, indicators: makeIndicators(),
                };
            }

            // 5. MACD Bullish
            if (ind.macd.histogram > 0 && ind.macd.macd > ind.macd.signal) {
                buyConfidence += 15;
                buySignals.push('MACD bullish');
            } else if (ind.macd.histogram > 0) {
                buyConfidence += 5;
            } else if (ind.macd.histogram < 0 && ind.macd.macd < ind.macd.signal) {
                // Bearish MACD in an apparent uptrend = divergence warning
                buyConfidence -= 12;
                buySignals.push('MACD bearish divergence');
            }

            // 6. Volume Confirmation
            if (ind.volumeRatio > 1.3) {
                buyConfidence += 12;
                buySignals.push(`Volume +${Math.round((ind.volumeRatio - 1) * 100)}%`);
            } else if (ind.volumeRatio > 1.1) {
                buyConfidence += 5;
            }

            // 7. RVOL (relative volume from Turso)
            if (rvol > 1.5) {
                buyConfidence += 6;
                buySignals.push(`RVOL ${rvol.toFixed(1)}x`);
            } else if (rvol > 1.2) {
                buyConfidence += 3;
            }

            // 8. VWAP
            if (priceAboveVwap) {
                buyConfidence += 6;
                buySignals.push('Price > VWAP');
            }

            // 9. OBV Accumulation
            if (ind.obvTrend > 0) {
                buyConfidence += 5;
                buySignals.push('OBV accumulation');
            }

            // 10. Bollinger Band position (buy near lower in uptrend)
            // Recalibrated: was +12, now +8 to prevent confidence inflation.
            const bbRange = ind.bollingerBands.upper - ind.bollingerBands.lower;
            if (bbRange > 0) {
                const bbPosition = (current.close - ind.bollingerBands.lower) / bbRange;
                if (bbPosition < 0.3 && isUptrend) {
                    buyConfidence += 8;
                    buySignals.push('Near BB lower band');
                }
            }

            // 11. Price Momentum
            if (ind.priceChange > 5 && ind.priceChange < 15) {
                buyConfidence += 8;
                buySignals.push(`+${ind.priceChange.toFixed(1)}% momentum`);
            } else if (ind.priceChange >= 15) {
                // Already extended > 15% in 20 days, risky chase
                buyConfidence -= 5;
                buySignals.push(`+${ind.priceChange.toFixed(1)}% (extended, late entry risk)`);
            } else if (ind.priceChange > 2) {
                buyConfidence += 3;
            } else if (ind.priceChange < -5) {
                // Declining price in supposed uptrend = contradictory
                buyConfidence -= 8;
                buySignals.push(`${ind.priceChange.toFixed(1)}% (price declining)`);
            }

            // 12. Sentiment
            if (sentiment.score > 0.2 && sentiment.confidence > 0.5) {
                const boost = Math.min(10, sentiment.score * 15);
                buyConfidence += boost;
                buySignals.push(`Positive sentiment (+${boost.toFixed(0)})`);
            }

            // ─── Gate: only proceed to macro/fundamental checks if strong enough ───
            if (buyConfidence >= 65) {
                // Macro check (FRED VIX)
                const macro = await MarketDataService.getMacroTrend();
                if (!macro.safeToTrade) {
                    return {
                        ticker, action: 'HOLD',
                        reason: `Macro Block: ${macro.reason} (Setup was ${buyConfidence}%)`,
                        confidence: 0,
                    };
                }

                // Fundamental check (FMP)
                const fins = await MarketDataService.getDeepFinancials(ticker);
                if (fins?.financials?.income_statement) {
                    const netIncome = fins.financials.income_statement.net_income_loss?.value;
                    if (netIncome !== null && netIncome !== undefined && netIncome < 0) {
                        buySignals.push('⚠ Negative Net Income');
                        buyConfidence = Math.max(0, buyConfidence - 12);
                    } else if (netIncome !== null && netIncome !== undefined && netIncome > 0) {
                        buySignals.push('Positive GAAP Income');
                        buyConfidence += 4;
                    }
                }

                const finalAction = buyConfidence >= 65 ? 'BUY' : 'HOLD';
                return {
                    ticker, action: finalAction,
                    reason: buySignals.join(', '),
                    confidence: Math.min(95, buyConfidence),
                    sentimentBoost,
                    indicators: makeIndicators(),
                };
            }
        }

        // ═══════ SELL SIGNAL ANALYSIS ═══════
        const sellSignals: string[] = [];
        let sellConfidence = 0;

        const isDowntrend = ind.ema10 < ind.ema50 || current.close < ind.ema50;
        const isStrongDowntrend = ind.ema10 < ind.ema50 * 0.95 && current.close < ind.ema10;

        if (isDowntrend || isStrongDowntrend) {
            // RSI Overbought in downtrend
            if (ind.rsi > 65) {
                sellConfidence += 25;
                sellSignals.push(`RSI ${Math.round(ind.rsi)} (overbought in downtrend)`);
            }

            // MACD Bearish
            if (ind.macd.histogram < 0 && ind.macd.macd < ind.macd.signal) {
                sellConfidence += 20;
                sellSignals.push('MACD bearish');
            }

            // ADX Strong Downtrend
            if (ind.adx > 25 && isStrongDowntrend) {
                sellConfidence += 15;
                sellSignals.push(`ADX ${ind.adx.toFixed(0)} (strong downtrend)`);
            }

            // StochRSI Overbought
            if (ind.stochRsi > 80) {
                sellConfidence += 10;
                sellSignals.push(`StochRSI ${ind.stochRsi.toFixed(0)} (overbought)`);
            }

            // Death Cross
            if (ind.ema10 < ind.ema50 && quotes.length >= 51) {
                const prevCloses = closes.slice(0, -1);
                const prevEma10 = calculateEMA(prevCloses, 10);
                const prevEma50 = calculateEMA(prevCloses, 50);
                if (prevEma10.length > 0 && prevEma50.length > 0) {
                    const pe10 = prevEma10[prevEma10.length - 1];
                    const pe50 = prevEma50[prevEma50.length - 1];
                    if (pe10 >= pe50 && ind.ema10 < ind.ema50) {
                        sellConfidence += 15;
                        sellSignals.push('Death cross (EMA10 × EMA50)');
                    }
                }
            }

            // Negative sentiment
            if (sentiment.score < -0.2 && sentiment.confidence > 0.5) {
                sellConfidence += 12;
                sellSignals.push('Negative sentiment');
            }

            // Volume spike on decline
            if (ind.volumeRatio > 1.5 && current.close < (closes[closes.length - 2] || current.close)) {
                sellConfidence += 10;
                sellSignals.push('High volume decline');
            }

            // OBV Distribution
            if (ind.obvTrend < 0) {
                sellConfidence += 8;
                sellSignals.push('OBV distribution');
            }

            // Price below VWAP
            if (!priceAboveVwap && vwap > 0) {
                sellConfidence += 6;
                sellSignals.push('Price < VWAP');
            }

            // RVOL spike on decline
            if (rvol > 1.5 && current.close < (closes[closes.length - 2] || current.close)) {
                sellConfidence += 6;
                sellSignals.push('RVOL spike on decline');
            }

            if (sellConfidence >= 60) {
                return {
                    ticker, action: 'SELL',
                    reason: sellSignals.join(', '),
                    confidence: Math.min(95, sellConfidence),
                    sentimentBoost,
                    indicators: makeIndicators(),
                };
            }
        }

        // ═══════ HOLD (Neutral) ═══════
        return {
            ticker, action: 'HOLD',
            reason: `Neutral: RSI ${Math.round(ind.rsi)}, ADX ${ind.adx.toFixed(0)}, Trend ${isUptrend ? 'Up' : 'Down'}`,
            confidence: 50,
            indicators: makeIndicators(),
        };

    } catch (e) {
        console.error(`[Engine] Error analyzing ${ticker}:`, e);
        return { ticker, action: 'HOLD', reason: 'Error', confidence: 0 };
    }
}

// ══════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATOR CALCULATIONS
// ══════════════════════════════════════════════════════════════════════

function calculateIndicators(
    closes: number[],
    volumes: number[],
    highs: number[],
    lows: number[]
): TechnicalIndicators {
    const current = closes[closes.length - 1];

    // EMA 10 & 50
    const ema10Array = calculateEMA(closes, 10);
    const ema50Array = calculateEMA(closes, 50);
    const ema10 = ema10Array[ema10Array.length - 1] || 0;
    const ema50 = ema50Array[ema50Array.length - 1] || 0;

    // RSI (14)
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

    // ATR (14)
    const atr = calculateATR(highs, lows, closes, 14);

    // ADX (14)
    const adx = calculateADX(highs, lows, closes, 14);

    // Stochastic RSI (14, 14, 3, 3)
    const stochRsi = calculateStochRSI(closes, 14, 14, 3);

    // OBV Trend (positive = accumulation, negative = distribution)
    const obvTrend = calculateOBVTrend(closes, volumes, 14);

    return { ema10, ema50, rsi, macd, volumeRatio, bollingerBands, priceChange, atr, adx, stochRsi, obvTrend };
}

// ── EMA ──
function calculateEMA(prices: number[], period: number): number[] {
    if (prices.length < period) return [];
    const multiplier = 2 / (period + 1);
    const ema: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += prices[i];
    ema.push(sum / period);
    for (let i = period; i < prices.length; i++) {
        ema.push((prices[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }
    return ema;
}

// ── RSI ──
function calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - (100 / (1 + rs));
}

// ── MACD ──
function calculateMACD(prices: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (prices.length < slowPeriod + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
    const fastEMA = calculateEMA(prices, fastPeriod);
    const slowEMA = calculateEMA(prices, slowPeriod);
    const macdLine: number[] = [];
    for (let i = 0; i < Math.min(fastEMA.length, slowEMA.length); i++) {
        macdLine.push(fastEMA[i] - slowEMA[i]);
    }
    if (macdLine.length < signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
    const signalLine = calculateEMA(macdLine, signalPeriod);
    const macd = macdLine[macdLine.length - 1];
    const signal = signalLine[signalLine.length - 1];
    return { macd, signal, histogram: macd - signal };
}

// ── Bollinger Bands ──
function calculateBollingerBands(prices: number[], period: number, stdDev: number) {
    if (prices.length < period) {
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        return { upper: avg, middle: avg, lower: avg };
    }
    const slice = prices.slice(-period);
    const middle = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, price) => sum + Math.pow(price - middle, 2), 0) / period;
    const standardDev = Math.sqrt(variance);
    return { upper: middle + standardDev * stdDev, middle, lower: middle - standardDev * stdDev };
}

// ── ATR (Average True Range) ──
function calculateATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    if (highs.length < period + 1) return 0;
    const trueRanges: number[] = [];
    for (let i = 1; i < highs.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        trueRanges.push(Math.max(hl, hc, lc));
    }
    // Use last `period` true ranges for ATR
    const recent = trueRanges.slice(-period);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ── ADX (Average Directional Index) ──
function calculateADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    if (highs.length < period * 2) return 25; // default neutral
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const tr: number[] = [];

    for (let i = 1; i < highs.length; i++) {
        const upMove = highs[i] - highs[i - 1];
        const downMove = lows[i - 1] - lows[i];
        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        tr.push(Math.max(hl, hc, lc));
    }

    if (tr.length < period) return 25;

    // Smoothed with EMA
    const smoothTR = calculateEMA(tr, period);
    const smoothPlusDM = calculateEMA(plusDM, period);
    const smoothMinusDM = calculateEMA(minusDM, period);

    if (smoothTR.length === 0) return 25;

    const dx: number[] = [];
    const len = Math.min(smoothTR.length, smoothPlusDM.length, smoothMinusDM.length);
    for (let i = 0; i < len; i++) {
        const atr = smoothTR[i];
        if (atr === 0) { dx.push(0); continue; }
        const pdi = (smoothPlusDM[i] / atr) * 100;
        const mdi = (smoothMinusDM[i] / atr) * 100;
        const sum = pdi + mdi;
        dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
    }

    if (dx.length < period) return dx[dx.length - 1] || 25;
    const adxLine = calculateEMA(dx, period);
    return adxLine[adxLine.length - 1] || 25;
}

// ── Stochastic RSI ──
function calculateStochRSI(prices: number[], rsiPeriod: number = 14, stochPeriod: number = 14, smoothK: number = 3): number {
    if (prices.length < rsiPeriod + stochPeriod + smoothK) return 50;

    // Calculate RSI for each point
    const rsiValues: number[] = [];
    for (let i = rsiPeriod + 1; i <= prices.length; i++) {
        const slice = prices.slice(0, i);
        rsiValues.push(calculateRSI(slice, rsiPeriod));
    }

    if (rsiValues.length < stochPeriod) return 50;

    // Stochastic of RSI
    const recentRSI = rsiValues.slice(-stochPeriod);
    const minRSI = Math.min(...recentRSI);
    const maxRSI = Math.max(...recentRSI);
    const range = maxRSI - minRSI;
    if (range === 0) return 50;

    const currentRSI = recentRSI[recentRSI.length - 1];
    const stochRSI = ((currentRSI - minRSI) / range) * 100;
    return Math.max(0, Math.min(100, stochRSI));
}

// ── OBV Trend ──
function calculateOBVTrend(closes: number[], volumes: number[], period: number = 14): number {
    if (closes.length < period + 1) return 0;

    // Calculate OBV
    const obv: number[] = [0];
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] > closes[i - 1]) obv.push(obv[obv.length - 1] + volumes[i]);
        else if (closes[i] < closes[i - 1]) obv.push(obv[obv.length - 1] - volumes[i]);
        else obv.push(obv[obv.length - 1]);
    }

    // Compare recent OBV EMA to older OBV EMA to determine trend
    const recentOBV = obv.slice(-period);
    const olderOBV = obv.slice(-(period * 2), -period);

    if (olderOBV.length === 0) return 0;

    const recentAvg = recentOBV.reduce((a, b) => a + b, 0) / recentOBV.length;
    const olderAvg = olderOBV.reduce((a, b) => a + b, 0) / olderOBV.length;

    // Normalize: positive = accumulation, negative = distribution
    return recentAvg > olderAvg ? 1 : recentAvg < olderAvg ? -1 : 0;
}

// ══════════════════════════════════════════════════════════════════════
// PORTFOLIO SYNC
// ══════════════════════════════════════════════════════════════════════

export async function syncPortfolioPrices() {
    console.log('[Engine] Starting Portfolio Price Sync');
    const holdings = await getHoldings();
    let totalEquity = 0;

    for (const holding of holdings) {
        try {
            const price = await MarketDataService.getCurrentPrice(holding.ticker);
            if (price) {
                totalEquity += price * holding.shares;
                await updateHoldingPrice(holding.ticker, price).catch(() => { });
                await updateHighWaterMark(holding.ticker, price).catch(() => { });
            } else {
                totalEquity += holding.market_value;
            }
        } catch (e) {
            console.error(`Failed to sync price for ${holding.ticker}`, e);
            totalEquity += holding.market_value;
        }
    }
    const status = await getPortfolioStatus();
    await updatePortfolioStatus(status.cash_balance, totalEquity);
}
