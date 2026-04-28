/**
 * Portfolio + Trading data on Turso (LibSQL).
 * Neon holds only screener_cache; everything else lives here.
 */
import { getTurso } from './turso';
import { getPreviousUsTradingSessionEtYmd } from './trading-session';
import { portfolioHistoryDayKey } from './portfolio-history-dates';

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
    // Without this index, SELECT MAX(analyzed_at) scans the whole table —
    // with 50k+ rows it pushes /api/status/cloud past its 15s client timeout.
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_tar_analyzed_at ON trading_analysis_results(analyzed_at DESC)`);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS trading_cycle_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_type TEXT NOT NULL,
        ran_at TEXT DEFAULT (datetime('now')),
        summary TEXT NOT NULL
      )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_tcl_ran_at ON trading_cycle_log(ran_at DESC)`);

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

    // Global engine lock to prevent overlapping trading cycles (cross-route / cross-cron).
    await db.execute(`
      CREATE TABLE IF NOT EXISTS engine_locks (
        lock_name TEXT PRIMARY KEY,
        owner_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
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
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Build a day-keyed map seeded from portfolio_history (legacy / explicit EOD
    // writes), then overlay the LAST portfolio_snapshot per ET day. Snapshots
    // win where both exist — they're live and always written, whereas
    // portfolio_history depends on the CLOSE cron firing cleanly every day.
    const [histR, snapR] = await Promise.all([
        db.execute({
            sql: 'SELECT date, total_value, cash_balance, equity_value, day_change_pct FROM portfolio_history ORDER BY date ASC',
            args: [],
        }),
        db.execute({
            sql: `SELECT timestamp, total_value, cash_balance, equity_value
                  FROM portfolio_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC`,
            args: [cutoff],
        }),
    ]);

    const byDay = new Map<string, { total_value: number; cash_balance: number; equity_value: number }>();

    for (const row of histR.rows as any[]) {
        const dayKey = portfolioHistoryDayKey(row.date);
        if (!dayKey) continue;
        byDay.set(dayKey, {
            total_value: row.total_value,
            cash_balance: row.cash_balance,
            equity_value: row.equity_value,
        });
    }

    for (const row of snapR.rows as any[]) {
        const dayKey = etDateKey(row.timestamp);
        byDay.set(dayKey, {
            total_value: row.total_value,
            cash_balance: row.cash_balance,
            equity_value: row.equity_value,
        });
    }

    const sortedDays = Array.from(byDay.keys()).sort((a, b) => a.localeCompare(b));
    const cutoffKey = cutoff.slice(0, 10);
    const windowDays = sortedDays.filter(d => d >= cutoffKey);

    const out: PortfolioHistory[] = [];
    for (const dk of windowDays) {
        const d = byDay.get(dk)!;
        const priorTotal = lookupPriorSessionTotal(byDay, dk);
        const changePct =
            priorTotal != null && priorTotal > 0
                ? ((d.total_value - priorTotal) / priorTotal) * 100
                : 0;
        out.push({
            date: dk,
            total_value: d.total_value,
            cash_balance: d.cash_balance,
            equity_value: d.equity_value,
            day_change_pct: changePct,
        });
    }
    return out.slice(-days);
}

/** Prior US equity session that exists in `byDay`, walking back across weekends (and missing rows). */
function lookupPriorSessionTotal(
    byDay: Map<string, { total_value: number; cash_balance: number; equity_value: number }>,
    sessionKey: string,
): number | null {
    let p = getPreviousUsTradingSessionEtYmd(sessionKey);
    for (let i = 0; i < 20; i++) {
        const row = byDay.get(p);
        if (row) return row.total_value;
        p = getPreviousUsTradingSessionEtYmd(p);
    }
    return null;
}

export async function saveHistorySnapshot(): Promise<void> {
    const db = getTurso();
    const status = await getPortfolioStatus();
    const now = new Date();
    const etDateStr = now.toLocaleDateString('sv', { timeZone: ET_TZ });

    const histR = await db.execute({
        sql: 'SELECT date, total_value FROM portfolio_history',
        args: [],
    });
    const totalsByDay = new Map<string, number>();
    for (const row of histR.rows as any[]) {
        const histKey = portfolioHistoryDayKey(row.date);
        if (histKey) totalsByDay.set(histKey, row.total_value as number);
    }

    const priorSession = getPreviousUsTradingSessionEtYmd(etDateStr);
    let priorTotal: number | null = null;
    let p = priorSession;
    for (let i = 0; i < 20 && priorTotal == null; i++) {
        priorTotal = totalsByDay.get(p) ?? null;
        if (priorTotal != null) break;
        p = getPreviousUsTradingSessionEtYmd(p);
    }

    let dayChange = 0;
    if (priorTotal != null && priorTotal > 0) {
        dayChange = ((status.total_value - priorTotal) / priorTotal) * 100;
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
    const cash = status.cash_balance;
    const eq = status.total_equity;
    const implied = cash + eq;
    let total = status.total_value;
    const tol = Math.max(150, Math.abs(implied) * 0.0025);
    if (Math.abs(total - implied) > tol) {
        total = implied;
    }

    await db.execute({
        sql: `INSERT INTO portfolio_snapshots (timestamp, total_value, cash_balance, equity_value)
              VALUES (?, ?, ?, ?)`,
        args: [now, total, cash, eq]
    });
}

/**
 * Get detailed portfolio history with variable granularity based on timeframe.
 * All timeframes are now derived directly from portfolio_snapshots (the live,
 * high-frequency table written every trading cycle). portfolio_history is
 * treated as a backfill source for days that predate the snapshot table.
 *
 *   - 1D:   snapshots from today's ET date (00:00 ET → now). If today has no
 *           data yet (pre-market / weekend), fall back to the most recent
 *           ET date that has snapshots.
 *   - 1W:   snapshots from the last 7 days downsampled to ~1/hour.
 *   - 30D:  last snapshot per ET day for the last 30 days. Today's live
 *           current value is appended so the chart stays up to date.
 *   - ALL:  last snapshot per ET day from Jan 1 2026 onward, merged with
 *           portfolio_history rows for days before snapshot coverage began.
 */
const ET_TZ = 'America/New_York';

function etDateKey(ts: string | Date): string {
    const d = typeof ts === 'string' ? new Date(ts) : ts;
    return d.toLocaleDateString('sv', { timeZone: ET_TZ });
}

function rowsToSnapshots(rows: any[]): PortfolioSnapshot[] {
    return rows.map(row => ({
        timestamp: row.timestamp,
        total_value: row.total_value,
        cash_balance: row.cash_balance,
        equity_value: row.equity_value,
    }));
}

export async function getDetailedHistory(timeframe: '1D' | '1W' | '30D' | 'ALL'): Promise<PortfolioSnapshot[]> {
    const db = getTurso();
    const now = new Date();

    if (timeframe === '1D') {
        // Pull last 72h of snapshots (enough to cover a weekend). Filter to today's
        // ET date. If that's empty (weekend / very early pre-market), fall back to
        // the most recent ET date that has any data.
        const windowStart = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
        const r = await db.execute({
            sql: `SELECT timestamp, total_value, cash_balance, equity_value
                  FROM portfolio_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC`,
            args: [windowStart]
        });
        const all = rowsToSnapshots(r.rows as any[]);
        if (all.length === 0) return [];

        const todayKey = etDateKey(now);
        const today = all.filter(s => etDateKey(s.timestamp) === todayKey);
        if (today.length >= 2) {
            return smoothIsolatedPortfolioValueSpikes(reconcileSnapshotTotals(today));
        }

        // Fallback: most recent ET date in the window
        const latestKey = etDateKey(all[all.length - 1].timestamp);
        const session = all.filter(s => etDateKey(s.timestamp) === latestKey);
        return smoothIsolatedPortfolioValueSpikes(reconcileSnapshotTotals(session));
    }

    if (timeframe === '1W') {
        const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const r = await db.execute({
            sql: `SELECT timestamp, total_value, cash_balance, equity_value
                  FROM portfolio_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC`,
            args: [cutoff]
        });
        const snaps = rowsToSnapshots(r.rows as any[]);
        return smoothIsolatedPortfolioValueSpikes(reconcileSnapshotTotals(downsampleByInterval(snaps, 60 * 60 * 1000)));
    }

    // ── 30D / ALL: one point per ET day, sourced primarily from portfolio_snapshots ──
    const startDate = timeframe === 'ALL'
        ? new Date('2026-01-01T00:00:00Z')
        : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const snapR = await db.execute({
        sql: `SELECT timestamp, total_value, cash_balance, equity_value
              FROM portfolio_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC`,
        args: [startDate.toISOString()]
    });
    const snaps = rowsToSnapshots(snapR.rows as any[]);

    // Keep the LAST snapshot per ET date — that's the effective EOD value
    // (or most recent intraday value for today in progress).
    const lastPerDay = new Map<string, PortfolioSnapshot>();
    for (const s of snaps) {
        lastPerDay.set(etDateKey(s.timestamp), s);
    }

    // For ALL: backfill days that predate snapshot coverage using portfolio_history
    if (timeframe === 'ALL') {
        const histR = await db.execute({
            sql: `SELECT date, total_value, cash_balance, equity_value
                  FROM portfolio_history ORDER BY date ASC`,
            args: []
        });
        for (const row of histR.rows as any[]) {
            const dayKey = portfolioHistoryDayKey(row.date);
            if (!dayKey) continue;
            if (lastPerDay.has(dayKey)) continue; // prefer live snapshot data
            lastPerDay.set(dayKey, {
                timestamp: dayKey + 'T20:00:00Z',
                total_value: row.total_value,
                cash_balance: row.cash_balance,
                equity_value: row.equity_value,
            });
        }
    }

    const points = Array.from(lastPerDay.values()).sort(
        (a, b) => a.timestamp.localeCompare(b.timestamp)
    );
    return smoothIsolatedPortfolioValueSpikes(reconcileSnapshotTotals(points));
}

/** When total_value drifts from cash + equity (race / stale equity), trust the components for charts. */
function reconcileSnapshotTotals(points: PortfolioSnapshot[]): PortfolioSnapshot[] {
    return points.map((p) => {
        const implied = p.cash_balance + p.equity_value;
        const tol = Math.max(150, Math.abs(implied) * 0.0025);
        if (Math.abs(p.total_value - implied) <= tol) return p;
        return { ...p, total_value: implied };
    });
}

/**
 * Drop single-point spikes when the previous and next points agree but the middle
 * jumps (bad snapshot / race). Keeps real trends: if neighbors differ materially, untouched.
 */
function smoothIsolatedPortfolioValueSpikes(points: PortfolioSnapshot[]): PortfolioSnapshot[] {
    if (points.length < 3) return points;
    const out = points.map((p) => ({ ...p }));
    for (let i = 1; i < out.length - 1; i++) {
        const prev = out[i - 1].total_value;
        const cur = out[i].total_value;
        const next = out[i + 1].total_value;
        const mid = (prev + next) / 2;
        const neighborSpread = Math.abs(prev - next);
        const scale = Math.max(Math.abs(prev), Math.abs(next), 1);
        const dev = Math.abs(cur - mid);
        const threshold = Math.max(scale * 0.015, 400);
        const looksIsolated = dev > threshold && neighborSpread <= scale * 0.02;
        const neighborsQuiet = neighborSpread <= scale * 0.03;
        const strongOutlier = dev > Math.max(scale * 0.08, 2500);
        if (!looksIsolated && !(strongOutlier && neighborsQuiet)) continue;
        out[i] = { ...out[i], total_value: mid };
    }
    return out;
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
    // Zero-pad month/day so legacy rows like "2026-2-20" still parse.
    if (dateStr.includes('-')) {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            const [a, b, c] = parts;
            const bp = b.padStart(2, '0');
            const cp = c.padStart(2, '0');
            let iso = `${a}-${bp}-${cp}T16:00:00Z`;
            let date = new Date(iso);
            if (!isNaN(date.getTime()) && date.getFullYear() > 2000) {
                return date.toISOString();
            }
            iso = `${a}-${cp}-${bp}T16:00:00Z`;
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

    // Best-effort duplicate suppression for overlapping cron executions:
    // skip if an equivalent trade was already recorded very recently.
    const duplicateCutoff = new Date(Date.now() - 120 * 1000).toISOString();
    const dup = await db.execute({
        sql: `SELECT id FROM portfolio_transactions
              WHERE ticker = ? AND type = ? AND shares = ? AND price = ? AND COALESCE(notes,'') = COALESCE(?, '')
                AND date >= ?
              ORDER BY date DESC LIMIT 1`,
        args: [ticker, type, shares, price, notes || null, duplicateCutoff],
    });
    if ((dup.rows as any[]).length > 0) {
        return;
    }

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

        // Log transaction only after holding mutation succeeds.
        await db.execute({
            sql: `INSERT INTO portfolio_transactions (ticker, type, shares, price, total_amount, notes, date)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [ticker, type, shares, price, totalAmount, notes || null, now],
        });
    } else {
        const ex = await db.execute({ sql: 'SELECT * FROM portfolio_holdings WHERE ticker = ?', args: [ticker] });
        const h = (ex.rows[0] as any);
        if (!h) throw new Error(`Cannot sell ${ticker}, not in portfolio.`);
        if (shares > h.shares + 0.0001) {
            throw new Error(`Cannot sell ${shares} ${ticker}; only ${h.shares} available.`);
        }
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

        // Log transaction only after holding mutation succeeds.
        await db.execute({
            sql: `INSERT INTO portfolio_transactions (ticker, type, shares, price, total_amount, notes, date)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [ticker, type, shares, price, totalAmount, notes || null, now],
        });
    }
}

// ── Global Engine Lock (prevents overlapping cycles) ──
export async function acquireEngineLock(lockName: string, ttlSeconds = 180): Promise<string | null> {
    const db = getTurso();
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const now = new Date().toISOString();

    // Clear stale lock first, then attempt to claim.
    await db.execute({
        sql: `DELETE FROM engine_locks WHERE lock_name = ? AND expires_at < ?`,
        args: [lockName, now],
    });

    const ins = await db.execute({
        sql: `INSERT OR IGNORE INTO engine_locks (lock_name, owner_token, expires_at, updated_at)
              VALUES (?, ?, ?, ?)`,
        args: [lockName, token, expiresAt, now],
    });
    if (ins.rowsAffected && ins.rowsAffected > 0) {
        return token;
    }
    return null;
}

export async function releaseEngineLock(lockName: string, ownerToken: string): Promise<void> {
    const db = getTurso();
    await db.execute({
        sql: `DELETE FROM engine_locks WHERE lock_name = ? AND owner_token = ?`,
        args: [lockName, ownerToken],
    });
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

/**
 * "When did the cloud last do anything?" — used by the Cloud Status badge.
 *
 * Prefers the compact `trading_cycle_log` table (one row per cron cycle) over
 * `trading_analysis_results` (N rows per cycle, 50k+). A MAX() over the big
 * table without its new index takes ~25s and exceeds the client timeout.
 * The cycle log is tiny and has an index on ran_at, so this is effectively O(1).
 * Falls back to the analysis table only if the cycle log is empty (fresh DB).
 */
export async function getLastAnalysisAt(): Promise<string | null> {
    const db = getTurso();
    try {
        const r = await db.execute({
            sql: 'SELECT ran_at FROM trading_cycle_log ORDER BY ran_at DESC LIMIT 1',
            args: [],
        });
        const last = (r.rows[0] as any)?.ran_at;
        if (last) return last;
    } catch {
        // Fall through to the analysis-results fallback below.
    }
    try {
        const r = await db.execute({
            sql: 'SELECT analyzed_at FROM trading_analysis_results ORDER BY analyzed_at DESC LIMIT 1',
            args: [],
        });
        const last = (r.rows[0] as any)?.analyzed_at;
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
    const start = `${target}T00:00:00Z`;
    const end = `${target}T23:59:59Z`;
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

/** YYYY-MM-DD in America/New_York (aligns with US equity session calendar). */
function getCalendarDateNY(d: Date): string {
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Parse timestamps from DB: full ISO with Z, or UTC without suffix (see snapshot-service roundTo10Min).
 */
function parseUtcInstant(iso: string): Date {
    const s = (iso || '').trim();
    if (!s) return new Date(NaN);
    if (s.endsWith('Z')) return new Date(s);
    if (/[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
    return new Date(s + 'Z');
}

/**
 * Get each ticker's session open for the current US trading calendar day.
 * Uses intraday_holdings (10m bars, earliest bar per ticker on that NY date), then falls back to
 * today's OPEN row in daily_snapshots when intraday has not started yet.
 */
export async function getDayOpenPrices(): Promise<Map<string, number>> {
    const db = getTurso();
    const nyToday = getCalendarDateNY(new Date());

    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 19);

    const r = await db.execute({
        sql: `SELECT ticker, open, bar_time FROM intraday_holdings
              WHERE bar_time >= ? ORDER BY bar_time ASC`,
        args: [cutoffStr],
    });

    const dayOpens = new Map<string, number>();
    for (const row of r.rows as any[]) {
        if (dayOpens.has(row.ticker)) continue;
        const barNy = getCalendarDateNY(parseUtcInstant(row.bar_time));
        if (barNy === nyToday) {
            dayOpens.set(row.ticker, row.open);
        }
    }

    const snapR = await db.execute({
        sql: `SELECT ticker, open, snapshot_at FROM daily_snapshots
              WHERE interval_type = 'OPEN'
              ORDER BY snapshot_at DESC
              LIMIT 400`,
        args: [],
    });
    for (const row of snapR.rows as any[]) {
        const snapNy = getCalendarDateNY(parseUtcInstant(row.snapshot_at));
        if (snapNy === nyToday && !dayOpens.has(row.ticker)) {
            dayOpens.set(row.ticker, row.open);
        }
    }

    return dayOpens;
}

/**
 * Get tickers that were sold via **loss exits** within the last N days.
 * Only genuine risk-exits (stops and trend breakdowns) trigger the cooldown.
 * Profit-taking trims do NOT block re-entry — if a name sets up again after
 * a profitable exit, we want to be able to ride it a second time.
 */
export async function getRecentStopLossSells(cooldownDays: number = 3): Promise<Set<string>> {
    const db = getTurso();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - cooldownDays);
    const cutoffStr = cutoff.toISOString();

    const r = await db.execute({
        sql: `SELECT DISTINCT ticker FROM portfolio_transactions
              WHERE type = 'SELL' AND date >= ?
              AND (
                notes LIKE '%Hard Stop%' OR
                notes LIKE '%Gap-Down Exit%' OR
                notes LIKE '%Trend Exit%' OR
                notes LIKE '%Aging Exit%' OR
                -- Only trailing stops that triggered at a loss enforce cooldown.
                -- Profitable trailing exits are effectively profit-taking and are excluded.
                -- The trading engine appends "return -X.X%" to trailing-stop notes for this check.
                (notes LIKE '%Trailing Stop%' AND notes LIKE '%return -%')
              )`,
        args: [cutoffStr],
    });

    return new Set((r.rows as any[]).map(row => row.ticker));
}
