# Oracle VM Cron Jobs

**VM:** Oracle Cloud (opc@146.235.235.140)  
**SSH Key:** `SSH Key Feb 15 2026.key` (in repo root)  
**Connect:** `ssh -i "SSH Key Feb 15 2026.key" opc@146.235.235.140`

> ⚠️ These crons run on the Oracle VM and are **separate from Vercel crons**.
> Vercel only has 2 cron slots (OPEN + CLOSE). All MID/intraday trading and screener refreshes are handled here.

---

## Full Crontab (`crontab -l`)

```cron
# === Oracle Analyzer Runs (Node Service) ===
# 6:30 AM PST
30 14 * * 1-5 cd /home/opc/oracle-service && /usr/local/bin/node dist/index.js >> /home/opc/oracle-service/logs/analysis.log 2>&1
# 9:00 AM PST
0 17 * * 1-5 cd /home/opc/oracle-service && /usr/local/bin/node dist/index.js >> /home/opc/oracle-service/logs/analysis.log 2>&1
# 12:00 PM PST
0 20 * * 1-5 cd /home/opc/oracle-service && /usr/local/bin/node dist/index.js >> /home/opc/oracle-service/logs/analysis.log 2>&1

# === The Global 1K Stock Scan (Updates the Top 20 Prospects) ===
# 6:00 AM PST (Before Market Open)
0 14 * * 1-5 curl -sL "https://www.dhruvs.app/api/screener?force=true&key=dhruv123" >> /home/opc/oracle-service/logs/screener.log 2>&1
# 7:30 AM PST
30 15 * * 1-5 curl -sL "https://www.dhruvs.app/api/screener?force=true&key=dhruv123" >> /home/opc/oracle-service/logs/screener.log 2>&1
# 11:00 AM PST (Mid-Market)
0 19 * * 1-5 curl -sL "https://www.dhruvs.app/api/screener?force=true&key=dhruv123" >> /home/opc/oracle-service/logs/screener.log 2>&1
# 9:00 AM PST
0 16 * * 1-5 curl -sL "https://www.dhruvs.app/api/screener?force=true&key=dhruv123" >> /home/opc/oracle-service/logs/screener.log 2>&1
# 1:30 PM PST (EOD Prep)
30 20 * * 1-5 curl -sL "https://www.dhruvs.app/api/screener?force=true&key=dhruv123" >> /home/opc/oracle-service/logs/screener.log 2>&1

# === The 20-Stock Trading Scanner (MID Cycles) ===
# Runs every 20 mins from 6:30 AM PST (14:30 UTC) to 1:00 PM PST (21:00 UTC)
*/20 14-21 * * 1-5 curl -sL "https://www.dhruvs.app/api/cron/trade?type=MID&key=dhruv123" >> /home/opc/oracle-service/logs/trade-cron.log 2>&1
```

---

## Summary Table

| PST Time | UTC | Job | URL/Command |
|---|---|---|---|
| 6:00 AM | 14:00 | Screener refresh | `/api/screener?force=true` |
| 6:30 AM | 14:30 | Oracle analyzer | `node dist/index.js` |
| 7:30 AM | 15:30 | Screener refresh | `/api/screener?force=true` |
| 9:00 AM | 16:00 | Screener refresh | `/api/screener?force=true` |
| 9:00 AM | 17:00 | Oracle analyzer | `node dist/index.js` |
| 11:00 AM | 19:00 | Screener refresh | `/api/screener?force=true` |
| 12:00 PM | 20:00 | Oracle analyzer | `node dist/index.js` |
| 1:30 PM | 20:30 | Screener refresh | `/api/screener?force=true` |
| Every 20 min | 14:30–21:00 UTC | **MID Trade Cycle** | `/api/cron/trade?type=MID` |

## Vercel Crons (2 slots used)

| PST Time | UTC Schedule | Type |
|---|---|---|
| 6:30 AM | `30 14 * * 1-5` | `OPEN` |
| 12:00 PM | `0 20 * * 1-5` | `CLOSE` |

## Logs (on VM)

```
/home/opc/oracle-service/logs/analysis.log    # Oracle analyzer
/home/opc/oracle-service/logs/screener.log    # Screener refreshes
/home/opc/oracle-service/logs/trade-cron.log  # MID trade cron
```
