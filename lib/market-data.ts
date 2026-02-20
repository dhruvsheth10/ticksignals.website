import https from 'https';
import yahooFinance from 'yahoo-finance2';

// API Keys - In a real prod environment these should be in .env,
// but for this specific request we are embedding them as fallbacks/defaults.
const KEYS = {
    FINNHUB: 'd6b1ampr01qnr27j99q0', // Trying first half of the provided key
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

            // Debug: check key
            const maskKey = KEYS.FINNHUB.slice(0, 2) + '...' + KEYS.FINNHUB.slice(-2);
            console.log(`[MarketData] Finnhub Key: ${maskKey}`);

            const data = await this.fetchFinnhub(ticker, 'D', from, to);

            if (data.s !== 'ok') {
                // 403 usually means premium endpoint or restricted market. Fallback to Alpha Vantage?
                console.warn(`[MarketData] Finnhub error for ${ticker}: ${data.s} (Code: ${data.s === 'no_data' ? 404 : 403})`);
                throw new Error(`Finnhub error: ${data.s}`);
            }
            if (!data.t || data.t.length < 2) {
                throw new Error(`Finnhub: Insufficient data (t=${data.t?.length})`);
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
            const historicalVols = data.v.slice(0, len - 1).filter((v: number) => v > 0);
            const avgVol = historicalVols.length > 0
                ? historicalVols.reduce((a: number, b: number) => a + b, 0) / historicalVols.length
                : today.v;

            const rvol = avgVol > 0 ? today.v / avgVol : 1;

            // Approximate VWAP
            const vwap = (today.h + today.l + today.c) / 3;

            return {
                data: { o: today.o, h: today.h, l: today.l, c: today.c, v: today.v, vwap, rvol }
            };

        } catch (e: any) {
            console.warn(`[MarketData] Finnhub Intraday failed for ${ticker}: ${e.message}. Trying Backup (Alpha Vantage)...`);

            // Backup: Alpha Vantage (TIME_SERIES_DAILY) - Limited to 25/day
            try {
                if (STATE.avUsed >= LIMITS.AV_DAILY) throw new Error('Alpha Vantage daily limit reached');

                const avData = await this.fetchAlphaVantage(ticker); // "Time Series (Daily)"
                const ts = avData['Time Series (Daily)'];
                if (!ts) throw new Error('No AV data');

                const dates = Object.keys(ts).sort(); // Oldest first
                if (dates.length < 2) throw new Error('Insufficient AV history');

                const todayDate = dates[dates.length - 1];
                const todayCandle = ts[todayDate];
                const today = {
                    o: parseFloat(todayCandle['1. open']),
                    h: parseFloat(todayCandle['2. high']),
                    l: parseFloat(todayCandle['3. low']),
                    c: parseFloat(todayCandle['4. close']),
                    v: parseFloat(todayCandle['5. volume'])
                };

                // Calculate 30d avg volume
                // dates are sorted, so take slice(-31, -1)
                const histDates = dates.slice(Math.max(0, dates.length - 31), dates.length - 1);
                const vols = histDates.map(d => parseFloat(ts[d]['5. volume'])).filter(v => v > 0);
                const avgVol = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : today.v;
                const rvol = avgVol > 0 ? today.v / avgVol : 1;
                const vwap = (today.h + today.l + today.c) / 3;

                return {
                    data: { o: today.o, h: today.h, l: today.l, c: today.c, v: today.v, vwap, rvol }
                };

            } catch (avErr: any) {
                console.warn(`[MarketData] AV Backup failed for ${ticker}: ${avErr.message}`);
                return { data: null, error: `Finnhub: ${e.message} | AV: ${avErr.message}` };
            }
        }
    }

    /**
     * Get Current Price (Real-time / Delayed)
     * Used for Portfolio Valuation and Trade Execution
     */
    static async getCurrentPrice(ticker: string): Promise<number | null> {
        // 1. Give Yahoo Finance priority for simple spot prices (No Rate Limits)
        try {
            const quote = await yahooFinance.quote(ticker);
            const price = (quote as any)?.regularMarketPrice;
            if (price && price > 0) {
                return price;
            }
        } catch (e) {
            console.warn(`[MarketData] Yahoo Finance quote failed for ${ticker}`, e);
        }

        // 2. Try Finnhub Quote (Backup)
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

        // 3. Try Alpha Vantage Global Quote (Backup)
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

    // --- MASSIVE.COM (POLYGON) FINANCIALS ---
    // Strict 5 RPM limit on free tier, use sparingly.
    static async getDeepFinancials(ticker: string): Promise<any> {
        const apiKey = process.env.MASSIVE_API_KEY || '7Qxy0hwMkHzPz0DDoPgVfDaa8GarQRlx';
        const url = `https://api.massive.com/vX/reference/financials?ticker=${ticker}&limit=1&apiKey=${apiKey}`;
        try {
            const data = await httpsGet(url);
            if (data && data.results && data.results.length > 0) {
                return data.results[0];
            }
        } catch (e) {
            console.error(`[MarketData] Massive API error for ${ticker}:`, e);
        }
        return null;
    }

    // --- FRED MACRO ECONOMIC INDICATOR ---
    static async getMacroTrend(): Promise<{ safeToTrade: boolean; reason: string }> {
        const fredKey = process.env.FRED_API_KEY;
        if (!fredKey) {
            // Default pass if user hasn't supplied FRED yet.
            return { safeToTrade: true, reason: 'FRED API Key absent - assuming Macro OK' };
        }

        try {
            // VIX is the global fear index.
            // A VIX over 30 generally means "extreme fear/panic selling"
            const url = `https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&sort_order=desc&limit=1&api_key=${fredKey}&file_type=json`;
            const data = await httpsGet(url);
            if (data && data.observations && data.observations.length > 0) {
                const latestVix = parseFloat(data.observations[0].value);
                if (latestVix >= 35) {
                    return { safeToTrade: false, reason: `VIX extremely high (${latestVix}). Market in severe panic.` };
                }
                if (latestVix > 25) {
                    return { safeToTrade: true, reason: `VIX elevated (${latestVix}). Expect high volatility.` };
                }
                return { safeToTrade: true, reason: `VIX Normal (${latestVix})` };
            }
        } catch (e) {
            console.error('[MarketData] FRED API error:', e);
        }
        return { safeToTrade: true, reason: 'FRED fallback - OK' };
    }
}
