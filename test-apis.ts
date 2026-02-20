import { MarketDataService } from './lib/market-data';
import * as dotenv from 'dotenv';
dotenv.config(); // Load variables from .env locally

async function testApis() {
    console.log("---- Testing Massive.com (FMP) API ----");
    const fins = await MarketDataService.getDeepFinancials('AAPL');
    if (fins && fins.financials && fins.financials.income_statement) {
        const netIncomeNode = fins.financials.income_statement.net_income_loss;
        const netIncome = netIncomeNode ? netIncomeNode.value : null;
        console.log("✅ Massive API Success!");
        console.log(`Apple (AAPL) Net Income: $${Number(netIncome).toLocaleString()}`);
    } else {
        console.log("❌ Massive API Failed to return expected data.");
        console.log("Raw Response:", fins);
    }

    console.log("\n---- Testing FRED API ----");
    if (!process.env.FRED_API_KEY) {
        console.log("⚠️ FRED_API_KEY is not set in your .env file!");
        console.log("To test FRED, add FRED_API_KEY=your_key_here to .env");
    }
    const macro = await MarketDataService.getMacroTrend();
    console.log("FRED Result:", macro);
}

testApis();
