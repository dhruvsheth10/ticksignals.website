// Raw Yahoo Finance API client with cookie/crumb auth
// Uses Node.js https module to avoid Next.js fetch patching issues
import https from 'https';

let cachedCookies: string = '';
let cachedCrumb: string = '';
let crumbExpiry: number = 0;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Sleep helper
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Low-level HTTPS GET that returns { statusCode, headers, body }
function httpsGet(url: string, headers: Record<string, string> = {}): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: { 'User-Agent': UA, ...headers },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    body,
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error('Request timed out'));
        });
    });
}

// Get fresh cookies + crumb from Yahoo Finance with retry
async function refreshCrumb(retries: number = 3): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            // Step 1: Get cookies from fc.yahoo.com
            const initRes = await httpsGet('https://fc.yahoo.com/');
            const rawCookies = initRes.headers['set-cookie'];
            if (rawCookies) {
                const cookieArray = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
                cachedCookies = cookieArray.map(c => c.split(';')[0]).join('; ');
            }

            if (!cachedCookies) {
                throw new Error('No cookies received from Yahoo');
            }

            // Step 2: Get crumb using cookies
            const crumbRes = await httpsGet(
                'https://query2.finance.yahoo.com/v1/test/getcrumb',
                { 'Cookie': cachedCookies }
            );

            if (crumbRes.statusCode === 429) {
                const waitTime = attempt * 5000;
                console.warn(`[Yahoo] Rate limited on crumb (attempt ${attempt}/${retries}), waiting ${waitTime / 1000}s...`);
                await sleep(waitTime);
                continue;
            }

            if (crumbRes.statusCode !== 200) {
                throw new Error(`Failed to get crumb: ${crumbRes.statusCode}`);
            }

            cachedCrumb = crumbRes.body;
            crumbExpiry = Date.now() + 25 * 60 * 1000; // 25 minutes
            console.log('[Yahoo] Crumb refreshed successfully');
            return;
        } catch (err: any) {
            if (attempt === retries) {
                throw new Error(`Failed to get crumb after ${retries} attempts: ${err.message}`);
            }
            console.warn(`[Yahoo] Crumb attempt ${attempt} failed: ${err.message}, retrying...`);
            await sleep(attempt * 3000);
        }
    }
}

// Ensure we have a valid crumb
async function ensureCrumb(): Promise<void> {
    if (!cachedCrumb || Date.now() > crumbExpiry) {
        await refreshCrumb();
    }
}

// Make an authenticated Yahoo Finance API request with retry
async function yahooFetch(url: string, retries: number = 2): Promise<any> {
    await ensureCrumb();

    for (let attempt = 1; attempt <= retries; attempt++) {
        const separator = url.includes('?') ? '&' : '?';
        const fullUrl = `${url}${separator}crumb=${encodeURIComponent(cachedCrumb)}`;

        const res = await httpsGet(fullUrl, { 'Cookie': cachedCookies });

        if (res.statusCode === 429) {
            const waitTime = attempt * 3000;
            console.warn(`[Yahoo] Rate limited (attempt ${attempt}), waiting ${waitTime / 1000}s...`);
            await sleep(waitTime);
            continue;
        }

        if (res.statusCode === 401 || res.statusCode === 403) {
            console.warn('[Yahoo] Auth expired, refreshing crumb...');
            await refreshCrumb();
            continue;
        }

        if (res.statusCode !== 200) {
            throw new Error(`Yahoo API error: ${res.statusCode}`);
        }

        return JSON.parse(res.body);
    }

    throw new Error(`Yahoo API failed after ${retries} retries`);
}

// Batch quote: fetch up to 50 symbols at once
export interface YahooQuote {
    symbol: string;
    regularMarketPrice: number;
    marketCap: number;
    trailingPE: number | undefined;
    fiftyTwoWeekHigh: number;
    fiftyTwoWeekLow: number;
    shortName: string;
    longName: string;
    dividendYield: number | undefined;
    regularMarketVolume: number | undefined;
}

