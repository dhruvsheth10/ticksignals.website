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

        const logs: string[] = [`Checking ${prospects.length} prospects...`];
        const signals = [];

        for (const p of prospects) {
            try {
                // analyzeTicker fetches daily candles + indicators + sentiment
                const signal = await analyzeTicker(p.ticker);

                // Save result to update dashboard
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
                    sma200: signal.indicators?.sma200
                });

                if (signal.action !== 'HOLD' && signal.confidence > 60) {
                    const logMsg = `${p.ticker}: ${signal.action} (${signal.confidence}%) - ${signal.reason}`;
                    logs.push(logMsg);
                    signals.push(logMsg);
                }
            } catch (err: any) {
                console.error(`[Monitor] Error ${p.ticker}:`, err.message);
                logs.push(`${p.ticker}: Error ${err.message}`);
            }
        }

        if (signals.length > 0) {
            await saveCycleLog('MONITOR', logs.join('\n'));
        }

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
