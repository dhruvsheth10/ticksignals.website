/**
 * Snapshot service: fetch OHLCV from Yahoo, compute VWAP/RVOL, save to Turso.
 * - Twice daily (9:35 ET, 2:00 ET): holdings + buy candidates, keep 5 days
 * - 10-min: holdings only, keep until EOD (even if sold that day)
 */
// import yahooFinance from 'yahoo-finance2'; // Removed, using MarketDataService
import {
    getHoldings,
    saveDailySnapshot,
    saveIntradayBar,
    initPortfolioTables,
} from './portfolio-db';
import { getPool } from './db';

type SnapshotInterval = 'OPEN' | 'MID';

function computeVWAP(quotes: { open?: number; high?: number; low?: number; close?: number; volume?: number }[]): number {
    let sumPV = 0, sumV = 0;
    for (const q of quotes) {
        const c = q.close ?? q.open ?? 0;
        const h = q.high ?? c;
        const l = q.low ?? c;
        const typical = (h + l + c) / 3;
        const vol = q.volume ?? 0;
        if (vol > 0) {
            sumPV += typical * vol;
            sumV += vol;
        }
    }
    return sumV > 0 ? sumPV / sumV : 0;
}

function roundTo10Min(iso: string): string {
    const d = new Date(iso);
    const min = d.getMinutes();
    const rounded = Math.floor(min / 10) * 10;
    d.setMinutes(rounded, 0, 0);
    return d.toISOString().slice(0, 19);
}

/**
 * Fetch intraday OHLCV + 30-day avg volume for RVOL
 */
import { MarketDataService } from './market-data';

/**
 * Fetch intraday OHLCV + 30-day avg volume for RVOL
 * Uses MarketDataService (Finnhub primary) to avoid Yahoo rate limits.
 * Note: VWAP is approximated from daily typical price to save API calls.
 */
async function fetchIntradayAndRVOL(ticker: string): Promise<{
    o: number; h: number; l: number; c: number; v: number;
    vwap: number; rvol: number;
} | null> {
    try {
        const data = await MarketDataService.getIntradayAndRVOL(ticker);
        return data;
    } catch (e) {
        console.warn(`[Snapshot] Fetch failed for ${ticker}:`, (e as Error).message);
        return null; // Fail gracefully so we can count failures
    }
}

/**
 * Twice-daily snapshot: 9:35 ET (OPEN) or 2:00 ET (MID).
 * Saves for: holdings + buy candidates (top 75 from screener).
 */
export async function runTwiceDailySnapshot(intervalType: SnapshotInterval): Promise<{ ok: number; fail: number }> {
    await initPortfolioTables();

    const holdings = await getHoldings();
    const tickersFromHoldings = holdings.map(h => h.ticker);

    // Buy candidates from screener (fundamental filter)
    let tickersFromScreener: string[] = [];
    try {
        const db = getPool();
        const r = await db.query(`
            SELECT ticker FROM screener_cache
            WHERE roe_pct > 12 AND gross_margin_pct > 8 AND debt_to_equity < 1.0 AND market_cap > 1000000000
            ORDER BY pe_ratio ASC, roe_pct DESC LIMIT 75
        `);
        tickersFromScreener = (r.rows || []).map((row: any) => row.ticker);
    } catch (e) {
        console.warn('[Snapshot] Screener query failed, using holdings only');
    }

    const allTickers = [...new Set([...tickersFromHoldings, ...tickersFromScreener])];
    const now = new Date().toISOString();
    let ok = 0, fail = 0;

    for (const ticker of allTickers) {
        const data = await fetchIntradayAndRVOL(ticker);
        if (!data) { fail++; continue; }
        try {
            await saveDailySnapshot({
                ticker,
                snapshot_at: now,
                interval_type: intervalType,
                open: data.o,
                high: data.h,
                low: data.l,
                close: data.c,
                volume: data.v,
                vwap: data.vwap,
                rvol: data.rvol,
            });
            ok++;
        } catch (e) {
            fail++;
        }
    }

    return { ok, fail };
}

/**
 * 10-min holdings ping. Runs every ~10 mins during market hours.
 * Only for current holdings.
 */
export async function runHoldings10MinPing(): Promise<{ ok: number; fail: number }> {
    await initPortfolioTables();

    const holdings = await getHoldings();
    if (holdings.length === 0) return { ok: 0, fail: 0 };

    const barTime = roundTo10Min(new Date().toISOString());
    let ok = 0, fail = 0;

    for (const h of holdings) {
        const data = await fetchIntradayAndRVOL(h.ticker);
        if (!data) { fail++; continue; }
        try {
            await saveIntradayBar({
                ticker: h.ticker,
                bar_time: barTime,
                open: data.o,
                high: data.h,
                low: data.l,
                close: data.c,
                volume: data.v,
                vwap: data.vwap,
            });
            ok++;
        } catch (e) {
            fail++;
        }
    }

    return { ok, fail };
}