export async function batchQuote(symbols: string[]): Promise<YahooQuote[]> {
    const symbolStr = symbols.join(',');
    const data = await yahooFetch(
        `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbolStr}`
    );
    return data.quoteResponse?.result || [];
}

// Fallback: use the chart endpoint which doesn't need auth
export interface ChartQuote {
    symbol: string;
    regularMarketPrice: number;
    fiftyTwoWeekHigh: number;
    fiftyTwoWeekLow: number;
    regularMarketVolume: number;
    shortName: string;
    longName: string;
}

export async function chartQuote(symbol: string): Promise<ChartQuote | null> {
    try {
        const res = await httpsGet(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`
        );

        if (res.statusCode !== 200) {
            if (res.statusCode === 429) {
                console.warn(`[Yahoo] Chart ${symbol}: rate limited`);
            }
            return null;
        }

        const data = JSON.parse(res.body);
        const meta = data.chart?.result?.[0]?.meta;
        if (!meta) return null;

        return {
            symbol: meta.symbol,
            regularMarketPrice: meta.regularMarketPrice,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
            regularMarketVolume: meta.regularMarketVolume,
            shortName: meta.shortName || symbol,
            longName: meta.longName || symbol,
        };
    } catch (err: any) {
        console.error(`[Yahoo] Chart ${symbol} error:`, err.message);
        return null;
    }
}

// Batch chart quotes (using parallel requests, no auth needed)
export async function batchChartQuotes(symbols: string[], concurrency: number = 10): Promise<ChartQuote[]> {
    const results: ChartQuote[] = [];
    console.log(`[Yahoo] Chart fallback: fetching ${symbols.length} symbols (${concurrency} concurrent)...`);

    for (let i = 0; i < symbols.length; i += concurrency) {
        const batch = symbols.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(
            batch.map(s => chartQuote(s))
        );

        for (const r of batchResults) {
            if (r.status === 'fulfilled' && r.value) {
                results.push(r.value);
            }
        }

        if (i === 0 && results.length > 0) {
            console.log(`[Yahoo] Chart first batch: ${results.length}/${batch.length} succeeded`);
        }

        if (i + concurrency < symbols.length) {
            await sleep(100);
        }
    }

    console.log(`[Yahoo] Chart fallback complete: ${results.length}/${symbols.length} quotes`);
    return results;
}

// QuoteSummary: get detailed fundamentals for a single ticker
export interface YahooFundamentals {
    returnOnEquity: number | null;
    returnOnAssets: number | null;
    debtToEquity: number | null;
    grossMargins: number | null;
    totalRevenue: number | null;
    fullTimeEmployees: number | null;
    sector: string | null;
    industry: string | null;
    dividendYield: number | null;
    beta: number | null;
}

export async function getQuoteSummary(ticker: string): Promise<YahooFundamentals | null> {
    try {
        const data = await yahooFetch(
            `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData,summaryDetail,assetProfile`
        );

        const result = data.quoteSummary?.result?.[0];
        if (!result) return null;

        const fin = result.financialData || {};
        const det = result.summaryDetail || {};
        const prof = result.assetProfile || {};

        return {
            returnOnEquity: fin.returnOnEquity?.raw ?? null,
            returnOnAssets: fin.returnOnAssets?.raw ?? null,
            debtToEquity: fin.debtToEquity?.raw ?? null,
            grossMargins: fin.grossMargins?.raw ?? null,
            totalRevenue: fin.totalRevenue?.raw ?? null,
            fullTimeEmployees: prof.fullTimeEmployees ?? null,
            sector: prof.sector || null,
            industry: prof.industry || null,
            dividendYield: det.dividendYield?.raw ?? null,
            beta: det.beta?.raw ?? null,
        };
    } catch (err) {
        console.error(`[Yahoo] Failed to get summary for ${ticker}:`, (err as Error).message);
        return null;
    }
}
