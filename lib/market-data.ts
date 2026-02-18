import https from 'https';

// API Keys - In a real prod environment these should be in .env,
// but for this specific request we are embedding them as fallbacks/defaults.
const KEYS = {
    FINNHUB: 'd6b1ampr01qnr27j99q0d6b1ampr01qnr27j99qg',
    ALPHA_VANTAGE: 'CMST81YM0KF81G7P',
    EODHD: '68d8b0e042ead9.78441037',
};

// Rate Limits & Tracking
const LIMITS = {
    FINNHUB_RPM: 30, // Safe buffer (limit is 60)
    AV_DAILY: 25,
    EODHD_DAILY: 20,
};

const STATE = {
    avUsed: 0,
    eodhdUsed: 0,
    lastFinnhubCall: 0,
};

// Utils
function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Simple HTTPS GET wrapper
function httpsGet(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error(`Failed to parse JSON: ${body}`));
                    }
                } else {
                    reject(new Error(`API Error: ${res.statusCode} ${body}`));
                }
            });
        });
        req.on('error', reject);
    });
}

export interface Candle {
    date: string; // ISO or YYYY-MM-DD
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export class MarketDataService {
    // Throttled Finnhub Fetcher
    private static async fetchFinnhub(symbol: string, resolution: string, from: number, to: number): Promise<any> {
        // Simple rate limiter: ensure at least (60s / 30req) = 2000ms between calls?
        // Actually limit is 60/min = 1/sec. Let's do 1.1s spacing to be safe.
        const now = Date.now();
        const timeSinceLast = now - STATE.lastFinnhubCall;
        if (timeSinceLast < 1100) {
            await sleep(1100 - timeSinceLast);
        }
        STATE.lastFinnhubCall = Date.now();

        const url = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&token=${KEYS.FINNHUB}`;
        return httpsGet(url);
    }

    // Alpha Vantage Fetcher
    private static async fetchAlphaVantage(symbol: string): Promise<any> {
        if (STATE.avUsed >= LIMITS.AV_DAILY) throw new Error('Alpha Vantage daily limit reached');
        STATE.avUsed++;

        const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${KEYS.ALPHA_VANTAGE}`;
        return httpsGet(url);
    }

    // EODHD Fetcher
    private static async fetchEODHD(symbol: string): Promise<any> {
        if (STATE.eodhdUsed >= LIMITS.EODHD_DAILY) throw new Error('EODHD daily limit reached');
        STATE.eodhdUsed++;

        const url = `https://eodhd.com/api/eod/${symbol}.US?api_token=${KEYS.EODHD}&fmt=json`;
        return httpsGet(url);
    }

    /**
     * Get Daily Candles for Technical Analysis
     * Priority: Finnhub -> AlphaVantage -> EODHD -> (Fail)
     */
    static async getDailyCandles(ticker: string, days: number = 200): Promise<Candle[]> {
        const to = Math.floor(Date.now() / 1000);
        const from = to - (days * 86400 * 2); // Fetch extra buffer for weekends/holidays

        // 1. Try Finnhub
        try {
            const data = await this.fetchFinnhub(ticker, 'D', from, to);
            // Finnhub format: { c: [], h: [], l: [], o: [], v: [], t: [], s: 'ok' }
            if (data.s === 'ok' && data.t && data.t.length > 0) {
                return data.t.map((t: number, i: number) => ({
                    date: new Date(t * 1000).toISOString(),
                    open: data.o[i],
                    high: data.h[i],
                    low: data.l[i],
                    close: data.c[i],
                    volume: data.v[i]
                }));
            }
        } catch (e) {
            console.warn(`[MarketData] Finnhub failed for ${ticker}:`, (e as Error).message);
        }

        // 2. Try Alpha Vantage (Only if within safe limit and strictly needed)
        // Note: AV is very slow and low limit. Use as last resort.
        try {
            const data = await this.fetchAlphaVantage(ticker);
            const ts = data['Time Series (Daily)'];
            if (ts) {
                return Object.keys(ts).map(date => ({
                    date: new Date(date).toISOString(),
                    open: parseFloat(ts[date]['1. open']),
                    high: parseFloat(ts[date]['2. high']),
                    low: parseFloat(ts[date]['3. low']),
                    close: parseFloat(ts[date]['4. close']),
                    volume: parseFloat(ts[date]['5. volume'])
                })).reverse(); // AV returns newest first
            }
        } catch (e) {
            console.warn(`[MarketData] Alpha Vantage failed for ${ticker}:`, (e as Error).message);
        }

        // 3. Try EODHD
        try {
            const data = await this.fetchEODHD(ticker);
            // EODHD returns array of objects directly
            if (Array.isArray(data)) {
                return data.map((d: any) => ({
                    date: d.date,
                    open: d.open,
                    high: d.high,
                    low: d.low,
                    close: d.close,
                    volume: d.volume
                }));
            }
        } catch (e) {
            console.warn(`[MarketData] EODHD failed for ${ticker}:`, (e as Error).message);
        }

        throw new Error(`Failed to fetch daily candles for ${ticker} from all sources.`);
    }

    /**
     * Get Intraday Data + Daily Context (for Snapshot/RVOL)
     * For RVOL we need: Today's Intraday Volume (so far) + 30-day Average Daily Volume.
     */
    static async getIntradayAndRVOL(ticker: string): Promise<{
        data: {
            o: number; h: number; l: number; c: number; v: number;
            vwap: number; rvol: number;
        } | null;
        error?: string;
    }> {
        try {
            // We use Finnhub 'D' (daily) resolution to get both history and "today so far".
            // Finnhub's last candle in 'D' results is the current incomplete day candle.
            // Requesting 35 days to ensure we have 30 complete days.
            const to = Math.floor(Date.now() / 1000);
            const from = to - (35 * 86400);

            const data = await this.fetchFinnhub(ticker, 'D', from, to);

            if (data.s !== 'ok') {
                return { data: null, error: `Finnhub error: ${data.s} (check key or limits)` };
            }
            if (!data.t || data.t.length < 2) {
                return { data: null, error: `Finnhub: Insufficient data (t=${data.t?.length})` };
            }

            const len = data.t.length;
            const today = {
                o: data.o[len - 1],
                h: data.h[len - 1],
                l: data.l[len - 1],
                c: data.c[len - 1],
                v: data.v[len - 1]
            };

            // Calculate Avg Volume from previous 30 days
            // Filter out 'today' and maybe empty volume days
            const historicalVols = data.v.slice(0, len - 1).filter((v: number) => v > 0);
            const avgVol = historicalVols.length > 0
                ? historicalVols.reduce((a: number, b: number) => a + b, 0) / historicalVols.length
                : today.v;

            const rvol = avgVol > 0 ? today.v / avgVol : 1;

            // Approximate VWAP from today's candle (Typical Price)
            const vwap = (today.h + today.l + today.c) / 3;

            return {
                data: {
                    o: today.o,
                    h: today.h,
                    l: today.l,
                    c: today.c,
                    v: today.v,
                    vwap,
                    rvol
                }
            };

        } catch (e: any) {
            console.warn(`[MarketData] Intraday fetch failed for ${ticker}`, e);
            return { data: null, error: `Exception: ${e.message}` };
        }
    }

    /**
     * Get Current Price (Real-time / Delayed)
     * Used for Portfolio Valuation and Trade Execution
     */
    static async getCurrentPrice(ticker: string): Promise<number | null> {
        // 1. Try Finnhub Quote
        try {
            // Rate limit check
            const now = Date.now();
            if (now - STATE.lastFinnhubCall < 1100) await sleep(1100 - (now - STATE.lastFinnhubCall));
            STATE.lastFinnhubCall = Date.now();

            const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${KEYS.FINNHUB}`;
            const data = await httpsGet(url);
            if (data && typeof data.c === 'number' && data.c > 0) {
                return data.c;
            }
        } catch (e) {
            console.warn(`[MarketData] Finnhub quote failed for ${ticker}`, e);
        }

        // 2. Try Alpha Vantage Global Quote (Backup)
        try {
            const allowed = STATE.avUsed < LIMITS.AV_DAILY;
            if (allowed) {
                STATE.avUsed++;
                const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${KEYS.ALPHA_VANTAGE}`;
                const data = await httpsGet(url);
                const price = parseFloat(data['Global Quote']?.['05. price']);
                if (!isNaN(price) && price > 0) return price;
            }
        } catch (e) {
            console.warn(`[MarketData] AV quote failed for ${ticker}`, e);
        }

        // 3. Try EODHD Real-time (Backup)
        try {
            // EODHD Real-Time Data requires a specialized endpoint. 
            // "https://eodhd.com/api/real-time/AAPL.US?api_token=..."
            // Assuming user has access or we use delayed from EOD endpoint approx?
            // Actually, EOD endpoint is only daily. The user keys might support delayed.
            // Let's stick to the principle of "add ... carefully".
            // EODHD Free tier is often EOD only.
            // We'll skip EODHD for "Current Price" unless we are desperate.
            // If we really need a fallback, maybe we can use the "intraday" logic but just take the last close?
        } catch (e) { }

        return null;
    }
}
