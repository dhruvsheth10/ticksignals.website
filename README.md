# TickSignals

TickSignals now treats the TypeScript daily swing engine in `lib/trading-engine.ts` as the canonical strategy engine.

## Strategy Direction

- Horizon: daily swing trading
- Universe: two-stage watchlist built from `pages/api/screener.ts` via `lib/daily-swing-universe.ts`
- Entries and exits: one live engine, one signal model
- Research loop: daily backtest script with SPY benchmark and holdout split

## Canonical Flow

1. `pages/api/screener.ts` refreshes `screener_cache` and rebuilds `monitored_prospects`.
2. `lib/daily-swing-universe.ts` scores candidates in two stages:
   - stage 1: quality, leverage, liquidity, and 52-week regime
   - stage 2: the live daily swing signal engine
3. `lib/trading-engine.ts` trades only from that aligned watchlist.
4. `lib/snapshot-service.ts` snapshots holdings plus the aligned watchlist.

## Free Data Policy

- Daily candles: Yahoo Finance chart endpoint first, then Finnhub / Alpha Vantage / EODHD fallbacks.
- Intraday snapshots: Yahoo 5-minute bars first, then Finnhub 5-minute bars, then a daily proxy as a last resort.
- The project still uses free and mostly unofficial retail-grade data, so signal research should be judged before paying for better feeds.

## Research Harness

Run the daily backtest:

```bash
npm run backtest:daily
```

Optional custom universe:

```bash
npm run backtest:daily -- --tickers=AAPL,MSFT,NVDA
```

Latest results are written to:

```text
data/backtests/daily-swing-latest.json
```
