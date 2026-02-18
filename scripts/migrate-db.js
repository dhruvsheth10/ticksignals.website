
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: '.env.local' });

async function migrate() {
    const connectionString = process.env.NEON_DATABASE_URL;
    if (!connectionString) {
        console.error('NEON_DATABASE_URL is not defined in .env.local');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false }
    });

    console.log('Migrating portfolio_holdings...');
    try {
        await pool.query(`
            ALTER TABLE portfolio_holdings 
            ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ DEFAULT NOW();
        `);
        console.log('Migration successful: added opened_at column.');
        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        await pool.end();
        process.exit(1);
    }
}

migrate();
