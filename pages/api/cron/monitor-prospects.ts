import type { NextApiRequest, NextApiResponse } from 'next';
import { getMonitoredProspects } from '../../../lib/db';
import { saveAnalysisResult, saveCycleLog } from '../../../lib/portfolio-db';
import { isMarketOpen, analyzeTicker } from '../../../lib/trading-engine';

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    // Auth Check
    const authHeader = req.headers['authorization'];
    if (
        process.env.CRON_SECRET &&
        authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        req.query.key !== process.env.CRON_SECRET
    ) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // Market Check (relaxed for monitoring: 8am - 9pm ET roughly)
        // isMarketOpen is strictly 9:30 - 4:00 ET.
        // We want to monitor pre-market too if possible.
        // Let's use isMarketOpen as a guide but be more permissive for monitoring.
        const now = new Date();
        const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = nyTime.getHours();

        // Skip only deep night (e.g. 10pm to 4am ET)
        // 4am ET is when pre-market data starts becoming available on some feeds.
        const isDeepNight = hour >= 22 || hour < 4;
        const isWeekend = nyTime.getDay() === 0 || nyTime.getDay() === 6;

        if ((isDeepNight || isWeekend) && req.query.force !== 'true') {
            return res.status(200).json({ status: 'Market Closed (Deep Night/Weekend)', skipped: true });
        }

        const prospects = await getMonitoredProspects();
        if (!prospects || prospects.length === 0) {
            return res.status(200).json({ message: 'No prospects to monitor' });
        }

        const logs: string[] = [`Evaluated ${prospects.length} monitored prospects:`];
        const signals: string[] = [];

        // Analyse tickers in parallel batches of 5.
        // getDailyCandles uses Yahoo Finance first (no sleep) so batching is safe.
        const BATCH = 5;
        for (let i = 0; i < prospects.length; i += BATCH) {
            const batch = prospects.slice(i, i + BATCH);
            const batchResults = await Promise.allSettled(
                batch.map(async (p) => {
                    const signal = await analyzeTicker(p.ticker);
                    await saveAnalysisResult({
                        ticker: p.ticker,
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
                        sma200: signal.indicators?.sma200,
                    });
                    return { p, signal };
                })
            );

            for (let j = 0; j < batchResults.length; j++) {
                const r = batchResults[j];
                if (r.status === 'fulfilled') {
                    const { p, signal } = r.value;
                    const displayAction = signal.action === 'HOLD' ? 'MONITORING' : signal.action;
                    const logMsg = `  ${p.ticker}: ${displayAction} ${signal.confidence > 0 ? `(${signal.confidence}%)` : ''} - ${signal.reason}`;
                    logs.push(logMsg);
                    if (signal.action !== 'HOLD' && signal.confidence > 60) signals.push(logMsg);
                } else {
                    const ticker = batch[j].ticker;
                    console.error(`[Monitor] Error ${ticker}:`, r.reason?.message);
                    logs.push(`  ${ticker}: Error ${r.reason?.message}`);
                }
            }
        }

        // Always save a cycle log so the user can verify the scan happened
        await saveCycleLog('MONITOR', logs.join('\n'));

        res.status(200).json({
            success: true,
            checked: prospects.length,
            signals: signals
        });

    } catch (error: any) {
        console.error('Monitor Job Failed:', error);
        res.status(500).json({ error: error.message });
    }
}

export const config = {
    maxDuration: 300, // 5 minutes
};
