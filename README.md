# TickSignals

An automated quantitative swing trading system and portfolio tracker built on Next.js. It runs a daily algorithmic strategy, manages a paper-traded portfolio, and provides a web interface for monitoring performance and screening stocks.

## Architecture & Stack

- **Frontend**: Next.js 14 (Pages Router), React, Tailwind CSS, Recharts (tabular-nums, dark theme).
- **Backend**: Vercel Serverless Functions (`/api/*`).
- **Databases**:
  - **Turso (LibSQL)**: Primary datastore for portfolio state, transaction history, active holdings, and trading logs.
  - **Neon (Postgres)**: Secondary datastore for the stock screener cache and monitored prospects universe.
- **Execution**: Trading cycles (`OPEN`, `MID`, `CLOSE`) are triggered by cron jobs running on an external Oracle VM, hitting secured API endpoints.
- **Market Data**: Free-tier cascades. Prioritizes Yahoo Finance (chart/options endpoints), falling back to Finnhub, Alpha Vantage, and EODHD for candles, quotes, and fundamentals.

## Trading Engine (`lib/trading-engine.ts`)

The core algorithmic logic focuses on short-to-medium-term daily swing trades (hold time: days to weeks).

- **Screening**: `api/screener.ts` builds a universe of high-quality, liquid equities based on fundamentals (Market Cap, P/E, ROE, D/E).
- **Technicals**: Calculates RSI, MACD, Bollinger Bands, ATR, ADX, StochRSI, VWAP, and ROC10 (Rate of Change).
- **Relative Strength**: Evaluates tickers against the SPY 20-day return to avoid buying weak stocks in strong markets or strong stocks in crashing markets.
- **Position Sizing**: Conviction-tiered sizing. High-confidence setups allocate larger chunks of the portfolio, capped by concentration limits and an ATR-based risk budget. Target portfolio capacity is ~8 positions.
- **Risk Management**: Dynamic trailing stops (1.5x - 2.4x ATR depending on profit level), gap protection, and time-based aging exits for stagnant positions.

## Local Development

Create a `.env.local` file with the necessary database and API keys (Turso, Neon, Finnhub, Alpha Vantage, Gemini for sentiment analysis, etc).

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev
```

## Backtesting

The project includes a local research harness to test the strategy engine against historical data, using SPY as a benchmark.

Run the daily backtest on the default universe:
```bash
npm run backtest:daily
```

Run on a custom ticker list:
```bash
npm run backtest:daily -- --tickers=AAPL,MSFT,NVDA
```

Results are dumped to `data/backtests/daily-swing-latest.json`.
