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
        opened_at TEXT DEFAULT (datetime('now'))
      )
    `);

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

export async function getHoldings(): Promise<PortfolioHolding[]> {
    const db = getTurso();
    const r = await db.execute({ sql: 'SELECT * FROM portfolio_holdings ORDER BY market_value DESC', args: [] });
    return (r.rows as any[]).map(row => ({
        ticker: row.ticker,
        shares: row.shares,
        avg_cost: row.avg_cost,
        current_price: row.current_price,
        market_value: row.market_value,
        return_pct: row.return_pct ?? 0,
        last_updated: row.last_updated || '',
        opened_at: row.opened_at || '',
    }));
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

export async function executeTrade(
    ticker: string,
    type: 'BUY' | 'SELL',
    shares: number,
    price: number,
    notes?: string
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
            await db.execute({
                sql: `UPDATE portfolio_holdings SET shares = ?, avg_cost = ?, current_price = ?, market_value = ?, last_updated = ?
                      WHERE ticker = ?`,
                args: [newShares, newCost, price, newShares * price, now, ticker],
            });
        } else {
            await db.execute({
                sql: `INSERT INTO portfolio_holdings (ticker, shares, avg_cost, current_price, market_value, opened_at)
                      VALUES (?, ?, ?, ?, ?, ?)`,
                args: [ticker, shares, price, price, totalAmount, now],
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
            await db.execute({
                sql: `UPDATE portfolio_holdings SET shares = ?, current_price = ?, market_value = ?, last_updated = ?
                      WHERE ticker = ?`,
                args: [newShares, price, newShares * price, now, ticker],
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
        sql: `INSERT INTO trading_analysis_results (ticker, action, confidence, reason,
              sentiment_score, sentiment_confidence, rsi, macd_histogram, volume_ratio,
              price_change_pct, sma50, sma200)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        sql: `INSERT INTO trading_cycle_log (cycle_type, summary) VALUES (?, ?)`,
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
                  FROM trading_analysis_results ORDER BY analyzed_at DESC LIMIT ?`,
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
        sql: `INSERT INTO daily_snapshots (ticker, snapshot_at, interval_type, open, high, low, close, volume, vwap, rvol)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        sql: `INSERT INTO intraday_holdings (ticker, bar_time, open, high, low, close, volume, vwap)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [row.ticker, row.bar_time, row.open, row.high, row.low, row.close, row.volume, row.vwap],
    });
}

export async function getIntradayBars(ticker: string, dateStr?: string): Promise<IntradayHolding[]> {
    const db = getTurso();
    const target = dateStr || new Date().toISOString().slice(0, 10);
    const start = `${target}T00:00:00`;
    const end = `${target}T23:59:59`;
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
