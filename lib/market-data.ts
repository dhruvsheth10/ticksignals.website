import https from 'https';

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

function getNyDateKey(tsMs: number): string {
    return new Date(tsMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function computeBarVWAP(bars: Array<{ high: number; low: number; close: number; volume: number }>): number {
    let totalPV = 0;
    let totalVolume = 0;
    for (const bar of bars) {
        if (bar.volume <= 0) continue;
        const typical = (bar.high + bar.low + bar.close) / 3;
        totalPV += typical * bar.volume;
        totalVolume += bar.volume;
    }
    return totalVolume > 0 ? totalPV / totalVolume : 0;
}

// Simple HTTPS GET wrapper
async function httpsGet(urlString: string): Promise<any> {
    const res = await fetch(urlString, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        },
        cache: 'no-store'
    });
    if (!res.ok) throw new Error(`API Error: ${res.status} ${res.statusText}`);
    return res.json();
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

        // 1. Give Yahoo Finance priority (No hard rate limits compared to Finnhub/AV)
        // Use query2 as backup if query1 returns 429
        for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
            try {
                const data = await httpsGet(`https://${host}/v8/finance/chart/${ticker}?interval=1d&range=2y`);
                const result = data?.chart?.result?.[0];
                if (result?.timestamp && result?.indicators?.quote?.[0]) {
                    const quote = result.indicators.quote[0];
                    const candles: any[] = [];
                    for (let i = 0; i < result.timestamp.length; i++) {
                        if (result.timestamp.length - i <= days + 10) {
                            candles.push({
                                date: new Date(result.timestamp[i] * 1000).toISOString(),
                                open: quote.open[i] ?? quote.close[i],
                                high: quote.high[i] ?? quote.close[i],
                                low: quote.low[i] ?? quote.close[i],
                                close: quote.close[i],
                                volume: quote.volume[i] ?? 0
                            });
                        }
                    }
                    const filtered = candles.filter((q: any) => q.close !== null && q.close !== undefined);
                    if (filtered.length > 0) return filtered;
                }
            } catch (e: any) {
                console.warn(`[MarketData] Yahoo chart (${host}) failed for ${ticker}:`, e.message);
            }
        }

        // 2. Try Finnhub
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
        } catch (e: any) {
            console.warn(`[MarketData] Finnhub failed for ${ticker}:`, e.message);
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
        // ── 1. Yahoo Finance intraday bars (primary, free, unofficial) ──
        for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
            try {
                const intraday = await httpsGet(
                    `https://${host}/v8/finance/chart/${ticker}?interval=5m&range=5d&includePrePost=false`
                );
                const result = intraday?.chart?.result?.[0];
                if (result?.timestamp && result?.indicators?.quote?.[0]) {
                    const quote = result.indicators.quote[0];
                    const bars = result.timestamp.map((ts: number, i: number) => {
                        const close = quote.close?.[i];
                        if (close === null || close === undefined || close <= 0) return null;
                        return {
                            ts,
                            dateNy: getNyDateKey(ts * 1000),
                            open: (quote.open?.[i] ?? close) as number,
                            high: (quote.high?.[i] ?? close) as number,
                            low: (quote.low?.[i] ?? close) as number,
                            close: close as number,
                            volume: (quote.volume?.[i] ?? 0) as number,
                        };
                    }).filter(Boolean) as Array<{
                        ts: number;
                        dateNy: string;
                        open: number;
                        high: number;
                        low: number;
                        close: number;
                        volume: number;
                    }>;

                    const latestDateNy = bars[bars.length - 1]?.dateNy;
                    const sessionBars = latestDateNy
                        ? bars.filter((bar) => bar.dateNy === latestDateNy)
                        : [];

                    if (sessionBars.length > 0) {
                        const session = {
                            o: sessionBars[0].open,
                            h: Math.max(...sessionBars.map((bar: {
                                high: number;
                            }) => bar.high)),
                            l: Math.min(...sessionBars.map((bar: {
                                low: number;
                            }) => bar.low)),
                            c: sessionBars[sessionBars.length - 1].close,
                            v: sessionBars.reduce((sum: number, bar: {
                                volume: number;
                            }) => sum + bar.volume, 0),
                        };

                        const dailyData = await httpsGet(
                            `https://${host}/v8/finance/chart/${ticker}?interval=1d&range=2mo`
                        );
                        const dailyResult = dailyData?.chart?.result?.[0];
                        const dailyQuote = dailyResult?.indicators?.quote?.[0];
                        const historicalVols = (dailyQuote?.volume || [])
                            .slice(-21, -1)
                            .filter((v: number | null | undefined) => !!v && v > 0) as number[];
                        const avgVol = historicalVols.length > 0
                            ? historicalVols.reduce((a: number, b: number) => a + b, 0) / historicalVols.length
                            : session.v;
                        const rvol = avgVol > 0 ? session.v / avgVol : 1;
                        const vwap = computeBarVWAP(sessionBars);

                        return { data: { ...session, vwap, rvol } };
                    }
                }
            } catch (e: any) {
                console.warn(`[MarketData] Yahoo intraday (${host}) failed for ${ticker}:`, e.message);
            }
        }

        // ── 2. Finnhub 5-minute bars fallback (rate-limited) ──
        try {
            const to = Math.floor(Date.now() / 1000);
            const from = to - (5 * 86400);
            const data = await this.fetchFinnhub(ticker, '5', from, to);

            if (data.s !== 'ok' || !data.t || data.t.length < 2) {
                throw new Error(`Finnhub error: ${data.s}`);
            }

            const bars = data.t.map((ts: number, i: number) => ({
                dateNy: getNyDateKey(ts * 1000),
                open: data.o[i] as number,
                high: data.h[i] as number,
                low: data.l[i] as number,
                close: data.c[i] as number,
                volume: data.v[i] as number,
            })).filter((bar: {
                dateNy: string;
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
            }) => bar.close > 0);

            const latestDateNy = bars[bars.length - 1]?.dateNy;
            const sessionBars = latestDateNy
                ? bars.filter((bar: {
                    dateNy: string;
                }) => bar.dateNy === latestDateNy)
                : [];
            if (sessionBars.length === 0) {
                throw new Error('No intraday session bars');
            }

            const session = {
                o: sessionBars[0].open,
                h: Math.max(...sessionBars.map((bar: {
                    high: number;
                }) => bar.high)),
                l: Math.min(...sessionBars.map((bar: {
                    low: number;
                }) => bar.low)),
                c: sessionBars[sessionBars.length - 1].close,
                v: sessionBars.reduce((sum: number, bar: {
                    volume: number;
                }) => sum + bar.volume, 0),
            };
            const historicalDaily = await this.getDailyCandles(ticker, 30);
            const historicalVols = historicalDaily
                .slice(-21, -1)
                .map((candle) => candle.volume)
                .filter((volume) => volume > 0);
            const avgVol = historicalVols.length > 0
                ? historicalVols.reduce((a, b) => a + b, 0) / historicalVols.length
                : session.v;
            const rvol = avgVol > 0 ? session.v / avgVol : 1;
            const vwap = computeBarVWAP(sessionBars);
            return { data: { ...session, vwap, rvol } };

        } catch (finnhubErr: any) {
            console.warn(`[MarketData] Finnhub intraday failed for ${ticker}:`, finnhubErr.message);
        }

        // ── 3. Daily proxy last resort ──
        try {
            const candles = await this.getDailyCandles(ticker, 30);
            const today = candles[candles.length - 1];
            if (!today) throw new Error('No daily candles');
            const historicalVols = candles
                .slice(-21, -1)
                .map((candle) => candle.volume)
                .filter((volume) => volume > 0);
            const avgVol = historicalVols.length > 0
                ? historicalVols.reduce((a, b) => a + b, 0) / historicalVols.length
                : today.volume;
            const rvol = avgVol > 0 ? today.volume / avgVol : 1;
            const vwap = (today.high + today.low + today.close) / 3;
            return {
                data: {
                    o: today.open,
                    h: today.high,
                    l: today.low,
                    c: today.close,
                    v: today.volume,
                    vwap,
                    rvol,
                }
            };
        } catch (proxyErr: any) {
            return { data: null, error: `All sources failed for ${ticker}: ${proxyErr.message}` };
        }
    }

    /**
     * Get Current Price (Real-time / Delayed)
     * Used for Portfolio Valuation and Trade Execution
     */
    static async getCurrentPrice(ticker: string): Promise<number | null> {
        // 1. Give Yahoo Finance priority for simple spot prices (No Rate Limits)
        // Try query2 first, fallback to query1 if 429
        for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
            try {
                const data = await httpsGet(`https://${host}/v8/finance/chart/${ticker}?interval=1m&range=1d`);
                const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price && typeof price === 'number' && price > 0) {
                    return price;
                }
            } catch (e: any) {
                console.warn(`[MarketData] Yahoo Finance quote (${host}) failed for ${ticker}:`, e.message);
            }
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
