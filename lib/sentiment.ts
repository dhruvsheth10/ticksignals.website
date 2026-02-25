/**
 * Hybrid Sentiment Analysis: Gemini AI + Keyword Fallback
 *
 * 1. Fetch news from Yahoo Finance (free)
 * 2. If GEMINI_API_KEY is set, use Gemini to analyze headlines (AI-powered)
 * 3. Fall back to keyword-based analysis if Gemini fails or is unavailable
 * 4. Cache results per ticker for 1 hour to minimize API calls
 */

export interface SentimentScore {
    score: number;        // -1 to 1
    confidence: number;   // 0 to 1
    newsCount: number;
    sources: string[];
    aiPowered?: boolean;  // true if Gemini was used
}

import https from 'https';

// ── In-Memory Cache (1 hour TTL) ──
const sentimentCache = new Map<string, { result: SentimentScore; timestamp: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ══════════════════════════════════════════════════════════════════════
// YAHOO NEWS FETCHER
// ══════════════════════════════════════════════════════════════════════

async function fetchYahooNews(ticker: string): Promise<any[]> {
    return new Promise((resolve) => {
        const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${ticker}&quotesCount=1&newsCount=10`;

        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                try {
                    if (res.statusCode === 200) {
                        const data = JSON.parse(body);
                        resolve(data.news || []);
                    } else {
                        resolve([]);
                    }
                } catch (error) {
                    console.error(`[Sentiment] Failed to parse news for ${ticker}:`, error);
                    resolve([]);
                }
            });
        }).on('error', (error) => {
            console.error(`[Sentiment] Failed to fetch news for ${ticker}:`, error);
            resolve([]);
        }).setTimeout(10000, () => {
            resolve([]);
        });
    });
}

// ══════════════════════════════════════════════════════════════════════
// GEMINI AI SENTIMENT ANALYSIS
// ══════════════════════════════════════════════════════════════════════

interface GeminiSentimentResult {
    sentiment: number;     // -1 to 1
    confidence: number;    // 0 to 1
    reasoning: string;
}

async function analyzeWithGemini(ticker: string, headlines: string[]): Promise<GeminiSentimentResult | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const headlineText = headlines.slice(0, 8).map((h, i) => `${i + 1}. ${h}`).join('\n');

    const prompt = `You are a senior financial analyst. Analyze these recent news headlines for ${ticker} and determine the overall market sentiment.

Headlines:
${headlineText}

Consider:
- Earnings implications (beat/miss/guidance)
- Market sentiment and investor behavior
- Sector-wide vs company-specific news
- Short-term trading impact (1-5 day outlook)

Respond ONLY with valid JSON (no markdown, no backticks):
{"sentiment": <number from -1.0 to 1.0 where 1.0 is very bullish and -1.0 is very bearish>, "confidence": <number from 0.0 to 1.0>, "reasoning": "<one sentence explanation>"}`;

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 200,
                }
            }),
        });

        if (!response.ok) {
            console.warn(`[Sentiment] Gemini API error: ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return null;

        // Parse JSON from response (handle potential markdown wrapping)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]);
        return {
            sentiment: Math.max(-1, Math.min(1, parsed.sentiment || 0)),
            confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
            reasoning: parsed.reasoning || '',
        };
    } catch (error) {
        console.error(`[Sentiment] Gemini analysis failed for ${ticker}:`, error);
        return null;
    }
}

// ══════════════════════════════════════════════════════════════════════
// KEYWORD-BASED FALLBACK
// ══════════════════════════════════════════════════════════════════════

function analyzeKeywordSentiment(text: string): number {
    const lowerText = text.toLowerCase();

    const bullishKeywords = [
        'surge', 'rally', 'gain', 'jump', 'soar', 'climb', 'rise', 'up', 'beat', 'exceed',
        'strong', 'growth', 'profit', 'earnings', 'positive', 'bullish', 'buy', 'upgrade',
        'outperform', 'strong buy', 'breakthrough', 'record', 'high', 'momentum',
        'revenue', 'expand', 'innovat', 'partner', 'launch', 'dividend'
    ];

    const bearishKeywords = [
        'drop', 'fall', 'decline', 'plunge', 'crash', 'down', 'miss', 'disappoint',
        'loss', 'negative', 'bearish', 'sell', 'downgrade', 'underperform', 'weak',
        'concern', 'risk', 'warning', 'low', 'slump', 'tumble',
        'layoff', 'lawsuit', 'recall', 'investigation', 'default', 'bankrupt'
    ];

    let bullishCount = 0, bearishCount = 0;

    bullishKeywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\w*\\b`, 'gi');
        const matches = lowerText.match(regex);
        if (matches) bullishCount += matches.length;
    });

    bearishKeywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\w*\\b`, 'gi');
        const matches = lowerText.match(regex);
        if (matches) bearishCount += matches.length;
    });

    const total = bullishCount + bearishCount;
    if (total === 0) return 0;
    return (bullishCount - bearishCount) / Math.max(total, 1);
}

// ══════════════════════════════════════════════════════════════════════
// MAIN SENTIMENT SCORER
// ══════════════════════════════════════════════════════════════════════

export async function getSentimentScore(ticker: string): Promise<SentimentScore> {
    // Check cache first
    const cached = sentimentCache.get(ticker);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.result;
    }

    try {
        const news = await fetchYahooNews(ticker);

        if (news.length === 0) {
            const result: SentimentScore = { score: 0, confidence: 0, newsCount: 0, sources: [] };
            sentimentCache.set(ticker, { result, timestamp: Date.now() });
            return result;
        }

        const sources = [...new Set(news.slice(0, 10).map((a: any) => a.publisher).filter(Boolean))];
        const headlines = news.slice(0, 10).map((a: any) => {
            const title = a.title || '';
            const summary = a.summary || '';
            return `${title} ${summary}`.trim();
        }).filter(Boolean);

        // Try Gemini AI first
        const geminiResult = await analyzeWithGemini(ticker, headlines);

        if (geminiResult) {
            const result: SentimentScore = {
                score: geminiResult.sentiment,
                confidence: geminiResult.confidence,
                newsCount: news.length,
                sources,
                aiPowered: true,
            };
            sentimentCache.set(ticker, { result, timestamp: Date.now() });
            return result;
        }

        // Fallback to keyword analysis
        let totalScore = 0;
        for (const headline of headlines) {
            totalScore += analyzeKeywordSentiment(headline);
        }

        const avgScore = totalScore / headlines.length;
        const confidence = Math.min(news.length / 10, 1);

        const result: SentimentScore = {
            score: Math.max(-1, Math.min(1, avgScore)),
            confidence,
            newsCount: news.length,
            sources,
            aiPowered: false,
        };
        sentimentCache.set(ticker, { result, timestamp: Date.now() });
        return result;
    } catch (error) {
        console.error(`[Sentiment] Error analyzing ${ticker}:`, error);
        return { score: 0, confidence: 0, newsCount: 0, sources: [] };
    }
}

/**
 * Market-wide sentiment (SPY proxy)
 */
export async function getMarketSentiment(): Promise<number> {
    try {
        const spySentiment = await getSentimentScore('SPY');
        return spySentiment.score;
    } catch (error) {
        return 0;
    }
}
