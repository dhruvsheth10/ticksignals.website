import { Pool } from 'pg';

// Shared Neon PostgreSQL pool
let pool: Pool | null = null;

export function getPool(): Pool {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.NEON_DATABASE_URL,
            max: 5,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
            ssl: { rejectUnauthorized: false },
        });
    }
    return pool;
}

// Initialize screener_cache table if it doesn't exist
export async function initScreenerTable(): Promise<void> {
    const db = getPool();
    await db.query(`
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
  `);
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
}

// Fetch all cached screener data
export async function getScreenerData(): Promise<any[]> {
    const db = getPool();
    const result = await db.query(
        `SELECT * FROM screener_cache ORDER BY market_cap DESC NULLS LAST`
    );
    return result.rows;
}

// Get scan metadata
export async function getScanMetadata(): Promise<{ count: number; lastUpdated: string | null }> {
    const db = getPool();
    const result = await db.query(
        `SELECT COUNT(*) as count, MAX(updated_at) as last_updated FROM screener_cache`
    );
    return {
        count: parseInt(result.rows[0]?.count || '0'),
        lastUpdated: result.rows[0]?.last_updated || null,
    };
}
