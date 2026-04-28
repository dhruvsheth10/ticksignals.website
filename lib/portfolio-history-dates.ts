/**
 * Client-safe date helpers for portfolio_history rows (matches lib/portfolio-db normalization).
 */
export { getPreviousUsTradingSessionEtYmd, ET_TZ } from './trading-session';

/** Normalizes portfolio_history.date to YYYY-MM-DD (pads legacy unpadded segments). */
export function portfolioHistoryDayKey(dateStr: string): string | null {
    if (!dateStr) return null;

    if (dateStr.includes('T')) {
        const d = new Date(dateStr.endsWith('Z') ? dateStr : `${dateStr}Z`);
        return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }

    if (dateStr.includes('/')) {
        const parts = dateStr.split('/');
        if (parts.length !== 3) return null;
        const [m, day, y] = parts;
        const iso = `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}T16:00:00Z`;
        const date = new Date(iso);
        return isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    }

    if (dateStr.includes('-')) {
        const parts = dateStr.split('-');
        if (parts.length !== 3) return null;
        const [a, b, c] = parts;
        const bp = b.padStart(2, '0');
        const cp = c.padStart(2, '0');
        let iso = `${a}-${bp}-${cp}T16:00:00Z`;
        let date = new Date(iso);
        if (!isNaN(date.getTime()) && date.getFullYear() > 2000) {
            return date.toISOString().slice(0, 10);
        }
        iso = `${a}-${cp}-${bp}T16:00:00Z`;
        date = new Date(iso);
        if (!isNaN(date.getTime()) && date.getFullYear() > 2000) {
            return date.toISOString().slice(0, 10);
        }
    }

    return null;
}
