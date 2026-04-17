
import { getPool } from './db';
import { getPortfolioStatus, getHoldings, executeTrade, updatePortfolioStatus, saveAnalysisResult, saveCycleLog, getDailySnapshots, getIntradayBars, updateHoldingPrice, updateHighWaterMark, saveHistorySnapshot, savePortfolioSnapshot, cleanupOldSnapshots, getRecentStopLossSells, acquireEngineLock, releaseEngineLock } from './portfolio-db';
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
        ema10?: number;
        ema50?: number;
    };
}

export interface StrategyCandle {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface TechnicalIndicators {
    ema10: number;
    ema50: number;
    sma50: number;
    sma200: number;
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
// MARKET BENCHMARK (SPY) — 20-day return cache for relative-strength scoring
// ══════════════════════════════════════════════════════════════════════

let spyReturnCache: { value: number; fetchedAt: number } | null = null;
const SPY_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * 20-day percent return of SPY. Used as the market benchmark so we can score
 * each candidate on *relative* strength (outperformers deserve a boost,
 * laggards get marked down). Cached for 30 min — SPY's 20d return doesn't
 * meaningfully shift intraday, and this avoids refetching on every ticker.
 */
async function getSpyReturn20d(): Promise<number> {
    const now = Date.now();
    if (spyReturnCache && now - spyReturnCache.fetchedAt < SPY_CACHE_TTL_MS) {
        return spyReturnCache.value;
    }
    try {
        const candles = await MarketDataService.getDailyCandles('SPY', 30);
        if (candles.length < 21) return spyReturnCache?.value ?? 0;
        const latest = candles[candles.length - 1].close;
        const past = candles[candles.length - 21].close;
        if (!past || past <= 0) return spyReturnCache?.value ?? 0;
        const ret = ((latest - past) / past) * 100;
        spyReturnCache = { value: ret, fetchedAt: now };
        return ret;
    } catch {
        return spyReturnCache?.value ?? 0;
    }
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
    // Include the closing minute (16:00-16:01) so a CLOSE cron firing at
    // exactly 4:00 PM ET isn't treated as "market already closed".
    return time >= 9.5 && time <= 16;
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
    const engineLockName = 'trading-engine-cycle';
    const lockToken = await acquireEngineLock(engineLockName, 240);
    if (!lockToken) {
        const msg = `[Engine] Skipping ${type}: another trading cycle is already running.`;
        console.warn(msg);
        try { await saveCycleLog(type, msg); } catch { }
        return;
    }

    try {

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
        // Philosophy: give fresh positions room to breathe, widen a little once
        // the trade proves itself, and only tighten aggressively on big winners.
        // Target hold period is 3-14 days, so the trail must tolerate normal
        // intraday volatility (1-1.5 ATR) for a week+ without getting kicked.
        const atr = holding.atr > 0 ? holding.atr : (holding.avg_cost * 0.03);
        let trailMultiplier: number;
        if (returnPct > 10)      trailMultiplier = 1.5; // lock big gains tight
        else if (returnPct > 4)  trailMultiplier = 2.4; // let runners run
        else if (returnPct > 1)  trailMultiplier = 2.2; // breathing room in small profit
        else                     trailMultiplier = 2.0; // base
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
        // above entry before the trail can trigger. Raised from 1.5% → 2% (or 1
        // ATR, whichever is larger) to stop noise-killing unproven positions.
        const trailActivationMin = holding.avg_cost + Math.max(holding.avg_cost * 0.02, atr);
        const trailIsActive = hwm >= trailActivationMin;

        // Wait at least 1 full day (was 0.5) so intraday chop can't exit a
        // position before the swing thesis has a chance to develop.
        if (daysHeld >= 1 && trailIsActive && price < trailStopPrice) {
            const sellShares = holding.shares;
            // Embed signed return% in the note — the cooldown query uses this
            // to skip profitable trailing exits (which are just profit-taking).
            const returnTag = `return ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`;
            await executeTrade(holding.ticker, 'SELL', sellShares, price,
                `Trailing Stop: Price $${price.toFixed(2)} < Trail $${trailStopPrice.toFixed(2)} (HWM $${hwm.toFixed(2)}, ATR $${atr.toFixed(2)}, ${returnTag})`);
            summaryLines.push(`  SELL ${holding.ticker}: trailing stop (${returnPct.toFixed(1)}%)`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (sellShares * price), totalEquity - (sellShares * price));
            totalEquity -= sellShares * price;
            continue;
        }

        // ─── 2b. Gap Protection ───
        // If today's open gapped significantly from yesterday's close:
        // - Gap DOWN > 3% on a losing position → risk exit
        //   (now we allow a "soft" partial exit when the model is not bearish enough)
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
                    // Soft-exit logic: only full-exit if the model also agrees (bearish + confidence).
                    const signal = await getCachedSignal(holding.ticker);
                    const shouldFullExit = signal.action === 'SELL' && signal.confidence >= 60;

                    if (shouldFullExit) {
                        await executeTrade(holding.ticker, 'SELL', holding.shares, price,
                            `Gap-Down Exit: ${gapPct.toFixed(1)}% gap, position at ${returnPct.toFixed(1)}% (model SELL ${signal.confidence}%)`);
                        summaryLines.push(`  SELL ${holding.ticker}: gap-down ${gapPct.toFixed(1)}% exit (${returnPct.toFixed(1)}%)`);
                        const fresh = await getPortfolioStatus();
                        await updatePortfolioStatus(
                            fresh.cash_balance + (holding.shares * price),
                            totalEquity - (holding.shares * price)
                        );
                        totalEquity -= holding.shares * price;
                    } else if (partialSells === 0 && holding.shares > 1) {
                        const sellShares = Math.max(1, Math.floor(holding.shares * 0.33));
                        await executeTrade(holding.ticker, 'SELL', sellShares, price,
                            `Gap-Down Exit: ${gapPct.toFixed(1)}% gap, position at ${returnPct.toFixed(1)}% (soft model ${signal.action} ${signal.confidence}%)`);
                        summaryLines.push(`  PARTIAL SELL ${holding.ticker}: gap-down ${gapPct.toFixed(1)}% soft-exit (${returnPct.toFixed(1)}%)`);
                        const fresh = await getPortfolioStatus();
                        await updatePortfolioStatus(
                            fresh.cash_balance + (sellShares * price),
                            totalEquity - (sellShares * price)
                        );
                        totalEquity -= sellShares * price;
                    } else {
                        // If we've already partially exited this position, skip the additional gap-down trim
                        // and let trailing stop / later cycle logic handle it.
                        summaryLines.push(`  ${holding.ticker}: gap-down detected but model not bearish enough (skip exit)`);
                    }
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
        // Tiers widened to give winners runway (target hold: 3-14 days).
        // First partial at +4% locks a little; second at +9% books real
        // profit; full-exit moved to +15% so the trailing stop handles the
        // long right tail instead of a fixed cap clipping it early.
        //
        // Share distribution is ~25% / 33% of remaining / remaining = roughly
        // 25% / 25% / 50%, so half the position rides the trailing stop.

        // +4% → sell 25% (first partial lock)
        if (returnPct >= 4 && partialSells === 0 && holding.shares > 1) {
            const sellShares = Math.max(1, Math.floor(holding.shares * 0.25));
            await executeTrade(holding.ticker, 'SELL', sellShares, price,
                `Partial Profit +4% (1/4 position, ${returnPct.toFixed(1)}%)`);
            summaryLines.push(`  PARTIAL SELL ${holding.ticker}: +4% lock 25%`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (sellShares * price), totalEquity - (sellShares * price));
            totalEquity -= sellShares * price;
            continue;
        }

        // +9% → sell 33% of remaining (~25% of original)
        if (returnPct >= 9 && partialSells === 1 && holding.shares > 1) {
            const sellShares = Math.max(1, Math.floor(holding.shares * 0.33));
            await executeTrade(holding.ticker, 'SELL', sellShares, price,
                `Partial Profit +9% (1/3 remaining, ${returnPct.toFixed(1)}%)`);
            summaryLines.push(`  PARTIAL SELL ${holding.ticker}: +9% lock 33% remaining`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (sellShares * price), totalEquity - (sellShares * price));
            totalEquity -= sellShares * price;
            continue;
        }

        // +15% → full exit (trailing stop should usually fire before this)
        if (returnPct >= 15 && partialSells >= 2) {
            await executeTrade(holding.ticker, 'SELL', holding.shares, price,
                `Full Profit Exit +15% (${returnPct.toFixed(1)}%)`);
            summaryLines.push(`  SELL ${holding.ticker}: full exit at +15%`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (holding.shares * price), totalEquity - (holding.shares * price));
            totalEquity -= holding.shares * price;
            continue;
        }

        // ─── 2d. ADX Trend Death + Time Exit ───
        // Softened: require 4+ days held, actual loss (< -0.5%), and ADX < 12.
        // The old 2-day / ADX<15 window was exiting normal consolidations.
        if (daysHeld > 4 && returnPct < -0.5) {
            const signal = await getCachedSignal(holding.ticker);
            const adx = signal.indicators?.adx ?? 25;

            if (adx < 12 || (signal.action === 'SELL' && signal.confidence >= 60)) {
                await executeTrade(holding.ticker, 'SELL', holding.shares, price,
                    `Trend Exit: ADX ${adx.toFixed(0)}, ${daysHeld.toFixed(1)}d held, ${returnPct.toFixed(1)}%`);
                summaryLines.push(`  SELL ${holding.ticker}: trend died (ADX ${adx.toFixed(0)}, ${daysHeld.toFixed(1)}d)`);
                const fresh = await getPortfolioStatus();
                await updatePortfolioStatus(fresh.cash_balance + (holding.shares * price), totalEquity - (holding.shares * price));
                totalEquity -= holding.shares * price;
                continue;
            }
        }

        // ─── 2d-bis. Aging Exit (Time Decay) ───
        // Target hold is 3-14 days. If a name is still flat after 14 days or
        // simply hasn't worked out after 21, cycle the capital into something
        // that is actually moving. Dead money is the silent portfolio killer.
        if (daysHeld >= 21) {
            await executeTrade(holding.ticker, 'SELL', holding.shares, price,
                `Aging Exit: 21d held, ${returnPct.toFixed(1)}% return`);
            summaryLines.push(`  SELL ${holding.ticker}: aging exit 21d (${returnPct.toFixed(1)}%)`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (holding.shares * price), totalEquity - (holding.shares * price));
            totalEquity -= holding.shares * price;
            continue;
        }
        if (daysHeld >= 14 && Math.abs(returnPct) < 2) {
            await executeTrade(holding.ticker, 'SELL', holding.shares, price,
                `Aging Exit: 14d flat, ${returnPct.toFixed(1)}% return`);
            summaryLines.push(`  SELL ${holding.ticker}: aging exit 14d flat (${returnPct.toFixed(1)}%)`);
            const fresh = await getPortfolioStatus();
            await updatePortfolioStatus(fresh.cash_balance + (holding.shares * price), totalEquity - (holding.shares * price));
            totalEquity -= holding.shares * price;
            continue;
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
    // Target portfolio size = 10 positions (sweet spot for ~$100k swing book).
    // Research: 12-20 stocks cuts ~80% of idiosyncratic risk, but with active
    // management at ~$100k the diversification ROI flattens above 10-12.
    // Hard ceiling at 15 for exceptional-only over-target adds.
    const TARGET_POSITIONS = 10;
    const MAX_POSITIONS = 15;

    // Cash-ratio pressure: if we're sitting on dead cash in a live strategy,
    // relax the confidence gate a bit so we actually get invested.
    const cashRatio = freshStatus.total_value > 0
        ? freshStatus.cash_balance / freshStatus.total_value
        : 1;
    let cashPressureRelief = 0;
    if (cashRatio > 0.85)      cashPressureRelief = 8;
    else if (cashRatio > 0.70) cashPressureRelief = 5;
    else if (cashRatio > 0.55) cashPressureRelief = 2;

    const isFirstCycleToday = updatedHoldings.length <= 1;
    // Push harder on underinvested days — more shots when we have the cash.
    let MAX_BUYS_PER_CYCLE = isFirstCycleToday ? 4 : 2;
    if (cashRatio > 0.70) MAX_BUYS_PER_CYCLE = isFirstCycleToday ? 5 : 3;

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
        recentlyStoppedOut = await getRecentStopLossSells(3); // 3-day cooldown (loss exits only)
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

        // Skip if recently stopped out at a loss (cooldown covers real risk exits).
        if (recentlyStoppedOut.has(candidate.ticker)) {
            if (top5.some(c => c.ticker === candidate.ticker)) {
                summaryLines.push(`  ${candidate.ticker} ${candidate.confidence}% - cooldown (recent loss exit, skip)`);
            }
            continue;
        }

        // Dynamic confidence gate — biased to TARGET_POSITIONS=10.
        //   0-2   : 58   aggressive build when empty, a little risk sprinkled in
        //   3-5   : 62   filling toward target
        //   6-8   : 65   approaching ideal
        //   9     : 68   one away from target
        //   10    : 72   at target — incremental adds need real edge
        //   11-12 : 80   over target — strong signal required
        //   13-14 : 88   exceptional only
        const currentCount = updatedHoldings.length + buyCount;
        let requiredConfidence: number;
        if (currentCount <= 2)       requiredConfidence = 58;
        else if (currentCount <= 5)  requiredConfidence = 62;
        else if (currentCount <= 8)  requiredConfidence = 65;
        else if (currentCount === 9) requiredConfidence = 68;
        else if (currentCount === 10) requiredConfidence = 72;
        else if (currentCount <= 12) requiredConfidence = 80;
        else                         requiredConfidence = 88;

        // Sentiment-quality weighting so strong news/analyst context adds lift.
        const sentimentGateWeight = 0.35;
        const effectiveConfidence = candidate.confidence + (candidate.sentimentBoost ?? 0) * sentimentGateWeight;
        // Riskier delta + cash-pressure relief. Hard floor of 50 so we never
        // rubber-stamp a signal — there's always some edge required.
        const riskierDelta = 2;
        const gateConfidence = Math.max(50, requiredConfidence - riskierDelta - cashPressureRelief);

        if (effectiveConfidence < gateConfidence) {
            if (top5.some(c => c.ticker === candidate.ticker)) {
                summaryLines.push(
                    `  ${candidate.ticker} ${candidate.confidence}% (eff ${effectiveConfidence.toFixed(1)}%) - below gate ${gateConfidence}% [target ${TARGET_POSITIONS}, cash ${(cashRatio * 100).toFixed(0)}%] (skip)`
                );
            }
            continue;
        }

        try {
            const currentPrice = await MarketDataService.getCurrentPrice(candidate.ticker);
            if (currentPrice && currentPrice > 0) {
                const positionSize = calculatePositionSize(
                    candidate.confidence,
                    candidate.indicators?.atr || 0,
                    currentPrice,
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

                // Don't spend more than available - cashFloor
                const maxSpend = freshStatus.cash_balance - cashFloor;
                const actualSize = Math.min(positionSize, maxSpend);
                if (actualSize < 500) continue;

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
    } finally {
        await releaseEngineLock(engineLockName, lockToken).catch(() => { });
    }
}

// ══════════════════════════════════════════════════════════════════════
// DYNAMIC POSITION SIZING
// ══════════════════════════════════════════════════════════════════════

/**
 * Daily swing sizing uses both conviction and stop distance.
 *
 * 1. Start with a confidence-weighted target allocation.
 * 2. Cap by ATR-based risk so volatile names get smaller allocations.
 * 3. Cap by concentration and available cash.
 * 4. Scale toward a target of ~10 positions: slight boost below target,
 *    moderate shrink above target, hard shrink for exceptional over-adds.
 */
export function calculatePositionSize(
    confidence: number,
    atr: number,
    entryPrice: number,
    totalValue: number,
    cashAvailable: number,
    currentPositions: number
): number {
    const confidenceRatio = Math.max(0, Math.min(100, confidence)) / 100;
    // Convex conviction curve: 3% at 0 confidence → 10% at 100 confidence.
    const convictionPct = 0.03 + Math.pow(confidenceRatio, 2.2) * 0.07;
    let size = totalValue * convictionPct;

    // Risk-based cap: never risk more than 0.75% of the book on one stop.
    const stopDistancePct = atr > 0 && entryPrice > 0
        ? Math.max((atr * 2) / entryPrice, 0.03)
        : 0.05;
    const maxRiskBudget = totalValue * 0.0075;
    const riskSizedCap = maxRiskBudget / stopDistancePct;

    size = Math.min(size, riskSizedCap);
    size = Math.min(size, totalValue * 0.10);      // concentration cap
    size = Math.min(size, cashAvailable * 0.35);   // never sink >35% of dry powder

    // Position-count bias toward a target book of 10.
    // - 0-5  : +5% lift so the book actually fills in reasonable time
    // - 6-10 : unchanged (natural build-out zone)
    // - 11-12: -15% (over-target incremental add)
    // - 13+  : -30% (exceptional-only; prevents late over-concentration)
    if (currentPositions <= 5)       size *= 1.05;
    else if (currentPositions >= 13) size *= 0.70;
    else if (currentPositions >= 11) size *= 0.85;

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

        // Floor matches analyzeTickerFromCandles — the engine's dynamic gate
        // in runTradingCycle() is responsible for the final buy threshold.
        if (analysis.action === 'BUY' && analysis.confidence >= BUY_SIGNAL_FLOOR) {
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

function getNyDateKey(date: Date): string {
    return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function trimIncompleteDailyCandle(quotes: StrategyCandle[], now = new Date()): StrategyCandle[] {
    if (quotes.length < 2) return quotes;
    const last = quotes[quotes.length - 1];
    const lastDate = getNyDateKey(new Date(last.date));
    const todayDate = getNyDateKey(now);

    if (lastDate !== todayDate) return quotes;

    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const isWeekday = et.getDay() >= 1 && et.getDay() <= 5;
    const sessionMinutes = et.getHours() * 60 + et.getMinutes();
    const isSessionFinal = !isWeekday || sessionMinutes >= (16 * 60 + 10);

    return isSessionFinal ? quotes : quotes.slice(0, -1);
}

/**
 * Minimum total buy confidence to emit a BUY signal.
 * Lowered from 65 → 58 so the dynamic gate in runTradingCycle() can actually
 * relax the threshold for an underinvested portfolio. The engine still gates
 * the buy at ≥65 for a full portfolio; 58 is the true floor of tradeable edge.
 */
const BUY_SIGNAL_FLOOR = 58;

export function analyzeTickerFromCandles(
    ticker: string,
    rawQuotes: StrategyCandle[],
    context?: {
        rvol?: number;
        vwap?: number;
        sentimentScore?: number;
        sentimentConfidence?: number;
        spyReturn20d?: number;
    }
): TradeSignal {
    const quotes = trimIncompleteDailyCandle(rawQuotes);
    if (quotes.length < 200) {
        return { ticker, action: 'HOLD', reason: 'Not enough data', confidence: 0 };
    }

    const current = quotes[quotes.length - 1];
    const closes = quotes.map((q) => q.close || 0);
    const volumes = quotes.map((q) => q.volume || 0);
    const highs = quotes.map((q) => q.high || q.close || 0);
    const lows = quotes.map((q) => q.low || q.close || 0);

    const ind = calculateIndicators(closes, volumes, highs, lows);
    const rvol = context?.rvol ?? ind.volumeRatio;
    const vwap = context?.vwap ?? 0;
    const priceAboveVwap = vwap > 0 && current.close > vwap;
    const sentimentScore = context?.sentimentScore ?? 0;
    const sentimentConfidence = context?.sentimentConfidence ?? 0;
    const sentimentBoost = sentimentScore * 10 * sentimentConfidence;

    // Relative strength vs SPY (20-day). Market-relative outperformance is one
    // of the single most predictive signals in quant research, so score it
    // explicitly instead of relying on absolute momentum alone.
    const price20DaysAgo = closes[closes.length - 21] || closes[0];
    const stockReturn20d = price20DaysAgo > 0
        ? ((current.close - price20DaysAgo) / price20DaysAgo) * 100
        : 0;
    const spyReturn20d = context?.spyReturn20d ?? 0;
    const relativeStrength = stockReturn20d - spyReturn20d;

    // 10-day rate of change — shorter-horizon momentum complement to the 20d.
    const price10DaysAgo = closes[closes.length - 11] || price20DaysAgo;
    const roc10 = price10DaysAgo > 0
        ? ((current.close - price10DaysAgo) / price10DaysAgo) * 100
        : 0;

    const makeIndicators = () => ({
        rsi: ind.rsi,
        macdHistogram: ind.macd.histogram,
        volumeRatio: ind.volumeRatio,
        priceChangePct: ind.priceChange,
        sma50: ind.sma50,
        sma200: ind.sma200,
        rvol,
        vwap: vwap || undefined,
        atr: ind.atr,
        adx: ind.adx,
        stochRsi: ind.stochRsi,
        obv: ind.obvTrend,
        ema10: ind.ema10,
        ema50: ind.ema50,
    });

    const structuralTrendUp = ind.sma50 >= ind.sma200;
    const tacticalTrendUp = ind.ema10 > ind.ema50;
    const isUptrend = structuralTrendUp && tacticalTrendUp;
    const priceAboveTrend = current.close > ind.ema50 && current.close > ind.sma50 * 0.98;

    const buySignals: string[] = [];
    let buyConfidence = 0;

    if (isUptrend && priceAboveTrend) {
        // ─── ADX: graduated trend-strength scoring (NO hard gate) ───
        // ADX measures trend strength, not direction. A steady grinder can be
        // in a legitimate uptrend with ADX 15-22 and deserves partial credit.
        if (ind.adx >= 30) {
            buyConfidence += 18;
            buySignals.push(`ADX ${ind.adx.toFixed(0)} (strong trend)`);
        } else if (ind.adx >= 22) {
            buyConfidence += 13;
            buySignals.push(`ADX ${ind.adx.toFixed(0)} (trend confirmed)`);
        } else if (ind.adx >= 17) {
            buyConfidence += 7;
            buySignals.push(`ADX ${ind.adx.toFixed(0)} (developing trend)`);
        } else if (ind.adx >= 12) {
            buyConfidence += 2;
        }

        // ─── RSI: wider bands so healthy-trend entries actually score points ───
        if (ind.rsi < 25) {
            buyConfidence += 8;
            buySignals.push(`RSI ${Math.round(ind.rsi)} (extreme oversold, caution)`);
        } else if (ind.rsi < 40) {
            buyConfidence += 22;
            buySignals.push(`RSI ${Math.round(ind.rsi)} (oversold dip buy)`);
        } else if (ind.rsi < 50) {
            buyConfidence += 18;
            buySignals.push(`RSI ${Math.round(ind.rsi)} (pullback buy)`);
        } else if (ind.rsi < 60) {
            buyConfidence += 12;
            buySignals.push(`RSI ${Math.round(ind.rsi)} (healthy trend)`);
        } else if (ind.rsi < 68) {
            buyConfidence += 6;
            buySignals.push(`RSI ${Math.round(ind.rsi)} (strong momentum)`);
        } else if (ind.rsi < 75) {
            // neutral — no reward, no penalty
        } else {
            buyConfidence -= 8;
            buySignals.push(`RSI ${Math.round(ind.rsi)} (overbought)`);
        }

        // ─── StochRSI: graduated (NO hard gate) ───
        if (ind.stochRsi <= 5) {
            buyConfidence += 3;
            buySignals.push(`StochRSI ${ind.stochRsi.toFixed(0)} (deep oversold)`);
        } else if (ind.stochRsi < 30) {
            buyConfidence += 12;
            buySignals.push(`StochRSI ${ind.stochRsi.toFixed(0)} (oversold bounce)`);
        } else if (ind.stochRsi < 50) {
            buyConfidence += 6;
        } else if (ind.stochRsi < 80) {
            // neutral
        } else {
            buyConfidence -= 4;
            buySignals.push(`StochRSI ${ind.stochRsi.toFixed(0)} (overbought)`);
        }

        // ─── MACD ───
        if (ind.macd.histogram > 0 && ind.macd.macd > ind.macd.signal) {
            buyConfidence += 15;
            buySignals.push('MACD bullish');
        } else if (ind.macd.histogram > 0) {
            buyConfidence += 6;
            buySignals.push('MACD turning up');
        } else if (ind.macd.histogram < 0 && ind.macd.macd < ind.macd.signal) {
            buyConfidence -= 10;
            buySignals.push('MACD bearish');
        }

        // ─── Volume (20-day ratio, full session) ───
        if (ind.volumeRatio > 1.5) {
            buyConfidence += 14;
            buySignals.push(`Volume +${Math.round((ind.volumeRatio - 1) * 100)}% (strong)`);
        } else if (ind.volumeRatio > 1.2) {
            buyConfidence += 8;
            buySignals.push(`Volume +${Math.round((ind.volumeRatio - 1) * 100)}%`);
        } else if (ind.volumeRatio > 1.0) {
            buyConfidence += 3;
        }

        // ─── RVOL (intraday relative volume) ───
        if (rvol > 1.5) {
            buyConfidence += 7;
            buySignals.push(`RVOL ${rvol.toFixed(1)}x`);
        } else if (rvol > 1.2) {
            buyConfidence += 4;
        }

        // ─── VWAP ───
        if (priceAboveVwap) {
            buyConfidence += 5;
            buySignals.push('Price > VWAP');
        }

        // ─── OBV (accumulation / distribution) ───
        if (ind.obvTrend > 0) {
            buyConfidence += 6;
            buySignals.push('OBV accumulation');
        } else if (ind.obvTrend < 0) {
            buyConfidence -= 3;
        }

        // ─── Bollinger Band position ───
        const bbRange = ind.bollingerBands.upper - ind.bollingerBands.lower;
        if (bbRange > 0) {
            const bbPosition = (current.close - ind.bollingerBands.lower) / bbRange;
            if (bbPosition < 0.25) {
                buyConfidence += 10;
                buySignals.push('Near BB lower band (mean-reversion)');
            } else if (bbPosition < 0.5) {
                buyConfidence += 4;
            } else if (bbPosition > 0.95) {
                buyConfidence -= 4;
                buySignals.push('Upper BB (stretched)');
            }
        }

        // ─── Relative Strength vs SPY (20-day) ───
        // Outperforming the index is a durable edge — trending leaders tend to
        // keep leading for days-to-weeks, which matches the target hold period.
        if (relativeStrength > 5) {
            buyConfidence += 10;
            buySignals.push(`RS +${relativeStrength.toFixed(1)}% vs SPY (leader)`);
        } else if (relativeStrength > 2) {
            buyConfidence += 6;
            buySignals.push(`RS +${relativeStrength.toFixed(1)}% vs SPY`);
        } else if (relativeStrength > -2) {
            buyConfidence += 2;
        } else if (relativeStrength < -5) {
            buyConfidence -= 5;
            buySignals.push(`RS ${relativeStrength.toFixed(1)}% vs SPY (laggard)`);
        }

        // ─── 10-day Rate of Change (short-horizon momentum) ───
        if (roc10 > 3 && roc10 < 12) {
            buyConfidence += 8;
            buySignals.push(`ROC10 +${roc10.toFixed(1)}%`);
        } else if (roc10 >= 12) {
            buyConfidence -= 4;
            buySignals.push(`ROC10 +${roc10.toFixed(1)}% (extended)`);
        } else if (roc10 > 0) {
            buyConfidence += 3;
        } else if (roc10 < -5) {
            buyConfidence -= 5;
            buySignals.push(`ROC10 ${roc10.toFixed(1)}% (declining)`);
        }

        // ─── 20-day price change (momentum band) ───
        if (ind.priceChange > 5 && ind.priceChange < 15) {
            buyConfidence += 6;
            buySignals.push(`+${ind.priceChange.toFixed(1)}% momentum`);
        } else if (ind.priceChange >= 15 && ind.priceChange < 25) {
            buyConfidence += 2;
        } else if (ind.priceChange >= 25) {
            buyConfidence -= 6;
            buySignals.push(`+${ind.priceChange.toFixed(1)}% (too extended)`);
        } else if (ind.priceChange > 2) {
            buyConfidence += 3;
        } else if (ind.priceChange < -5) {
            buyConfidence -= 6;
        }

        // ─── Sentiment ───
        if (sentimentScore > 0.2 && sentimentConfidence > 0.5) {
            const boost = Math.min(10, sentimentScore * 15);
            buyConfidence += boost;
            buySignals.push(`Positive sentiment (+${boost.toFixed(0)})`);
        } else if (sentimentScore < -0.3 && sentimentConfidence > 0.5) {
            buyConfidence -= 5;
            buySignals.push('Negative sentiment');
        }

        if (buyConfidence >= BUY_SIGNAL_FLOOR) {
            return {
                ticker,
                action: 'BUY',
                reason: buySignals.join(', '),
                confidence: Math.min(95, buyConfidence),
                sentimentBoost,
                indicators: makeIndicators(),
            };
        }
    }

    const sellSignals: string[] = [];
    let sellConfidence = 0;
    const isDowntrend = ind.ema10 < ind.ema50 || ind.sma50 < ind.sma200 || current.close < ind.sma50;
    const isStrongDowntrend = ind.ema10 < ind.ema50 * 0.95 && current.close < ind.ema10;

    if (isDowntrend || isStrongDowntrend) {
        if (ind.rsi > 65) {
            sellConfidence += 25;
            sellSignals.push(`RSI ${Math.round(ind.rsi)} (overbought in downtrend)`);
        }

        if (ind.macd.histogram < 0 && ind.macd.macd < ind.macd.signal) {
            sellConfidence += 20;
            sellSignals.push('MACD bearish');
        }

        if (ind.adx > 25 && isStrongDowntrend) {
            sellConfidence += 15;
            sellSignals.push(`ADX ${ind.adx.toFixed(0)} (strong downtrend)`);
        }

        if (ind.stochRsi > 80) {
            sellConfidence += 10;
            sellSignals.push(`StochRSI ${ind.stochRsi.toFixed(0)} (overbought)`);
        }

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

        if (sentimentScore < -0.2 && sentimentConfidence > 0.5) {
            sellConfidence += 12;
            sellSignals.push('Negative sentiment');
        }

        if (ind.volumeRatio > 1.5 && current.close < (closes[closes.length - 2] || current.close)) {
            sellConfidence += 10;
            sellSignals.push('High volume decline');
        }

        if (ind.obvTrend < 0) {
            sellConfidence += 8;
            sellSignals.push('OBV distribution');
        }

        if (!priceAboveVwap && vwap > 0) {
            sellConfidence += 6;
            sellSignals.push('Price < VWAP');
        }

        if (rvol > 1.5 && current.close < (closes[closes.length - 2] || current.close)) {
            sellConfidence += 6;
            sellSignals.push('RVOL spike on decline');
        }

        // Relative-strength laggards deserve extra sell pressure in a downtrend.
        if (relativeStrength < -5) {
            sellConfidence += 6;
            sellSignals.push(`RS ${relativeStrength.toFixed(1)}% vs SPY (laggard)`);
        }

        if (sellConfidence >= 60) {
            return {
                ticker,
                action: 'SELL',
                reason: sellSignals.join(', '),
                confidence: Math.min(95, sellConfidence),
                sentimentBoost,
                indicators: makeIndicators(),
            };
        }
    }

    return {
        ticker,
        action: 'HOLD',
        reason: `Neutral: RSI ${Math.round(ind.rsi)}, ADX ${ind.adx.toFixed(0)}, Trend ${isUptrend ? 'Up' : 'Down'}, RS ${relativeStrength.toFixed(1)}%`,
        confidence: 50,
        sentimentBoost,
        indicators: makeIndicators(),
    };
}

/**
 * Analyze a single ticker with enhanced indicator suite.
 * Uses: EMA10/50, RSI, MACD, Bollinger Bands, ATR, ADX, StochRSI, OBV,
 *       RVOL, VWAP, Sentiment, Macro (FRED VIX), Fundamentals (FMP).
 */
export async function analyzeTicker(ticker: string): Promise<TradeSignal> {
    try {
        const quotes = await MarketDataService.getDailyCandles(ticker, 260);
        if (quotes.length < 200) return { ticker, action: 'HOLD', reason: 'Not enough data', confidence: 0 };
        const [hist, sentiment, spyReturn20d] = await Promise.all([
            getHistoricalContext(ticker),
            getSentimentScore(ticker),
            getSpyReturn20d(),
        ]);
        const vwap = hist?.vwap ?? 0;
        const baseSignal = analyzeTickerFromCandles(ticker, quotes, {
            rvol: hist?.rvol,
            vwap,
            sentimentScore: sentiment.score,
            sentimentConfidence: sentiment.confidence,
            spyReturn20d,
        });

        if (baseSignal.action !== 'BUY') {
            return baseSignal;
        }

        const macro = await MarketDataService.getMacroTrend();
        if (!macro.safeToTrade) {
            return {
                ticker,
                action: 'HOLD',
                reason: `Macro Block: ${macro.reason} (Setup was ${baseSignal.confidence}%)`,
                confidence: 0,
                indicators: baseSignal.indicators,
            };
        }

        const fins = await MarketDataService.getDeepFinancials(ticker);
        if (fins?.financials?.income_statement) {
            const netIncome = fins.financials.income_statement.net_income_loss?.value;
            if (netIncome !== null && netIncome !== undefined && netIncome < 0) {
                return {
                    ...baseSignal,
                    action: 'HOLD',
                    confidence: Math.max(0, baseSignal.confidence - 12),
                    reason: `${baseSignal.reason}, Negative GAAP Income`,
                };
            }
            if (netIncome !== null && netIncome !== undefined && netIncome > 0) {
                return {
                    ...baseSignal,
                    confidence: Math.min(95, baseSignal.confidence + 4),
                    reason: `${baseSignal.reason}, Positive GAAP Income`,
                };
            }
        }

        return baseSignal;

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
    const sma50 = calculateSMA(closes, 50);
    const sma200 = calculateSMA(closes, 200);

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

    return { ema10, ema50, sma50, sma200, rsi, macd, volumeRatio, bollingerBands, priceChange, atr, adx, stochRsi, obvTrend };
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

function calculateSMA(prices: number[], period: number): number {
    if (prices.length < period) return 0;
    const slice = prices.slice(-period);
    return slice.reduce((sum, price) => sum + price, 0) / period;
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
