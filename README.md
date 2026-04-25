# TickSignals

An easy way to check up to date information on NYSE traded stocks, as well as have advanced filters for filtering stocks on many different parameters. 

I also coded a Live Portfolio section, which is where a algorothhim uses this data to autonomously make trades and hopefully make some profit! (Still in early development so theres a lot to learn before it could make stable gains)

## Architecture & Stack

- **Frontend**: Next.js 14 (Pages Router), React, Tailwind CSS, Recharts (tabular-nums, dark theme).
- **Backend**: Vercel Serverless Functions
- **Databases**:
  - **Turso (LibSQL)**: Primary datastore for portfolio state, transaction history, active holdings, and trading logs.
  - **Neon (Postgres)**: Secondary datastore for the stock screener cache and monitored prospects universe.
- **Execution**: Trading cycles are triggered by cron jobs running on an external Oracle VM.
- **Market Data**: Prioritizes Yahoo Finance (chart/options endpoints), falling back to Finnhub, Alpha Vantage, and EODHD for candles, quotes, and fundamentals.

## Trading Engine Details

The core algorithmic logic focuses on short-to-medium-term daily swing trades (hold time: days to weeks).

- **Screening**: builds a universe of high-quality, liquid equities based on fundamentals (Market Cap, P/E, ROE, D/E).
- **Technicals**: Calculates RSI, MACD, Bollinger Bands, ATR, ADX, StochRSI, VWAP, and ROC10.
- **Relative Strength**: Evaluates tickers against the SPY 20-day return to avoid buying weak stocks in strong markets or strong stocks in crashing markets.
- **Position Sizing**: Confidence-tiered sizing. High-confidence setups allocate larger chunks of the portfolio, capped by concentration limits and an ATR-based risk budget. Target portfolio capacity is ideally ~8 positions.
- **Risk Management**: Dynamic trailing stops (1.5x - 2.4x ATR depending on profit level), gap protection, and time-based aging exits for stale positions.


Thanks for reading!