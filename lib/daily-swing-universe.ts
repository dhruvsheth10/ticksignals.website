import { getPool } from './db';
import { analyzeTicker, TradeSignal } from './trading-engine';

interface ScreenerUniverseRow {
    ticker: string;
    sector: string | null;
    price: number | null;
    market_cap: number | null;
    roe_pct: number | null;
    roa_pct: number | null;
    gross_margin_pct: number | null;
    debt_to_equity: number | null;
    beta: number | null;
    fifty_two_week_high: number | null;
    fifty_two_week_low: number | null;
}

interface RankedUniverseRow extends ScreenerUniverseRow {
    stage1Score: number;
}

export interface DailySwingProspect {
    ticker: string;
    score: number;
    stage1Score: number;
    stage2Score: number;
    action: TradeSignal['action'];
    confidence: number;
    reason: string;
}

const DEFAULT_LIMIT = 50;
const BASE_CANDIDATE_LIMIT = 80;
const ANALYSIS_BATCH_SIZE = 5;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function normalize(value: number | null, min: number, max: number): number {
    if (value === null || Number.isNaN(value)) return 0;
    if (max <= min) return 0;
    return clamp((value - min) / (max - min), 0, 1);
}

function computeStage1Score(row: ScreenerUniverseRow): number {
    const price = row.price ?? 0;
    const high52 = row.fifty_two_week_high ?? 0;
    const low52 = row.fifty_two_week_low ?? 0;
    const range = high52 - low52;

    const qualityScore =
        normalize(row.roe_pct, 10, 35) * 26 +
        normalize(row.roa_pct, 2, 18) * 16 +
        normalize(row.gross_margin_pct, 8, 70) * 22 +
        normalize(row.market_cap ? Math.log10(row.market_cap) : null, 9, 12) * 10;

    const leveragePenalty = normalize(row.debt_to_equity, 0, 175) * 18;

    let momentumScore = 0;
    if (range > 0 && price > 0) {
        const pctFromLow = ((price - low52) / range) * 100;
        const pctToHigh = ((high52 - price) / high52) * 100;

        if (pctFromLow >= 55 && pctFromLow <= 92) momentumScore += 16;
        else if (pctFromLow >= 45 && pctFromLow < 55) momentumScore += 9;
        else if (pctFromLow > 92) momentumScore += 5;

        if (pctToHigh <= 12) momentumScore += 10;
        else if (pctToHigh <= 20) momentumScore += 6;
    }

    if ((row.beta ?? 1.2) <= 1.8) momentumScore += 4;
    if (price >= 20 && price <= 700) momentumScore += 4;

    return Math.max(0, qualityScore + momentumScore - leveragePenalty);
}

function isTrendUp(signal: TradeSignal): boolean {
    if ((signal.indicators?.sma50 ?? 0) > (signal.indicators?.sma200 ?? 0)) return true;
    return signal.reason.includes('Trend Up');
}

function shouldKeepProspect(signal: TradeSignal): boolean {
    if (signal.action === 'SELL') return false;
    if (signal.action === 'BUY') return true;
    return isTrendUp(signal) && signal.confidence >= 40;
}

function computeStage2Score(signal: TradeSignal): number {
    const trendBonus = isTrendUp(signal) ? 8 : 0;
    const actionBonus = signal.action === 'BUY' ? 18 : 0;
    const sentimentBonus = signal.sentimentBoost ?? 0;
    return Math.max(0, signal.confidence + trendBonus + actionBonus + sentimentBonus);
}

export async function buildDailySwingProspects(limit = DEFAULT_LIMIT): Promise<DailySwingProspect[]> {
    const db = getPool();
    const query = `
        SELECT
            ticker,
            sector,
            price,
            market_cap,
            roe_pct,
            roa_pct,
            gross_margin_pct,
            debt_to_equity,
            beta,
            fifty_two_week_high,
            fifty_two_week_low
        FROM screener_cache
        WHERE market_cap > 1000000000
          AND price BETWEEN 15 AND 1000
          AND roe_pct > 8
          AND gross_margin_pct > 5
          AND debt_to_equity < 175
          AND fifty_two_week_high IS NOT NULL
          AND fifty_two_week_low IS NOT NULL
        ORDER BY market_cap DESC NULLS LAST
    `;

    const result = await db.query(query);
    const baseCandidates: RankedUniverseRow[] = (result.rows as ScreenerUniverseRow[])
        .map((row) => ({
            ...row,
            stage1Score: computeStage1Score(row),
        }))
        .sort((a, b) => b.stage1Score - a.stage1Score)
        .slice(0, BASE_CANDIDATE_LIMIT);

    const prospects: DailySwingProspect[] = [];

    for (let i = 0; i < baseCandidates.length; i += ANALYSIS_BATCH_SIZE) {
        const batch = baseCandidates.slice(i, i + ANALYSIS_BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map(async (candidate) => {
                const signal = await analyzeTicker(candidate.ticker);
                if (!shouldKeepProspect(signal)) return null;

                const stage2Score = computeStage2Score(signal);
                const compositeScore = candidate.stage1Score * 0.55 + stage2Score * 0.45;

                return {
                    ticker: candidate.ticker,
                    score: Number(compositeScore.toFixed(2)),
                    stage1Score: Number(candidate.stage1Score.toFixed(2)),
                    stage2Score: Number(stage2Score.toFixed(2)),
                    action: signal.action,
                    confidence: signal.confidence,
                    reason: signal.reason,
                } satisfies DailySwingProspect;
            })
        );

        for (const entry of results) {
            if (entry.status === 'fulfilled' && entry.value) {
                prospects.push(entry.value);
            }
        }
    }

    return prospects
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
