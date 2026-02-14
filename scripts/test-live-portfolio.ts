
// scripts/test-live-portfolio.ts
// Usages: npx ts-node -O '{"module":"commonjs"}' scripts/test-live-portfolio.ts

require('dotenv').config({ path: '.env.local' });
const { initPortfolioTables, getPortfolioStatus } = require('../lib/portfolio-db');
const { runTradingCycle } = require('../lib/trading-engine');

async function main() {
    console.log('--- Starting Live Portfolio Verification ---');

    try {
        // 1. Initialize Tables
        console.log('1. Initializing Tables...');
        await initPortfolioTables();

        // Check initial status
        const status = await getPortfolioStatus();
        console.log('Initial Status:', status);

        // 2. Run Trading Cycle (OPEN)
        console.log('\n2. Running OPEN Trading Cycle...');
        // Note: runTradingCycle is async
        await runTradingCycle('OPEN');

        // 3. Verify Result
        const newStatus = await getPortfolioStatus();
        console.log('\nFinal Status:', newStatus);

        if (newStatus.last_updated !== status.last_updated) {
            console.log('✅ Portfolio Updated Successfully');
        } else {
            console.log('ℹ️ Portfolio state unchanged (might be expected if no trades found or market closed logic applied)');
        }

    } catch (e) {
        console.error('❌ Verification Failed:', e);
    } finally {
        process.exit(0);
    }
}

main();
