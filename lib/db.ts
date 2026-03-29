import { Pool } from 'pg';

// Shared Neon PostgreSQL pool
let pool: Pool | null = null;

// In-memory fallback for local development when Neon is unreachable (never used in production)
let inMemoryCache: any[] = [];
let useInMemory = false;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** In-memory DB only when developing locally or explicitly opted in via env. */
export function allowInMemoryFallback(): boolean {
    return process.env.NODE_ENV === 'development' || process.env.ALLOW_IN_MEMORY_DB === 'true';
}

/** Drop the pool so the next query opens a fresh connection (helps after Neon cold start). */
export async function resetPool(): Promise<void> {
    if (pool) {
        try {
            await pool.end();
        } catch {
            // ignore
        }
        pool = null;
    }
}

const INIT_SQL = `
    CREATE TABLE IF NOT EXISTS screener_cache (
      ticker VARCHAR(10) PRIMARY KEY,
      price REAL,
      market_cap BIGINT,
      pe_ratio REAL,
      roe_pct REAL,
      debt_to_equity REAL,
      gross_margin_pct REAL,
      dividend_yield_pct REAL,
      roa_pct REAL,
      total_revenue BIGINT,
      revenue_per_employee REAL,
      sector VARCHAR(100),
      industry VARCHAR(200),
      company_name VARCHAR(300),
      fifty_two_week_high REAL,
      fifty_two_week_low REAL,
      beta REAL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS monitored_prospects (
      ticker VARCHAR(10) PRIMARY KEY,
      score REAL,
      added_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;

async function withDbRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const maxAttempts = 4;
    const delaysMs = [0, 600, 2000, 5000];
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            await sleep(delaysMs[attempt]);
            await resetPool();
        }
        try {
            return await fn();
        } catch (e: any) {
            lastError = e;
            const msg = e?.message || String(e);
            console.warn(`[DB] ${operation} attempt ${attempt + 1}/${maxAttempts} failed: ${msg}`);
            if (attempt === maxAttempts - 1) break;
        }
    }
    throw lastError;
}

async function initScreenerTableOnce(): Promise<void> {
    const db = getPool();
    await db.query(INIT_SQL);
}

export function getPool(): Pool {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.NEON_DATABASE_URL,
            max: 5,
            idleTimeoutMillis: 30000,
            // Neon compute wake + TLS can exceed 10s on cold start
            connectionTimeoutMillis: 20000,
        });
    }
    return pool;
}

/**
 * Ensure tables exist. In production, retries on transient Neon cold start / connection errors.
 * In-memory mode only when NODE_ENV=development or ALLOW_IN_MEMORY_DB=true.
 */
export async function initScreenerTable(): Promise<void> {
    if (allowInMemoryFallback()) {
        try {
            await withDbRetry('initScreenerTable', initScreenerTableOnce);
            useInMemory = false;
        } catch (error: any) {
            console.warn('[DB] Neon connection failed, using in-memory storage for local dev:', error.message);
            useInMemory = true;
        }
        return;
    }
    await withDbRetry('initScreenerTable', initScreenerTableOnce);
    useInMemory = false;
}

/**
 * Lightweight ping used by cron trade + external ping route to keep Neon from sleeping.
 */
export async function warmNeon(): Promise<void> {
    await initScreenerTable();
    if (useInMemory && allowInMemoryFallback()) {
        return;
    }
    if (useInMemory) {
        throw new Error('[DB] warmNeon: unexpected in-memory mode in production');
    }
    await withDbRetry('warmNeon', async () => {
        const db = getPool();
        await db.query('SELECT 1');
    });
}

// Upsert a screener row
export async function upsertScreenerRow(data: {
    ticker: string;
    price: number | null;
    market_cap: number | null;
    pe_ratio: number | null;
    roe_pct: number | null;
    debt_to_equity: number | null;
    gross_margin_pct: number | null;
    dividend_yield_pct: number | null;
    roa_pct: number | null;
    total_revenue: number | null;
    revenue_per_employee: number | null;
    sector: string | null;
    industry: string | null;
    company_name: string | null;
    fifty_two_week_high: number | null;
    fifty_two_week_low: number | null;
    beta: number | null;
}): Promise<void> {
    if (useInMemory) {
        if (!allowInMemoryFallback()) {
            throw new Error('[DB] upsertScreenerRow: in-memory mode is not allowed in production');
        }
        const existingIndex = inMemoryCache.findIndex(row => row.ticker === data.ticker);
        if (existingIndex >= 0) {
            inMemoryCache[existingIndex] = { ...data, updated_at: new Date().toISOString() };
        } else {
            inMemoryCache.push({ ...data, updated_at: new Date().toISOString() });
        }
        return;
    }

    await withDbRetry('upsertScreenerRow', async () => {
        const db = getPool();
        await db.query(
            `INSERT INTO screener_cache (
      ticker, price, market_cap, pe_ratio, roe_pct, debt_to_equity,
      gross_margin_pct, dividend_yield_pct, roa_pct, total_revenue,
      revenue_per_employee, sector, industry, company_name,
      fifty_two_week_high, fifty_two_week_low, beta, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, NOW())
    ON CONFLICT (ticker) DO UPDATE SET
      price = EXCLUDED.price,
      market_cap = EXCLUDED.market_cap,
      pe_ratio = EXCLUDED.pe_ratio,
      roe_pct = EXCLUDED.roe_pct,
      debt_to_equity = EXCLUDED.debt_to_equity,
      gross_margin_pct = EXCLUDED.gross_margin_pct,
      dividend_yield_pct = EXCLUDED.dividend_yield_pct,
      roa_pct = EXCLUDED.roa_pct,
      total_revenue = EXCLUDED.total_revenue,
      revenue_per_employee = EXCLUDED.revenue_per_employee,
      sector = EXCLUDED.sector,
      industry = EXCLUDED.industry,
      company_name = EXCLUDED.company_name,
      fifty_two_week_high = EXCLUDED.fifty_two_week_high,
      fifty_two_week_low = EXCLUDED.fifty_two_week_low,
      beta = EXCLUDED.beta,
      updated_at = NOW()`,
            [
                data.ticker, data.price, data.market_cap, data.pe_ratio,
                data.roe_pct, data.debt_to_equity, data.gross_margin_pct,
                data.dividend_yield_pct, data.roa_pct, data.total_revenue,
                data.revenue_per_employee, data.sector, data.industry,
                data.company_name, data.fifty_two_week_high,
                data.fifty_two_week_low, data.beta,
            ]
        );
    });
}

// Fetch all cached screener data
export async function getScreenerData(): Promise<any[]> {
    if (useInMemory) {
        if (!allowInMemoryFallback()) {
            throw new Error('[DB] getScreenerData: in-memory mode is not allowed in production');
        }
        return inMemoryCache.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));
    }

    return withDbRetry('getScreenerData', async () => {
        const db = getPool();
        const result = await db.query(
            `SELECT * FROM screener_cache ORDER BY market_cap DESC NULLS LAST`
        );
        return result.rows;
    });
}

// Fetch cached data for a specific ticker
export async function getScreenerTicker(ticker: string): Promise<any> {
    if (useInMemory) {
        if (!allowInMemoryFallback()) {
            throw new Error('[DB] getScreenerTicker: in-memory mode is not allowed in production');
        }
        return inMemoryCache.find(t => t.ticker === ticker) || null;
    }
    return withDbRetry('getScreenerTicker', async () => {
        const db = getPool();
        const result = await db.query(`SELECT * FROM screener_cache WHERE ticker = $1`, [ticker]);
        return result.rows[0] || null;
    });
}

// Get scan metadata
export async function getScanMetadata(): Promise<{ count: number; lastUpdated: string | null }> {
    if (useInMemory) {
        if (!allowInMemoryFallback()) {
            throw new Error('[DB] getScanMetadata: in-memory mode is not allowed in production');
        }
        const lastUpdated = inMemoryCache.length > 0
            ? inMemoryCache.reduce((latest, row) =>
                new Date(row.updated_at) > new Date(latest) ? row.updated_at : latest,
                inMemoryCache[0].updated_at)
            : null;

        return {
            count: inMemoryCache.length,
            lastUpdated,
        };
    }

    return withDbRetry('getScanMetadata', async () => {
        const db = getPool();
        const result = await db.query(
            `SELECT COUNT(*) as count, MAX(updated_at) as last_updated FROM screener_cache`
        );
        return {
            count: parseInt(result.rows[0]?.count || '0'),
            lastUpdated: result.rows[0]?.last_updated || null,
        };
    });
}

// Update monitored prospects (replace old list)
export async function updateMonitoredProspects(prospects: { ticker: string; score: number }[]): Promise<void> {
    if (useInMemory) return;

    const db = getPool();
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM monitored_prospects');
        for (const p of prospects) {
            await client.query(
                `INSERT INTO monitored_prospects (ticker, score, added_at) VALUES ($1, $2, NOW())`,
                [p.ticker, p.score]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[DB] Failed to update prospects:', e);
    } finally {
        client.release();
    }
}

// Get monitored prospects
export async function getMonitoredProspects(): Promise<{ ticker: string; score: number }[]> {
    if (useInMemory) return [];

    try {
        return await withDbRetry('getMonitoredProspects', async () => {
            const db = getPool();
            const res = await db.query(`SELECT ticker, score FROM monitored_prospects ORDER BY score DESC`);
            return res.rows;
        });
    } catch (e) {
        console.error('[DB] Failed to get prospects:', e);
        return [];
    }
}

// trading_analysis_results, trading_cycle_log, getCycleLogs moved to portfolio-db (Turso)
