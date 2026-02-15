#!/usr/bin/env node

/**
 * Oracle Cloud Trading Analysis Service
 * Analyzes all Vanguard stocks and stores results in database
 * 
 * Run times: 6:30 AM, 9:00 AM, 12:00 PM PST
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeTicker } from './analyzer';
import { initAnalysisTable, saveAnalysisResult, getPool } from './db';
import { ResourceMonitor } from './resource-monitor';

dotenv.config();

// Load tickers from vanguard.csv
function loadTickers(): string[] {
    // Try multiple possible locations
    const possiblePaths = [
        path.join(__dirname, '../vanguard.csv'),
        path.join(process.cwd(), 'vanguard.csv'),
        path.join(__dirname, '../../python-service/vanguard.csv')
    ];
    
    let csvPath = possiblePaths.find(p => fs.existsSync(p));
    
    if (!csvPath) {
        csvPath = possiblePaths[0]; // Use first as default for error message
    
    if (!csvPath || !fs.existsSync(csvPath)) {
        console.error(`[Error] vanguard.csv not found. Tried:`);
        possiblePaths.forEach(p => console.error(`  - ${p}`));
        process.exit(1);
    }
    
    console.log(`[Info] Using vanguard.csv from: ${csvPath}`);

    const content = fs.readFileSync(csvPath, 'utf-8');
    const tickers = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .filter(ticker => {
            // Filter out invalid ticker symbols
            return !ticker.includes('/') && /^[A-Z]+$/.test(ticker);
        });

    return [...new Set(tickers)].sort();
}

// Sleep helper
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('🚀 Oracle Cloud Trading Analysis Service');
    console.log('========================================\n');

    // Initialize resource monitor
    const monitor = new ResourceMonitor();
    await monitor.printStats();

    // Check if we should continue
    const shouldContinue = await monitor.shouldContinue();
    if (!shouldContinue.continue) {
        console.error(`\n❌ Cannot start: ${shouldContinue.reason}`);
        process.exit(1);
    }

    // Initialize database
    try {
        console.log('\n📊 Initializing database...');
        await initAnalysisTable();
        console.log('✅ Database initialized');
    } catch (error: any) {
        console.error('❌ Database initialization failed:', error.message);
        process.exit(1);
    }

    // Load tickers
    console.log('\n📋 Loading tickers from vanguard.csv...');
    const tickers = loadTickers();
    console.log(`✅ Loaded ${tickers.length} tickers\n`);

    // Configuration
    const BATCH_SIZE = 10; // Process 10 stocks at a time
    const DELAY_BETWEEN_BATCHES = 3000; // 3 seconds between batches
    const DELAY_BETWEEN_STOCKS = 200; // 200ms between individual stocks
    const MAX_RETRIES = 3;

    let processed = 0;
    let successful = 0;
    let failed = 0;
    let buySignals = 0;
    let sellSignals = 0;
    let holdSignals = 0;

    const startTime = Date.now();

    console.log(`🔄 Starting analysis of ${tickers.length} stocks...`);
    console.log(`   Batch size: ${BATCH_SIZE}`);
    console.log(`   Delay between batches: ${DELAY_BETWEEN_BATCHES}ms\n`);

    // Process in batches
    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
        // Check resources before each batch
        const resourceCheck = await monitor.shouldContinue();
        if (!resourceCheck.continue) {
            console.error(`\n⚠️  Stopping due to resource limit: ${resourceCheck.reason}`);
            break;
        }

        const batch = tickers.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(tickers.length / BATCH_SIZE);

        console.log(`\n📦 Batch ${batchNum}/${totalBatches} (${batch.length} stocks)`);

        // Process batch in parallel (with rate limiting)
        const batchPromises = batch.map(async (ticker, idx) => {
            // Stagger requests slightly
            await sleep(idx * DELAY_BETWEEN_STOCKS);

            let retries = 0;
            while (retries < MAX_RETRIES) {
                try {
                    const signal = await analyzeTicker(ticker);
                    
                    // Save to database
                    await saveAnalysisResult({
                        ticker: signal.ticker,
                        action: signal.action,
                        confidence: signal.confidence,
                        reason: signal.reason,
                        sentimentScore: signal.sentimentBoost ? signal.sentimentBoost / 10 : undefined,
                        sentimentConfidence: signal.sentimentBoost ? Math.abs(signal.sentimentBoost) / 10 : undefined,
                        rsi: signal.indicators?.rsi,
                        macdHistogram: signal.indicators?.macdHistogram,
                        volumeRatio: signal.indicators?.volumeRatio,
                        priceChangePct: signal.indicators?.priceChangePct,
                        sma50: signal.indicators?.sma50,
                        sma200: signal.indicators?.sma200
                    });

                    // Count signals
                    if (signal.action === 'BUY') buySignals++;
                    else if (signal.action === 'SELL') sellSignals++;
                    else holdSignals++;

                    successful++;
                    processed++;

                    // Log significant signals
                    if (signal.confidence >= 75) {
                        console.log(`   ✅ ${ticker}: ${signal.action} (${signal.confidence}%) - ${signal.reason.substring(0, 50)}`);
                    }

                    return { success: true, ticker };
                } catch (error: any) {
                    retries++;
                    if (retries >= MAX_RETRIES) {
                        console.error(`   ❌ ${ticker}: Failed after ${MAX_RETRIES} retries - ${error.message}`);
                        failed++;
                        processed++;
                        return { success: false, ticker, error: error.message };
                    }
                    // Exponential backoff
                    await sleep(1000 * Math.pow(2, retries));
                }
            }
            return { success: false, ticker };
        });

        await Promise.allSettled(batchPromises);

        // Print progress
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = processed / elapsed;
        const remaining = tickers.length - processed;
        const eta = remaining / rate;

        console.log(`   Progress: ${processed}/${tickers.length} (${((processed / tickers.length) * 100).toFixed(1)}%)`);
        console.log(`   ETA: ${(eta / 60).toFixed(1)} minutes`);
        console.log(`   Signals: ${buySignals} BUY, ${sellSignals} SELL, ${holdSignals} HOLD`);

        // Print resource stats every 10 batches
        if (batchNum % 10 === 0) {
            await monitor.printStats();
        }

        // Delay between batches (except for last batch)
        if (i + BATCH_SIZE < tickers.length) {
            await sleep(DELAY_BETWEEN_BATCHES);
        }
    }

    // Final summary
    const totalTime = (Date.now() - startTime) / 1000;
    const minutes = Math.floor(totalTime / 60);
    const seconds = Math.floor(totalTime % 60);

    console.log('\n' + '='.repeat(50));
    console.log('✅ Analysis Complete!');
    console.log('='.repeat(50));
    console.log(`Total time: ${minutes}m ${seconds}s`);
    console.log(`Processed: ${processed}/${tickers.length}`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${failed}`);
    console.log(`\nSignals:`);
    console.log(`  BUY:  ${buySignals}`);
    console.log(`  SELL: ${sellSignals}`);
    console.log(`  HOLD: ${holdSignals}`);

    await monitor.printStats();

    // Close database connection
    const pool = getPool();
    await pool.end();

    console.log('\n✅ Service completed successfully');
    process.exit(0);
}

// Handle errors
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
    process.exit(1);
});

process.on('SIGINT', async () => {
    console.log('\n\n⚠️  Received SIGINT, shutting down gracefully...');
    const pool = getPool();
    await pool.end();
    process.exit(0);
});

// Run main
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});

