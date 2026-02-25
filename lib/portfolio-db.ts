/**
 * Portfolio + Trading data on Turso (LibSQL).
 * Neon holds only screener_cache; everything else lives here.
 */
import { getTurso } from './turso';

// ── Interfaces ──
export interface PortfolioStatus {
    id?: number;
    cash_balance: number;
    total_equity: number;
    total_value: number;
    last_updated: string;
}

export interface PortfolioHolding {
    ticker: string;
    shares: number;
    avg_cost: number;
    current_price: number;
    market_value: number;
    return_pct: number;
    last_updated: string;
    opened_at: string;
    high_water_mark: number;
    partial_sells: number;
    atr: number;
}

export interface PortfolioTransaction {
    id?: number;
    date: string;
    ticker: string;
    type: 'BUY' | 'SELL';
    shares: number;
    price: number;
    total_amount: number;
    notes?: string;
}

export interface PortfolioHistory {
    date: string;
    total_value: number;
    cash_balance: number;
    equity_value: number;
    day_change_pct: number;
}

export interface PortfolioSnapshot {
    timestamp: string;
    total_value: number;
    cash_balance: number;
    equity_value: number;
}

export interface DailySnapshot {
    ticker: string;
    snapshot_at: string; // ISO
    interval_type: 'OPEN' | 'MID'; // 9:35 ET / 2:00 ET
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    vwap: number;
    rvol: number; // volume / 30-day avg
}

export interface IntradayHolding {
    ticker: string;
    bar_time: string; // 10-min bar start (ISO)
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    vwap: number;
}

// ── Init Tables ──
export async function initPortfolioTables(): Promise<void> {
    const db = getTurso();

    await db.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cash_balance REAL NOT NULL DEFAULT 100000.0,
        total_equity REAL NOT NULL DEFAULT 0.0,
        total_value REAL NOT NULL DEFAULT 100000.0,
        last_updated TEXT DEFAULT (datetime('now'))
      )
    `);

    const statusCheck = await db.execute({ sql: 'SELECT count(*) as c FROM portfolio_status', args: [] });
    const count = (statusCheck.rows[0] as any)?.c ?? 0;
    if (count === 0) {
        await db.execute({
            sql: `INSERT INTO portfolio_status (cash_balance, total_equity, total_value) VALUES (100000.0, 0.0, 100000.0)`,
            args: [],
        });
        console.log('Initialized portfolio_status with $100k start.');
    }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_holdings (
        ticker TEXT PRIMARY KEY,
        shares REAL NOT NULL,
        avg_cost REAL NOT NULL,
        current_price REAL,
        market_value REAL,
        return_pct REAL,
        last_updated TEXT DEFAULT (datetime('now')),
        opened_at TEXT DEFAULT (datetime('now')),
        high_water_mark REAL DEFAULT 0,
        partial_sells INTEGER DEFAULT 0,
        atr REAL DEFAULT 0
      )
    `);

    // Migration: add new columns to existing tables (safe — ignores if they already exist)
    for (const col of [
        { name: 'high_water_mark', type: 'REAL DEFAULT 0' },
        { name: 'partial_sells', type: 'INTEGER DEFAULT 0' },
        { name: 'atr', type: 'REAL DEFAULT 0' },
    ]) {
        try {
            await db.execute(`ALTER TABLE portfolio_holdings ADD COLUMN ${col.name} ${col.type}`);
        } catch { /* column already exists */ }
    }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT DEFAULT (datetime('now')),
        ticker TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('BUY', 'SELL')),
        shares REAL NOT NULL,
        price REAL NOT NULL,
        total_amount REAL NOT NULL,
        notes TEXT
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_history (
        date TEXT PRIMARY KEY,
        total_value REAL NOT NULL,
        cash_balance REAL NOT NULL,
        equity_value REAL NOT NULL,
        day_change_pct REAL
      )
    `);

    // Trading analysis (for cloud status + admin logs)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS trading_analysis_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'HOLD')),
        confidence INTEGER NOT NULL,
        reason TEXT,
        sentiment_score REAL,
        sentiment_confidence REAL,
        rsi REAL,
        macd_histogram REAL,
        volume_ratio REAL,
        price_change_pct REAL,
        sma50 REAL,
        sma200 REAL,
        analyzed_at TEXT DEFAULT (datetime('now'))
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS trading_cycle_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_type TEXT NOT NULL,
        ran_at TEXT DEFAULT (datetime('now')),
        summary TEXT NOT NULL
      )
    `);

    // Twice-daily snapshots (9:35 ET + 2:00 ET). Keep last 5 days per ticker.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS daily_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        snapshot_at TEXT NOT NULL,
        interval_type TEXT NOT NULL CHECK (interval_type IN ('OPEN', 'MID')),
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume REAL,
        vwap REAL,
        rvol REAL
      )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_daily_snapshots_ticker_at ON daily_snapshots(ticker, snapshot_at)`);

    // 10-min bars for holdings only. Cleaned at EOD for tickers sold today.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS intraday_holdings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        bar_time TEXT NOT NULL,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume REAL,
        vwap REAL
      )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_intraday_ticker_time ON intraday_holdings(ticker, bar_time)`);

    // Tickers sold today – used for EOD cleanup (delete intraday after 4 PM ET)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS sold_today (
        ticker TEXT NOT NULL,
        sold_at TEXT NOT NULL,
        PRIMARY KEY (ticker)
      )
    `);

    // High-frequency portfolio value snapshots (recorded every trading cycle)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        total_value REAL NOT NULL,
        cash_balance REAL NOT NULL,
        equity_value REAL NOT NULL
      )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_ts ON portfolio_snapshots(timestamp)`);

    console.log('Portfolio + trading tables (Turso) initialized.');
}

