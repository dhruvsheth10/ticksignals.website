
import { getPool } from '../lib/db';

async function migrate() {
    const db = getPool();
    console.log('Migrating portfolio_holdings...');
    try {
        await db.query(`
            ALTER TABLE portfolio_holdings 
            ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ DEFAULT NOW();
        `);
        console.log('Migration successful: added opened_at column.');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();
