
import { getPool } from './db';

// Portfolio Status Interface
export interface PortfolioStatus {
    id?: number;
    cash_balance: number;
    total_equity: number;
    total_value: number;
    last_updated: string;
}

// Portfolio Holding Interface
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

// Portfolio Transaction Interface
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

// Portfolio History Interface (for charts)
export interface PortfolioHistory {
    date: string;
    total_value: number;
    cash_balance: number;
    equity_value: number;
    day_change_pct: number;
}

/**
 * Initialize Portfolio Tables
 * Creates the necessary tables if they don't exist.
 */
export async function initPortfolioTables(): Promise<void> {
    const db = getPool();

    try {
        // 1. Portfolio Status Table
        await db.query(`
      CREATE TABLE IF NOT EXISTS portfolio_status (
        id SERIAL PRIMARY KEY,
        cash_balance REAL NOT NULL DEFAULT 100000.0,
        total_equity REAL NOT NULL DEFAULT 0.0,
        total_value REAL NOT NULL DEFAULT 100000.0,
        last_updated TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // Ensure we have at least one row for the global portfolio state
        const statusCheck = await db.query('SELECT count(*) FROM portfolio_status');
        if (parseInt(statusCheck.rows[0].count) === 0) {
            await db.query(`
        INSERT INTO portfolio_status (cash_balance, total_equity, total_value)
        VALUES (100000.0, 0.0, 100000.0)
      `);
            console.log('Initialized portfolio_status with $100k start.');
        }

        // 2. Portfolio Holdings Table
        await db.query(`
      CREATE TABLE IF NOT EXISTS portfolio_holdings (
        ticker VARCHAR(10) PRIMARY KEY,
        shares REAL NOT NULL,
        avg_cost REAL NOT NULL,
        current_price REAL,
        market_value REAL,
        return_pct REAL,
        last_updated TIMESTAMPTZ DEFAULT NOW(),
        opened_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // 3. Portfolio Transactions Table
        await db.query(`
      CREATE TABLE IF NOT EXISTS portfolio_transactions (
        id SERIAL PRIMARY KEY,
        date TIMESTAMPTZ DEFAULT NOW(),
        ticker VARCHAR(10) NOT NULL,
        type VARCHAR(10) NOT NULL, CHECK (type IN ('BUY', 'SELL')),
        shares REAL NOT NULL,
        price REAL NOT NULL,
        total_amount REAL NOT NULL,
        notes TEXT
      );
    `);

        // 4. Portfolio History Table (Daily Snapshots)
        await db.query(`
      CREATE TABLE IF NOT EXISTS portfolio_history (
        date DATE PRIMARY KEY DEFAULT CURRENT_DATE,
        total_value REAL NOT NULL,
        cash_balance REAL NOT NULL,
        equity_value REAL NOT NULL,
        day_change_pct REAL
      );
    `);

        console.log('Portfolio tables initialized successfully.');
    } catch (error) {
        console.error('Failed to initialize portfolio tables:', error);
        throw error;
    }
}

/**
 * Get Current Portfolio Status
 */
export async function getPortfolioStatus(): Promise<PortfolioStatus> {
    const db = getPool();
    const res = await db.query('SELECT * FROM portfolio_status ORDER BY id DESC LIMIT 1');
    return res.rows[0];
}

/**
 * Update Portfolio Status
 */
export async function updatePortfolioStatus(cash: number, equity: number): Promise<void> {
    const db = getPool();
    const total = cash + equity;
    await db.query(`
    UPDATE portfolio_status 
    SET cash_balance = $1, total_equity = $2, total_value = $3, last_updated = NOW()
    WHERE id = (SELECT id FROM portfolio_status ORDER BY id DESC LIMIT 1)
  `, [cash, equity, total]);
}

/**
 * Get All Holdings
 */
export async function getHoldings(): Promise<PortfolioHolding[]> {
    const db = getPool();
    const res = await db.query('SELECT * FROM portfolio_holdings ORDER BY market_value DESC');
    return res.rows;
}

/**
 * Get All Recent Transactions
 */
export async function getTransactions(limit = 50): Promise<PortfolioTransaction[]> {
    const db = getPool();
    const res = await db.query('SELECT * FROM portfolio_transactions ORDER BY date DESC LIMIT $1', [limit]);
    return res.rows;
}

/**
 * Get History for Charts
 */
export async function getHistory(days = 30): Promise<PortfolioHistory[]> {
    const db = getPool();
    const res = await db.query('SELECT * FROM portfolio_history ORDER BY date ASC LIMIT $1', [days]);
    return res.rows;
}

/**
 * Record a Transaction & Update Holdings
 */
export async function executeTrade(
    ticker: string,
    type: 'BUY' | 'SELL',
    shares: number,
    price: number,
    notes?: string
): Promise<void> {
    const db = getPool();
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const totalAmount = shares * price;

        // 1. Log Transaction
        await client.query(`
      INSERT INTO portfolio_transactions (ticker, type, shares, price, total_amount, notes, date)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [ticker, type, shares, price, totalAmount, notes]);

        // 2. Update Holdings
        if (type === 'BUY') {
            // Upsert: Add shares, re-calculate avg_cost
            const existing = await client.query('SELECT * FROM portfolio_holdings WHERE ticker = $1', [ticker]);

            if (existing.rows.length > 0) {
                const h = existing.rows[0];
                const newShares = h.shares + shares;
                const newCost = ((h.shares * h.avg_cost) + totalAmount) / newShares;

                await client.query(`
          UPDATE portfolio_holdings 
          SET shares = $1, avg_cost = $2, current_price = $3, market_value = $4, last_updated = NOW()
          WHERE ticker = $5
        `, [
                    newShares,
                    newCost,
                    price,
                    newShares * price,
                    ticker
                ]);
            } else {
                await client.query(`
          INSERT INTO portfolio_holdings (ticker, shares, avg_cost, current_price, market_value, opened_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
        `, [ticker, shares, price, price, totalAmount]);
            }
        } else {
            // SELL: Reduce shares
            const existing = await client.query('SELECT * FROM portfolio_holdings WHERE ticker = $1', [ticker]);
            if (existing.rows.length === 0) throw new Error(`Cannot sell ${ticker}, not in portfolio.`);

            const h = existing.rows[0];
            const newShares = h.shares - shares;

            if (newShares <= 0.0001) {
                // Sold out
                await client.query('DELETE FROM portfolio_holdings WHERE ticker = $1', [ticker]);
            } else {
                await client.query(`
          UPDATE portfolio_holdings 
          SET shares = $1, current_price = $2, market_value = $3, last_updated = NOW()
          WHERE ticker = $4
        `, [newShares, price, newShares * price, ticker]);
            }
        }

        // 3. Update Global Status will be handled by the caller after all trades

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