// ── Portfolio CRUD ──
export async function getPortfolioStatus(): Promise<PortfolioStatus> {
    const db = getTurso();
    const r = await db.execute({ sql: 'SELECT * FROM portfolio_status ORDER BY id DESC LIMIT 1', args: [] });
    const row = r.rows[0] as any;
    if (!row) return { cash_balance: 100000, total_equity: 0, total_value: 100000, last_updated: '' };
    return {
        id: row.id,
        cash_balance: row.cash_balance,
        total_equity: row.total_equity,
        total_value: row.total_value,
        last_updated: row.last_updated || '',
    };
}

export async function updatePortfolioStatus(cash: number, equity: number): Promise<void> {
    const db = getTurso();
    const total = cash + equity;
    await db.execute({
        sql: `UPDATE portfolio_status SET cash_balance = ?, total_equity = ?, total_value = ?, last_updated = datetime('now')
              WHERE id = (SELECT id FROM portfolio_status ORDER BY id DESC LIMIT 1)`,
        args: [cash, equity, total],
    });
}

export async function updateHoldingPrice(ticker: string, current_price: number): Promise<void> {
    const db = getTurso();
    await db.execute({
        sql: `UPDATE portfolio_holdings SET current_price = ?, market_value = shares * ?, last_updated = datetime('now')
              WHERE ticker = ?`,
        args: [current_price, current_price, ticker],
    });
}

export async function updateHighWaterMark(ticker: string, price: number): Promise<void> {
    const db = getTurso();
    await db.execute({
        sql: `UPDATE portfolio_holdings SET high_water_mark = MAX(COALESCE(high_water_mark, 0), ?)
              WHERE ticker = ?`,
        args: [price, ticker],
    });
}

