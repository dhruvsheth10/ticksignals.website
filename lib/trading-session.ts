/** US equity session helpers (America/New_York). Weekends only — no holiday calendar. */

export const ET_TZ = 'America/New_York';

/**
 * Previous Mon–Fri calendar day in ET relative to `etYmd` (YYYY-MM-DD).
 * Example: Monday → Friday; Sunday → Friday (steps back past Sat/Sun).
 */
export function getPreviousUsTradingSessionEtYmd(etYmd: string): string {
    const [Y, M, D] = etYmd.split('-').map(Number);
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: ET_TZ,
        weekday: 'short',
    });
    for (let back = 1; back <= 12; back++) {
        const dt = new Date(Date.UTC(Y, M - 1, D - back, 18, 0, 0));
        const wd = formatter.format(dt);
        if (wd !== 'Sat' && wd !== 'Sun') {
            return dt.toLocaleDateString('sv', { timeZone: ET_TZ });
        }
    }
    return etYmd;
}
