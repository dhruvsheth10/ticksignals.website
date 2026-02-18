
const { runTradingCycle } = require('../lib/trading-engine');
const { getPool } = require('../lib/db');
const dotenv = require('dotenv');

dotenv.config({ path: '.env.local' });

// Mock Yahoo Finance to avoid network calls during test?
// Or just let it run against real data for a few tickers if we can mock the portfolio?

async function testTradingLogic() {
    console.log('Testing Trading Logic...');

    // We'll just run a cycle in 'MID' mode to test both buy and sell logic
    try {
        await runTradingCycle('MID');
        console.log('Trading cycle test completed.');
    } catch (error) {
        console.error('Trading cycle test failed:', error);
    }

    // Check recent logs or database state?
    // detailed verification would require mocking, for now we just ensuring it runs without crashing

    process.exit(0);
}

// Basic polyfill for TS-node/CommonJS interop if needed, 
// but we're running this as a standalone script.
testTradingLogic();