export async function getHoldings(): Promise<PortfolioHolding[]> {
    const db = getTurso();
    const r = await db.execute({ sql: 'SELECT * FROM portfolio_holdings ORDER BY market_value DESC', args: [] });
    return (r.rows as any[]).map(row => {
        const avg_cost = row.avg_cost;
        const current_price = row.current_price;
        const return_pct = avg_cost > 0 ? ((current_price - avg_cost) / avg_cost) * 100 : 0;
        return {
            ticker: row.ticker,
            shares: row.shares,
            avg_cost: row.avg_cost,
            current_price: row.current_price,
            market_value: row.market_value,
            return_pct: return_pct,
            last_updated: row.last_updated || '',
            opened_at: row.opened_at || '',
            high_water_mark: row.high_water_mark || 0,
            partial_sells: row.partial_sells || 0,
            atr: row.atr || 0,
        };
    });
}

export async function getTransactions(limit = 50): Promise<PortfolioTransaction[]> {
    const db = getTurso();
    const r = await db.execute({ sql: 'SELECT * FROM portfolio_transactions ORDER BY date DESC LIMIT ?', args: [limit] });
    return (r.rows as any[]).map(row => ({
        id: row.id,
        date: row.date,
        ticker: row.ticker,
        type: row.type,
        shares: row.shares,
        price: row.price,
        total_amount: row.total_amount,
        notes: row.notes,
    }));
}

export async function getHistory(days = 30): Promise<PortfolioHistory[]> {
    const db = getTurso();
    const r = await db.execute({ sql: 'SELECT * FROM portfolio_history ORDER BY date ASC LIMIT ?', args: [days] });
    return (r.rows as any[]).map(row => ({
        date: row.date,
        total_value: row.total_value,
        cash_balance: row.cash_balance,
        equity_value: row.equity_value,
        day_change_pct: row.day_change_pct,
    }));
}

export async function saveHistorySnapshot(): Promise<void> {
    const db = getTurso();
    const status = await getPortfolioStatus();
    const now = new Date();
    // Use ET date for consistency
    const dateStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-'); // Output roughly YYYY-MM-DD format (not perfectly ISO but works, let's use standard ISO slices)

    const etDateStr = now.toLocaleDateString('sv'); // 'sv' locale outputs YYYY-MM-DD

    // Calculate previous day change
    const prevR = await db.execute({ sql: 'SELECT total_value FROM portfolio_history ORDER BY date DESC LIMIT 1', args: [] });
    const prevData = prevR.rows[0] as any;
    let dayChange = 0;
    if (prevData && prevData.total_value > 0) {
        dayChange = ((status.total_value - prevData.total_value) / prevData.total_value) * 100;
    }

    await db.execute({
        sql: `INSERT OR REPLACE INTO portfolio_history (date, total_value, cash_balance, equity_value, day_change_pct)
              VALUES (?, ?, ?, ?, ?)`,
        args: [etDateStr, status.total_value, status.cash_balance, status.total_equity, dayChange]
    });
}

/**
 * Save a high-frequency portfolio snapshot (called every trading cycle).
 * These power the intraday/weekly chart views.
 */
export async function savePortfolioSnapshot(): Promise<void> {
    const db = getTurso();
    const status = await getPortfolioStatus();
    const now = new Date().toISOString();

    await db.execute({
        sql: `INSERT INTO portfolio_snapshots (timestamp, total_value, cash_balance, equity_value)
              VALUES (?, ?, ?, ?)`,
        args: [now, status.total_value, status.cash_balance, status.total_equity]
    });
}

/**
 * Get detailed portfolio history with variable granularity based on timeframe.
 *   - 1D:  all snapshots from the last 24h (every cycle = ~20min intervals)
 *   - 1W:  snapshots sampled roughly every hour for 7 days
 *   - 30D: daily history (portfolio_history table) + today's snapshots appended
 */
