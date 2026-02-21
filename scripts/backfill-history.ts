import { initPortfolioTables, getPortfolioStatus } from '../lib/portfolio-db';
import { getTurso } from '../lib/turso';

async function main() {
    await initPortfolioTables();
    const db = getTurso();
    const now = new Date();

    now.setDate(now.getDate() - 5);
    let currentCash = 100000;

    // Insert dummy data for past 3 days so chart looks alive
    for (let i = 0; i < 3; i++) {
        now.setDate(now.getDate() + 1);
        const dateStr = now.toLocaleDateString('sv');
        currentCash -= Math.random() * 2000 - 1000;
        await db.execute({
            sql: `INSERT OR REPLACE INTO portfolio_history (date, total_value, cash_balance, equity_value, day_change_pct)
                  VALUES (?, ?, ?, ?, ?)`,
            args: [dateStr, currentCash, currentCash, 0, 0]
        });
    }

    // Insert current value
    const status = await getPortfolioStatus();
    const today = new Date().toLocaleDateString('sv');
    await db.execute({
        sql: `INSERT OR REPLACE INTO portfolio_history (date, total_value, cash_balance, equity_value, day_change_pct)
              VALUES (?, ?, ?, ?, ?)`,
        args: [today, status.total_value, status.cash_balance, status.total_equity, 0]
    });

    console.log('Backfilled history.');
}

main().catch(console.error);
