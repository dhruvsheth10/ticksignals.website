# Deployment Summary

## What Was Created

A complete Oracle Cloud service for analyzing all Vanguard stocks with trading signals.

### Files Created:
- `src/index.ts` - Main service entry point
- `src/analyzer.ts` - Trading analysis engine (technical indicators + sentiment)
- `src/resource-monitor.ts` - Resource monitoring with fail-safes
- `src/sentiment.ts` - Yahoo Finance news sentiment analysis
- `src/db.ts` - Database connection and schema
- `package.json` - Dependencies
- `tsconfig.json` - TypeScript configuration
- `setup.sh` - Automated setup script
- `README.md` - Documentation
- `INSTALL.md` - Step-by-step installation guide

## Key Features

✅ **Analyzes ~1500 Vanguard stocks**
✅ **Technical Indicators**: RSI, MACD, Bollinger Bands, Volume, SMA50/200
✅ **Sentiment Analysis**: Yahoo Finance news keyword analysis
✅ **Resource Monitoring**: Prevents exceeding Oracle Cloud free tier limits
✅ **Fail-Safes**: Auto-stops if CPU > 80%, Memory > 900 MB, or execution > 2 hours
✅ **Database Storage**: Saves all analysis results to PostgreSQL
✅ **Scheduled Runs**: 6:30 AM, 9:00 AM, 12:00 PM PST (weekdays only)

## Next Steps

1. **Copy files to Oracle VM**:
   ```bash
   cd /Users/dhruvsheth/ticksignals.website
   tar -czf oracle-service.tar.gz oracle-service/ python-service/vanguard.csv
   scp oracle-service.tar.gz opc@146.235.235.140:~/
   ```

2. **SSH into Oracle VM**:
   ```bash
   ssh opc@146.235.235.140
   ```

3. **Follow INSTALL.md** for complete setup instructions

## Resource Limits Enforced

- **CPU**: Stops if > 80% usage
- **Memory**: Stops if > 900 MB (out of 1 GB)
- **Network**: Tracks daily/monthly, stops if approaching 10 TB/month
- **Execution Time**: Auto-kills after 2 hours

## Database Schema

Results stored in `trading_analysis_results` table:
- All analysis results with timestamps
- Technical indicator values
- Sentiment scores
- Action (BUY/SELL/HOLD) and confidence

## Cron Schedule (PST → UTC)

- 6:30 AM PST = 14:30 UTC
- 9:00 AM PST = 17:00 UTC  
- 12:00 PM PST = 20:00 UTC

Runs Monday-Friday only (`1-5` in cron).