export async function getDetailedHistory(timeframe: '1D' | '1W' | '30D'): Promise<PortfolioSnapshot[]> {
    const db = getTurso();
    const now = new Date();

    if (timeframe === '1D') {
        // Last 24h — return all snapshots
        const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const r = await db.execute({
            sql: `SELECT timestamp, total_value, cash_balance, equity_value
                  FROM portfolio_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC`,
            args: [cutoff]
        });
        return (r.rows as any[]).map(row => ({
            timestamp: row.timestamp,
            total_value: row.total_value,
            cash_balance: row.cash_balance,
            equity_value: row.equity_value,
        }));
    }

    if (timeframe === '1W') {
        // Last 7 days — sample every ~1 hour using SQLite window trick
        const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const r = await db.execute({
            sql: `SELECT timestamp, total_value, cash_balance, equity_value
                  FROM portfolio_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC`,
            args: [cutoff]
        });
        const allRows = (r.rows as any[]).map(row => ({
            timestamp: row.timestamp,
            total_value: row.total_value,
            cash_balance: row.cash_balance,
            equity_value: row.equity_value,
        }));
        // Downsample: keep 1 per hour
        return downsampleByInterval(allRows, 60 * 60 * 1000);
    }

    // 30D: use daily history + append today's snapshots
    const histR = await db.execute({
        sql: `SELECT date, total_value, cash_balance, equity_value
              FROM portfolio_history ORDER BY date ASC LIMIT 30`,
        args: []
    });
    const dailyPoints: PortfolioSnapshot[] = [];
    for (const row of histR.rows as any[]) {
        const ts = normalizeDateToISO(row.date);
        if (!ts) continue; // skip unparseable dates
        dailyPoints.push({
            timestamp: ts,
            total_value: row.total_value,
            cash_balance: row.cash_balance,
            equity_value: row.equity_value,
        });
    }

    // Append today's snapshots (sampled every 4 hours)
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayCutoff = todayStart.toISOString();
    const todayR = await db.execute({
        sql: `SELECT timestamp, total_value, cash_balance, equity_value
              FROM portfolio_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC`,
        args: [todayCutoff]
    });
    const todaySnapshots: PortfolioSnapshot[] = (todayR.rows as any[]).map(row => ({
        timestamp: row.timestamp,
        total_value: row.total_value,
        cash_balance: row.cash_balance,
        equity_value: row.equity_value,
    }));
    const todaySampled = downsampleByInterval(todaySnapshots, 4 * 60 * 60 * 1000);

    // Merge, dedup by removing daily rows for today (we have live snapshots instead)
    const todayDate = now.toISOString().slice(0, 10);
    const filteredDaily = dailyPoints.filter(p => !p.timestamp.startsWith(todayDate));
    return [...filteredDaily, ...todaySampled];
}

/**
 * Normalize a date string from portfolio_history into a valid ISO timestamp.
 * Handles: YYYY-MM-DD, MM/DD/YYYY, full ISO strings, and the old buggy YYYY-DD-MM format.
 * Returns null if the date is completely unparseable.
 */
