#!/usr/bin/env node
// Standalone screener scanner - runs outside Next.js
// Usage: node scripts/scan.js [subset_count]
// Uses chart endpoint first (no auth needed), then enriches with fundamentals

const https = require('https');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DATA_FILE = path.join(__dirname, '..', 'data', 'screener_cache.json');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: { 'User-Agent': UA, ...headers },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, headers: res.headers, body });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
    });
}

// =========== Cookie/Crumb auth ===========
let cookies = '';
let crumb = '';
let crumbFailed = false;

async function refreshCrumb() {
    if (crumbFailed) return false;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const initRes = await httpsGet('https://fc.yahoo.com/');
            const setCookie = initRes.headers['set-cookie'];
            if (setCookie) {
                const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
                cookies = arr.map(c => c.split(';')[0]).join('; ');
            }

            const crumbRes = await httpsGet('https://query2.finance.yahoo.com/v1/test/getcrumb', { Cookie: cookies });
            if (crumbRes.statusCode === 429) {
                if (attempt === 3) {
                    console.log('  ⚠ Crumb rate limited, will use chart-only mode');
                    crumbFailed = true;
                    return false;
                }
                await sleep(attempt * 3000);
                continue;
            }
            if (crumbRes.statusCode === 200) {
                crumb = crumbRes.body;
                return true;
            }
            throw new Error(`Crumb status: ${crumbRes.statusCode}`);
        } catch (err) {
            if (attempt === 3) { crumbFailed = true; return false; }
            await sleep(attempt * 2000);
        }
    }
    return false;
}

async function yahooGet(url) {
    if (crumbFailed || !crumb) {
        const ok = await refreshCrumb();
        if (!ok) return null;
    }
    const sep = url.includes('?') ? '&' : '?';
    const fullUrl = `${url}${sep}crumb=${encodeURIComponent(crumb)}`;
    const res = await httpsGet(fullUrl, { Cookie: cookies });
    if (res.statusCode === 200) return JSON.parse(res.body);
    if (res.statusCode === 429) {
        crumbFailed = true;
        return null;
    }
    return null;
}

// =========== Load tickers ===========
function loadTickers() {
    const csvPath = path.join(__dirname, '..', 'python-service', 'vanguard.csv');
    const content = fs.readFileSync(csvPath, 'utf-8');
    const tickers = content.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0 && /^[A-Z]+$/.test(l) && !l.includes('/'));
    return [...new Set(tickers)].sort();
}

