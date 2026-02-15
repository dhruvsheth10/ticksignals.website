# Oracle Cloud Trading Analysis Service

Automated trading analysis service that runs on Oracle Cloud Always Free tier. Analyzes all Vanguard stocks using technical indicators and sentiment analysis.

## Features

- ✅ Analyzes ~1500 Vanguard stocks
- ✅ Technical indicators: RSI, MACD, Bollinger Bands, Volume, SMA
- ✅ Sentiment analysis from Yahoo Finance news
- ✅ Resource monitoring to prevent exceeding free tier limits
- ✅ Automatic fail-safes for CPU, memory, network, and execution time
- ✅ Stores results in PostgreSQL database
- ✅ Scheduled runs: 6:30 AM, 9:00 AM, 12:00 PM PST

## Setup Instructions

### 1. Copy files to Oracle Cloud VM

```bash
# On your local machine, create a tarball
cd /Users/dhruvsheth/ticksignals.website
tar -czf oracle-service.tar.gz oracle-service/ python-service/vanguard.csv

# Copy to Oracle VM
scp oracle-service.tar.gz opc@146.235.235.140:~/
scp python-service/vanguard.csv opc@146.235.235.140:~/oracle-service/
```

### 2. SSH into Oracle VM

```bash
ssh opc@146.235.235.140
```

### 3. Install Node.js (if not already installed)

```bash
# Oracle Linux 9
sudo dnf install -y nodejs npm

# Or use NodeSource for latest version
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
```

### 4. Extract and setup service

```bash
cd ~
tar -xzf oracle-service.tar.gz
cd oracle-service

# Copy vanguard.csv to oracle-service directory
cp ~/vanguard.csv .

# Install dependencies
npm install

# Build TypeScript
npm run build
```

### 5. Configure environment

```bash
# Create .env file
nano .env
```

Add your database connection:
```
NEON_DATABASE_URL=postgresql://user:password@host:port/database
```

### 6. Test the service

```bash
# Run a test (analyze first 10 stocks)
node dist/index.js
```

### 7. Setup cron jobs

```bash
# Edit crontab
crontab -e
```

Add these lines (times are in UTC - PST is UTC-8):
```
# 6:30 AM PST = 14:30 UTC
30 14 * * 1-5 cd /home/opc/oracle-service && /usr/bin/node dist/index.js >> /home/opc/oracle-service/logs/cron.log 2>&1

# 9:00 AM PST = 17:00 UTC
0 17 * * 1-5 cd /home/opc/oracle-service && /usr/bin/node dist/index.js >> /home/opc/oracle-service/logs/cron.log 2>&1

# 12:00 PM PST = 20:00 UTC
0 20 * * 1-5 cd /home/opc/oracle-service && /usr/bin/node dist/index.js >> /home/opc/oracle-service/logs/cron.log 2>&1
```

Create logs directory:
```bash
mkdir -p logs
```

## Resource Limits & Fail-Safes

The service automatically monitors and enforces Oracle Cloud Always Free tier limits:

- **CPU**: Stops if usage > 80%
- **Memory**: Stops if usage > 900 MB
- **Network**: Tracks daily/monthly egress, stops if approaching 10 TB/month
- **Execution Time**: Auto-kills after 2 hours

## Monitoring

Check logs:
```bash
tail -f logs/cron.log
```

Check resource usage:
```bash
# CPU and Memory
top

# Disk space
df -h

# Network usage
cat data/network-usage.json
```

## Manual Run

```bash
cd ~/oracle-service
npm start
```

## Troubleshooting

### Service fails to start
- Check database connection: `echo $NEON_DATABASE_URL`
- Check Node.js version: `node --version` (should be >= 18)
- Check logs: `tail -f logs/cron.log`

### Out of memory
- Reduce BATCH_SIZE in `src/index.ts`
- Increase DELAY_BETWEEN_BATCHES

### Network rate limiting
- Increase DELAY_BETWEEN_STOCKS and DELAY_BETWEEN_BATCHES
- Check Yahoo Finance rate limits

## Database Schema

Results are stored in `trading_analysis_results` table:
- `ticker`: Stock symbol
- `action`: BUY, SELL, or HOLD
- `confidence`: 0-100
- `reason`: Explanation
- `analyzed_at`: Timestamp