function normalizeDateToISO(dateStr: string): string | null {
    if (!dateStr) return null;

    // Already a full ISO timestamp (has T and/or Z)
    if (dateStr.includes('T')) {
        const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
        return isNaN(d.getTime()) ? null : d.toISOString();
    }

    // Slash-separated: MM/DD/YYYY
    if (dateStr.includes('/')) {
        const parts = dateStr.split('/');
        if (parts.length === 3) {
            const [m, d, y] = parts;
            const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T16:00:00Z`;
            const date = new Date(iso);
            return isNaN(date.getTime()) ? null : date.toISOString();
        }
        return null;
    }

    // Dash-separated: YYYY-MM-DD (standard) or possibly YYYY-DD-MM (old bug)
    if (dateStr.includes('-')) {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            let [a, b, c] = parts;
            // Standard YYYY-MM-DD
            let iso = `${a}-${b}-${c}T16:00:00Z`;
            let date = new Date(iso);
            if (!isNaN(date.getTime()) && date.getFullYear() > 2000) {
                return date.toISOString();
            }
            // Try YYYY-DD-MM (swapped month/day from old bug)
            iso = `${a}-${c}-${b}T16:00:00Z`;
            date = new Date(iso);
            if (!isNaN(date.getTime()) && date.getFullYear() > 2000) {
                return date.toISOString();
            }
        }
        return null;
    }

    return null;
}

/** Downsample snapshots to at most 1 per interval (in ms). Keeps first point per bucket + always keeps the last point. */
function downsampleByInterval(points: PortfolioSnapshot[], intervalMs: number): PortfolioSnapshot[] {
    if (points.length <= 2) return points;
    const result: PortfolioSnapshot[] = [];
    let lastBucket = -1;
    for (const p of points) {
        const ts = new Date(p.timestamp).getTime();
        const bucket = Math.floor(ts / intervalMs);
        if (bucket !== lastBucket) {
            result.push(p);
            lastBucket = bucket;
        }
    }
    // Always include the last point for up-to-date value
    const last = points[points.length - 1];
    if (result.length > 0 && result[result.length - 1].timestamp !== last.timestamp) {
        result.push(last);
    }
    return result;
}

/** Clean up portfolio snapshots older than 31 days. */
export async function cleanupOldSnapshots(): Promise<number> {
    const db = getTurso();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 31);
    const cutoffStr = cutoff.toISOString();
    const r = await db.execute({
        sql: 'DELETE FROM portfolio_snapshots WHERE timestamp < ?',
        args: [cutoffStr],
    });
    return r.rowsAffected;
}

export async function executeTrade(
    ticker: string,
    type: 'BUY' | 'SELL',
    shares: number,
    price: number,
    notes?: string,
    tradeMetadata?: { atr?: number }
): Promise<void> {
    const db = getTurso();
    const totalAmount = shares * price;
    const now = new Date().toISOString();

    // 1. Log Transaction
    await db.execute({
        sql: `INSERT INTO portfolio_transactions (ticker, type, shares, price, total_amount, notes, date)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [ticker, type, shares, price, totalAmount, notes || null, now],
    });

    if (type === 'BUY') {
        const ex = await db.execute({ sql: 'SELECT * FROM portfolio_holdings WHERE ticker = ?', args: [ticker] });
        const h = (ex.rows[0] as any) ?? null;
        if (h) {
            const newShares = h.shares + shares;
            const newCost = ((h.shares * h.avg_cost) + totalAmount) / newShares;
            const newHWM = Math.max(h.high_water_mark || 0, price);
            await db.execute({
                sql: `UPDATE portfolio_holdings SET shares = ?, avg_cost = ?, current_price = ?, market_value = ?,
                      high_water_mark = ?, last_updated = ? WHERE ticker = ?`,
                args: [newShares, newCost, price, newShares * price, newHWM, now, ticker],
            });
        } else {
            await db.execute({
                sql: `INSERT INTO portfolio_holdings (ticker, shares, avg_cost, current_price, market_value, opened_at, high_water_mark, partial_sells, atr)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
                args: [ticker, shares, price, price, totalAmount, now, price, tradeMetadata?.atr || 0],
            });
        }
    } else {
        const ex = await db.execute({ sql: 'SELECT * FROM portfolio_holdings WHERE ticker = ?', args: [ticker] });
        const h = (ex.rows[0] as any);
        if (!h) throw new Error(`Cannot sell ${ticker}, not in portfolio.`);
        const newShares = h.shares - shares;
        if (newShares <= 0.0001) {
            await db.execute({ sql: 'DELETE FROM portfolio_holdings WHERE ticker = ?', args: [ticker] });
            // Mark for EOD cleanup – intraday data stays until 4 PM ET
            await db.execute({
                sql: `INSERT OR REPLACE INTO sold_today (ticker, sold_at) VALUES (?, ?)`,
                args: [ticker, now],
            });
        } else {
            const newPartialSells = (h.partial_sells || 0) + 1;
            await db.execute({
                sql: `UPDATE portfolio_holdings SET shares = ?, current_price = ?, market_value = ?,
                      partial_sells = ?, last_updated = ? WHERE ticker = ?`,
                args: [newShares, price, newShares * price, newPartialSells, now, ticker],
            });
        }
    }
}

// ── Trading Analysis + Cycle Log (used by trading-engine) ──
export async function saveAnalysisResult(data: {
    ticker: string;
    action: 'BUY' | 'SELL' | 'HOLD';
    confidence: number;
    reason: string;
    sentimentScore?: number;
    sentimentConfidence?: number;
    rsi?: number;
    macdHistogram?: number;
    volumeRatio?: number;
    priceChangePct?: number;
    sma50?: number;
    sma200?: number;
}): Promise<void> {
    const db = getTurso();
    await db.execute({
        sql: `INSERT INTO trading_analysis_results(ticker, action, confidence, reason,
                sentiment_score, sentiment_confidence, rsi, macd_histogram, volume_ratio,
                price_change_pct, sma50, sma200)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            data.ticker,
            data.action,
            data.confidence,
            data.reason,
            data.sentimentScore ?? null,
            data.sentimentConfidence ?? null,
            data.rsi ?? null,
            data.macdHistogram ?? null,
            data.volumeRatio ?? null,
            data.priceChangePct ?? null,
            data.sma50 ?? null,
            data.sma200 ?? null,
        ],
    });
}

export async function saveCycleLog(cycleType: string, summary: string): Promise<void> {
    const db = getTurso();
    await db.execute({
        sql: `INSERT INTO trading_cycle_log(cycle_type, summary) VALUES(?, ?)`,
        args: [cycleType, summary],
    });
}

export async function getCycleLogs(limit = 50): Promise<{ cycle_type: string; ran_at: string; summary: string }[]> {
    try {
        const db = getTurso();
        const r = await db.execute({
            sql: 'SELECT cycle_type, ran_at, summary FROM trading_cycle_log ORDER BY ran_at DESC LIMIT ?',
            args: [limit],
        });
        return (r.rows as any[]).map(row => ({
            cycle_type: row.cycle_type,
            ran_at: row.ran_at || '',
            summary: row.summary || '',
        }));
    } catch {
        return [];
    }
}

export async function getAnalysisResults(limit = 50): Promise<any[]> {
    try {
        const db = getTurso();
        const r = await db.execute({
            sql: `SELECT ticker, action, confidence, reason, sentiment_score, sentiment_confidence,
                rsi, macd_histogram, volume_ratio, price_change_pct, sma50, sma200, analyzed_at
                  FROM trading_analysis_results ORDER BY analyzed_at DESC LIMIT ? `,
            args: [limit],
        });
        return (r.rows as any[]).map(row => ({
            ticker: row.ticker,
            action: row.action,
            confidence: row.confidence,
            reason: row.reason,
            sentiment_score: row.sentiment_score,
            sentiment_confidence: row.sentiment_confidence,
            rsi: row.rsi,
            macd_histogram: row.macd_histogram,
            volume_ratio: row.volume_ratio,
            price_change_pct: row.price_change_pct,
            sma50: row.sma50,
            sma200: row.sma200,
            analyzed_at: row.analyzed_at,
        }));
    } catch {
        return [];
    }
}

export async function getLastAnalysisAt(): Promise<string | null> {
    try {
        const db = getTurso();
        const r = await db.execute({
            sql: 'SELECT MAX(analyzed_at) as last_at FROM trading_analysis_results',
            args: [],
        });
        const last = (r.rows[0] as any)?.last_at;
        return last ?? null;
    } catch {
        return null;
    }
}

// ── Daily Snapshots (twice daily: 9:35 ET, 2:00 ET) ──
export async function saveDailySnapshot(row: Omit<DailySnapshot, 'snapshot_at'> & { snapshot_at: string }): Promise<void> {
    const db = getTurso();
    await db.execute({
        sql: `INSERT INTO daily_snapshots(ticker, snapshot_at, interval_type, open, high, low, close, volume, vwap, rvol)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [row.ticker, row.snapshot_at, row.interval_type, row.open, row.high, row.low, row.close, row.volume, row.vwap, row.rvol],
    });
}

export async function getDailySnapshots(ticker: string, days = 5): Promise<DailySnapshot[]> {
    const db = getTurso();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString();
    const r = await db.execute({
        sql: `SELECT ticker, snapshot_at, interval_type, open, high, low, close, volume, vwap, rvol
              FROM daily_snapshots WHERE ticker = ? AND snapshot_at >= ? ORDER BY snapshot_at ASC`,
        args: [ticker, cutoffStr],
    });
    return (r.rows as any[]).map(row => ({
        ticker: row.ticker,
        snapshot_at: row.snapshot_at,
        interval_type: row.interval_type,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        vwap: row.vwap,
        rvol: row.rvol,
    }));
}

// ── Intraday Holdings (10-min bars) ──
export async function saveIntradayBar(row: IntradayHolding): Promise<void> {
    const db = getTurso();
    await db.execute({
        sql: `INSERT INTO intraday_holdings(ticker, bar_time, open, high, low, close, volume, vwap)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [row.ticker, row.bar_time, row.open, row.high, row.low, row.close, row.volume, row.vwap],
    });
}

export async function getIntradayBars(ticker: string, dateStr?: string): Promise<IntradayHolding[]> {
    const db = getTurso();
    const target = dateStr || new Date().toISOString().slice(0, 10);
    const start = `${target} T00:00:00`;
    const end = `${target} T23: 59: 59`;
    const r = await db.execute({
        sql: `SELECT ticker, bar_time, open, high, low, close, volume, vwap
              FROM intraday_holdings WHERE ticker = ? AND bar_time >= ? AND bar_time <= ?
                ORDER BY bar_time ASC`,
        args: [ticker, start, end],
    });
    return (r.rows as any[]).map(row => ({
        ticker: row.ticker,
        bar_time: row.bar_time,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        vwap: row.vwap,
    }));
}

// ── Cleanup: delete daily_snapshots older than 5 days ──
export async function cleanupOldDailySnapshots(): Promise<number> {
    const db = getTurso();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 5);
    const cutoffStr = cutoff.toISOString();
    const r = await db.execute({
        sql: 'DELETE FROM daily_snapshots WHERE snapshot_at < ?',
        args: [cutoffStr],
    });
    return r.rowsAffected;
}

