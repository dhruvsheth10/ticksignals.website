# Installation Guide - Oracle Cloud VM

## Quick Start

### Step 1: Copy Files to Oracle VM

On your **local machine**:

```bash
cd /Users/dhruvsheth/ticksignals.website

# Create tarball with service and vanguard.csv
tar -czf oracle-service.tar.gz oracle-service/ python-service/vanguard.csv

# Copy to Oracle VM (replace with your actual IP if different)
scp oracle-service.tar.gz opc@146.235.235.140:~/
```

### Step 2: SSH into Oracle VM

```bash
ssh opc@146.235.235.140
```

### Step 3: Extract and Setup

On the **Oracle VM**:

```bash
# Extract files
cd ~
tar -xzf oracle-service.tar.gz
cd oracle-service

# Copy vanguard.csv to oracle-service directory
cp ~/vanguard.csv . 2>/dev/null || echo "vanguard.csv already in place"

# Make setup script executable
chmod +x setup.sh

# Run setup
./setup.sh
```

### Step 4: Configure Database

```bash
# Edit .env file
nano .env
```

Add your database connection string:
```
NEON_DATABASE_URL=postgresql://user:password@host:port/database
```

Save and exit (Ctrl+X, then Y, then Enter)

### Step 5: Test Run

```bash
# Test the service (will analyze all stocks)
npm start
```

This will take 30-60 minutes for ~1500 stocks. You can stop it with Ctrl+C.

### Step 6: Setup Cron Jobs

```bash
# Edit crontab
crontab -e
```

Add these lines (PST times converted to UTC):
```
# 6:30 AM PST = 14:30 UTC (2:30 PM UTC)
30 14 * * 1-5 cd /home/opc/oracle-service && /usr/bin/node dist/index.js >> /home/opc/oracle-service/logs/cron.log 2>&1

# 9:00 AM PST = 17:00 UTC (5:00 PM UTC)
0 17 * * 1-5 cd /home/opc/oracle-service && /usr/bin/node dist/index.js >> /home/opc/oracle-service/logs/cron.log 2>&1

# 12:00 PM PST = 20:00 UTC (8:00 PM UTC)
0 20 * * 1-5 cd /home/opc/oracle-service && /usr/bin/node dist/index.js >> /home/opc/oracle-service/logs/cron.log 2>&1
```

**Note**: The `1-5` means Monday-Friday only (weekdays).

Save and exit.

### Step 7: Verify Cron Setup

```bash
# List cron jobs
crontab -l

# Check if cron service is running
sudo systemctl status crond
```

## Monitoring

### View Logs

```bash
# Real-time log viewing
tail -f logs/cron.log

# Last 100 lines
tail -n 100 logs/cron.log
```

### Check Service Status

```bash
# Check if process is running
ps aux | grep node

# Check resource usage
top
```

### View Analysis Results

Connect to your database and query:
```sql
SELECT ticker, action, confidence, reason, analyzed_at 
FROM trading_analysis_results 
ORDER BY analyzed_at DESC, confidence DESC 
LIMIT 50;
```

## Troubleshooting

### "vanguard.csv not found"
```bash
# Copy it manually
cp ~/vanguard.csv ~/oracle-service/
```

### "NEON_DATABASE_URL not set"
```bash
# Check .env file
cat .env

# If missing, create it
nano .env
# Add: NEON_DATABASE_URL=your_connection_string
```

### "Cannot connect to database"
- Verify your `NEON_DATABASE_URL` is correct
- Check if database allows connections from Oracle Cloud IPs
- Test connection: `psql $NEON_DATABASE_URL`

### Service stops unexpectedly
- Check logs: `tail -f logs/cron.log`
- Check resource limits: The service auto-stops if CPU > 80% or Memory > 900 MB
- Check network usage: `cat data/network-usage.json`

### Cron job not running
```bash
# Check cron service
sudo systemctl status crond
sudo systemctl start crond  # if not running

# Check cron logs
sudo tail -f /var/log/cron

# Verify your user's crontab
crontab -l
```

## Manual Run

To run the service manually (outside of cron):
```bash
cd ~/oracle-service
npm start
```

## Update Service

To update the service with new code:
```bash
cd ~/oracle-service
git pull  # if using git
# OR copy new files via scp

npm install  # if dependencies changed
npm run build
```

## Resource Monitoring

The service includes built-in resource monitoring:
- **CPU**: Monitors usage, stops if > 80%
- **Memory**: Monitors usage, stops if > 900 MB  
- **Network**: Tracks daily/monthly egress
- **Execution Time**: Auto-stops after 2 hours

View resource stats during run:
```bash
# The service prints stats every 10 batches
# Or check manually:
top
free -m
```