// =========== Chart endpoint (no auth, always works) ===========
async function getChartQuote(ticker) {
    try {
        const res = await httpsGet(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`);
        if (res.statusCode !== 200) return null;
        const data = JSON.parse(res.body);
        const meta = data.chart?.result?.[0]?.meta;
        if (!meta) return null;
        return {
            symbol: meta.symbol || ticker,
            price: meta.regularMarketPrice,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
            volume: meta.regularMarketVolume,
            shortName: meta.shortName || ticker,
            longName: meta.longName || ticker,
        };
    } catch { return null; }
}

// =========== Main scan ===========
async function main() {
    const subsetArg = process.argv[2];
    const allTickers = loadTickers();
    const tickers = subsetArg ? allTickers.slice(0, parseInt(subsetArg)) : allTickers;

    console.log(`\n🔍 TickSignals Scanner`);
    console.log(`   ${tickers.length} tickers to scan (${allTickers.length} total in CSV)\n`);

    const startTime = Date.now();
    const stocks = [];

    // ===== Phase 1: Chart quotes (no auth, reliable) =====
    console.log('📊 Phase 1: Fetching price data via chart endpoint...');
    const chartMap = new Map();
    const CHART_CONCURRENCY = 10;

    for (let i = 0; i < tickers.length; i += CHART_CONCURRENCY) {
        const batch = tickers.slice(i, i + CHART_CONCURRENCY);

        const results = await Promise.allSettled(batch.map(t => getChartQuote(t)));

        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
                chartMap.set(r.value.symbol, r.value);
            }
        }

        if ((i + CHART_CONCURRENCY) % 100 === 0 || i + CHART_CONCURRENCY >= tickers.length) {
            console.log(`  Progress: ${Math.min(i + CHART_CONCURRENCY, tickers.length)}/${tickers.length} — ${chartMap.size} valid`);
        }

        if (i + CHART_CONCURRENCY < tickers.length) await sleep(100);
    }

    console.log(`\n   ✓ Got ${chartMap.size} price quotes\n`);

    // ===== Phase 2: Try batch quotes for market cap + P/E (may fail if rate limited) =====
    const validTickers = Array.from(chartMap.keys());
    const quoteMap = new Map();

    const crumbOk = await refreshCrumb();
    if (crumbOk) {
        console.log('📈 Phase 2: Enriching with market cap, P/E via batch quotes...');
        const BATCH_SIZE = 50;

        for (let i = 0; i < validTickers.length; i += BATCH_SIZE) {
            if (crumbFailed) break;

            const batch = validTickers.slice(i, i + BATCH_SIZE);
            try {
                const data = await yahooGet(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${batch.join(',')}`);
                if (data) {
                    const results = data.quoteResponse?.result || [];
                    for (const q of results) quoteMap.set(q.symbol, q);
                }
            } catch { }

            if (i + BATCH_SIZE < validTickers.length) await sleep(200);
        }
        console.log(`   ✓ Got ${quoteMap.size} enriched quotes\n`);
    } else {
        console.log('⏭  Skipping batch quotes (rate limited), using chart data only\n');
    }

    // ===== Phase 3: Fundamentals via quoteSummary (may fail if rate limited) =====
    console.log('🔬 Phase 3: Fetching fundamentals...');
    const FUND_BATCH = 5;
    let fundCount = 0;
    let fundSkipped = 0;

    for (let i = 0; i < validTickers.length; i += FUND_BATCH) {
        const batch = validTickers.slice(i, i + FUND_BATCH);

        const fundResults = await Promise.allSettled(
            batch.map(async (ticker) => {
                if (crumbFailed) return null;
                return yahooGet(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData,summaryDetail,assetProfile`);
            })
        );

        for (let j = 0; j < batch.length; j++) {
            const ticker = batch[j];
            const chart = chartMap.get(ticker);
            const quote = quoteMap.get(ticker);
            const fundResult = fundResults[j];
            const fundData = fundResult.status === 'fulfilled' ? fundResult.value : null;
            const fund = fundData?.quoteSummary?.result?.[0];

            const fin = fund?.financialData || {};
            const det = fund?.summaryDetail || {};
            const prof = fund?.assetProfile || {};

            if (fund) fundCount++;
            else fundSkipped++;

            const totalRevenue = fin.totalRevenue?.raw || null;
            const employees = prof.fullTimeEmployees || null;

            stocks.push({
                ticker,
                price: chart?.price || quote?.regularMarketPrice || null,
                market_cap: quote?.marketCap || null,
                pe_ratio: quote?.trailingPE || det?.trailingPE?.raw || null,
                roe_pct: fin.returnOnEquity?.raw != null ? fin.returnOnEquity.raw * 100 : null,
                debt_to_equity: fin.debtToEquity?.raw || null,
                gross_margin_pct: fin.grossMargins?.raw != null ? fin.grossMargins.raw * 100 : null,
                dividend_yield_pct: det.dividendYield?.raw != null ? det.dividendYield.raw * 100 : null,
                roa_pct: fin.returnOnAssets?.raw != null ? fin.returnOnAssets.raw * 100 : null,
                total_revenue: totalRevenue,
                revenue_per_employee: (totalRevenue && employees && employees > 0) ? totalRevenue / employees : null,
                sector: prof.sector || null,
                industry: prof.industry || null,
                company_name: chart?.shortName || chart?.longName || quote?.shortName || quote?.longName || ticker,
                fifty_two_week_high: chart?.fiftyTwoWeekHigh || quote?.fiftyTwoWeekHigh || null,
                fifty_two_week_low: chart?.fiftyTwoWeekLow || quote?.fiftyTwoWeekLow || null,
                beta: det.beta?.raw || null,
                updated_at: new Date().toISOString(),
            });
        }

        if ((i + FUND_BATCH) % 100 === 0 || i + FUND_BATCH >= validTickers.length) {
            console.log(`  Progress: ${Math.min(i + FUND_BATCH, validTickers.length)}/${validTickers.length} — ${fundCount} with fundamentals`);
        }

        if (i + FUND_BATCH < validTickers.length) await sleep(150);
    }

    // Save to JSON file
    const output = {
        stocks: stocks.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0)),
        totalStocks: stocks.length,
        lastUpdated: new Date().toISOString(),
        scanDuration: ((Date.now() - startTime) / 1000).toFixed(1),
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(output));

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Scan complete!`);
    console.log(`   ${stocks.length} stocks saved (${fundCount} with fundamentals, ${fundSkipped} chart-only)`);
    console.log(`   Duration: ${duration}s`);
    console.log(`   Output: ${DATA_FILE}\n`);
}

main().catch(err => {
    console.error('❌ Scan failed:', err.message);
    process.exit(1);
});