// ── EOD: delete intraday for tickers sold today (run after 4 PM ET) ──
export async function cleanupIntradayForSoldToday(): Promise<number> {
    const db = getTurso();
    const r = await db.execute({ sql: 'SELECT ticker FROM sold_today', args: [] });
    const tickers = (r.rows as any[]).map(row => row.ticker);
    if (tickers.length === 0) return 0;
    let total = 0;
    for (const t of tickers) {
        const del = await db.execute({ sql: 'DELETE FROM intraday_holdings WHERE ticker = ?', args: [t] });
        total += del.rowsAffected;
    }
    await db.execute({ sql: 'DELETE FROM sold_today', args: [] });
    return total;
}

// ── Cleanup logs older than 24 hours ──
export async function cleanupOldLogs(): Promise<{ cycles: number; analysis: number }> {
    const db = getTurso();
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 24);
    const cutoffStr = cutoff.toISOString();

    const r1 = await db.execute({
        sql: 'DELETE FROM trading_cycle_log WHERE ran_at < ?',
        args: [cutoffStr],
    });
    const r2 = await db.execute({
        sql: 'DELETE FROM trading_analysis_results WHERE analyzed_at < ?',
        args: [cutoffStr],
    });

    return {
        cycles: r1.rowsAffected,
        analysis: r2.rowsAffected
    };
}
