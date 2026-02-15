/**
 * Database connection for Oracle Cloud service
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

let pool: Pool | null = null;

export function getPool(): Pool {
    if (!pool) {
        const connectionString = process.env.NEON_DATABASE_URL;
        if (!connectionString) {
            throw new Error('NEON_DATABASE_URL environment variable is required');
        }

        pool = new Pool({
            connectionString,
            max: 5,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });

        pool.on('error', (err) => {
            console.error('Unexpected database error:', err);
        });
    }
    return pool;
}

/**
 * Initialize analysis results table
 */
export async function initAnalysisTable(): Promise<void> {
    const db = getPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS trading_analysis_results (
            id SERIAL PRIMARY KEY,
            ticker VARCHAR(10) NOT NULL,
            action VARCHAR(10) NOT NULL CHECK (action IN ('BUY', 'SELL', 'HOLD')),
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
            analyzed_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(ticker, analyzed_at)
        );
        
        CREATE INDEX IF NOT EXISTS idx_ticker_analyzed ON trading_analysis_results(ticker, analyzed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_action_confidence ON trading_analysis_results(action, confidence DESC);
    `);
}

/**
 * Save analysis result to database
 */
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
    const db = getPool();
    await db.query(`
        INSERT INTO trading_analysis_results (
            ticker, action, confidence, reason,
            sentiment_score, sentiment_confidence,
            rsi, macd_histogram, volume_ratio, price_change_pct,
            sma50, sma200, analyzed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        ON CONFLICT (ticker, analyzed_at) DO UPDATE SET
            action = EXCLUDED.action,
            confidence = EXCLUDED.confidence,
            reason = EXCLUDED.reason,
            sentiment_score = EXCLUDED.sentiment_score,
            sentiment_confidence = EXCLUDED.sentiment_confidence,
            rsi = EXCLUDED.rsi,
            macd_histogram = EXCLUDED.macd_histogram,
            volume_ratio = EXCLUDED.volume_ratio,
            price_change_pct = EXCLUDED.price_change_pct,
            sma50 = EXCLUDED.sma50,
            sma200 = EXCLUDED.sma200
    `, [
        data.ticker,
        data.action,
        data.confidence,
        data.reason,
        data.sentimentScore || null,
        data.sentimentConfidence || null,
        data.rsi || null,
        data.macdHistogram || null,
        data.volumeRatio || null,
        data.priceChangePct || null,
        data.sma50 || null,
        data.sma200 || null
    ]);
}

