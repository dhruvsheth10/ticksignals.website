/**
 * Free News & Sentiment Analysis
 * Uses Yahoo Finance news and free sentiment APIs
 */

import https from 'https';

export interface SentimentScore {
    score: number; // -1 to 1, where 1 is very bullish, -1 is very bearish
    confidence: number; // 0 to 1
    newsCount: number;
    sources: string[];
}

/**
 * Fetch news from Yahoo Finance (free, no API key needed)
 */
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

/**
 * Simple sentiment analysis based on keywords
 */
function analyzeSentiment(text: string): number {
    const lowerText = text.toLowerCase();
    
    // Bullish keywords
    const bullishKeywords = [
        'surge', 'rally', 'gain', 'jump', 'soar', 'climb', 'rise', 'up', 'beat', 'exceed',
        'strong', 'growth', 'profit', 'earnings', 'positive', 'bullish', 'buy', 'upgrade',
        'outperform', 'strong buy', 'breakthrough', 'record', 'high', 'momentum'
    ];
    
    // Bearish keywords
    const bearishKeywords = [
        'drop', 'fall', 'decline', 'plunge', 'crash', 'down', 'miss', 'disappoint',
        'loss', 'negative', 'bearish', 'sell', 'downgrade', 'underperform', 'weak',
        'concern', 'risk', 'warning', 'low', 'slump', 'tumble'
    ];
    
    let bullishCount = 0;
    let bearishCount = 0;
    
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
    
    // Return normalized score between -1 and 1
    return (bullishCount - bearishCount) / Math.max(total, 1);
}

/**
 * Get sentiment score for a ticker
 */
export async function getSentimentScore(ticker: string): Promise<SentimentScore> {
    try {
        const news = await fetchYahooNews(ticker);
        
        if (news.length === 0) {
            return {
                score: 0,
                confidence: 0,
                newsCount: 0,
                sources: []
            };
        }
        
        let totalScore = 0;
        const sources: string[] = [];
        
        // Analyze each news article
        for (const article of news.slice(0, 10)) { // Limit to 10 most recent
            const title = article.title || '';
            const summary = article.summary || '';
            const combined = `${title} ${summary}`;
            
            const articleScore = analyzeSentiment(combined);
            totalScore += articleScore;
            
            if (article.publisher) {
                sources.push(article.publisher);
            }
        }
        
        const avgScore = totalScore / news.length;
        const confidence = Math.min(news.length / 10, 1); // More news = higher confidence
        
        return {
            score: Math.max(-1, Math.min(1, avgScore)), // Clamp to -1 to 1
            confidence,
            newsCount: news.length,
            sources: [...new Set(sources)]
        };
    } catch (error) {
        console.error(`[Sentiment] Error analyzing ${ticker}:`, error);
        return {
            score: 0,
            confidence: 0,
            newsCount: 0,
            sources: []
        };
    }
}

