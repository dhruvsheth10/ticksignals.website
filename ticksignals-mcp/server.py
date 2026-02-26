import os
import sys
import json
import warnings

import httpx
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

warnings.filterwarnings("ignore")

PARENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

env_local = os.path.join(PARENT_DIR, ".env.local")
env_default = os.path.join(PARENT_DIR, ".env")
load_dotenv(env_local)
load_dotenv(env_default)

TURSO_URL = os.environ["TURSO_DATABASE_URL"]
TURSO_TOKEN = os.environ["TURSO_AUTH_TOKEN"]
TURSO_HTTP_URL = TURSO_URL.replace("libsql://", "https://")

sys.path.insert(0, os.path.join(PARENT_DIR, "python-service"))

mcp = FastMCP(
    "TickSignals",
    instructions="MCP server for TickSignals quantitative trading platform. "
    "Provides read-only Turso database access and Prophet forecasting tools.",
)


def _execute_sql(sql: str) -> tuple[list[str], list[list]]:
    payload = {
        "requests": [
            {"type": "execute", "stmt": {"sql": sql}},
            {"type": "close"},
        ]
    }
    resp = httpx.post(
        f"{TURSO_HTTP_URL}/v2/pipeline",
        headers={"Authorization": f"Bearer {TURSO_TOKEN}", "Content-Type": "application/json"},
        json=payload,
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()

    result = body["results"][0]
    if result["type"] == "error":
        raise RuntimeError(result["error"]["message"])

    cols = [c["name"] for c in result["response"]["result"]["cols"]]
    raw_rows = result["response"]["result"]["rows"]
    rows = [[cell.get("value") for cell in row] for row in raw_rows]
    return cols, rows


# ── Tool 1: query_turso_db ──────────────────────────────────────────────────

@mcp.tool()
def query_turso_db(sql_query: str) -> str:
    """Execute a read-only SQL query against the TickSignals Turso database.

    Use this to inspect portfolio state, holdings, transactions, trading analysis
    results, cycle logs, and portfolio snapshots. Only SELECT statements are
    permitted. The complete schema includes:

    Tables:
      - portfolio_status (id, cash_balance, total_equity, total_value, last_updated)
      - portfolio_holdings (ticker PK, shares, avg_cost, current_price, market_value,
        return_pct, last_updated, opened_at, high_water_mark, partial_sells, atr)
      - portfolio_transactions (id, date, ticker, type, shares, price, total_amount, notes)
      - portfolio_history (id, date UNIQUE, total_value, cash_balance, equity_value, day_change_pct)
      - portfolio_snapshots (id, timestamp, total_value, cash_balance, equity_value)
      - trading_analysis_results (id, ticker, analyzed_at, action, confidence, reason,
        sentiment_score, sentiment_confidence, rsi, macd_histogram, volume_ratio,
        price_change_pct, sma50, sma200)
      - trading_cycle_log (id, cycle_type, ran_at, summary)
      - daily_snapshots (id, ticker, snapshot_at, interval_type, open, high, low,
        close, volume, vwap, rvol)
      - intraday_holdings (ticker, bar_time PK(ticker,bar_time), open, high, low,
        close, volume, vwap)

    Args:
        sql_query: A SELECT SQL statement.
    """
    normalized = sql_query.strip().rstrip(";").strip()
    first_keyword = normalized.split()[0].upper() if normalized else ""

    if first_keyword != "SELECT":
        return json.dumps(
            {"error": "Only SELECT queries are allowed. Received: " + first_keyword},
            indent=2,
        )

    blocked = {"INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "REPLACE", "ATTACH", "DETACH", "PRAGMA"}
    upper = normalized.upper()
    for word in blocked:
        if word in upper:
            return json.dumps(
                {"error": f"Blocked keyword detected: {word}. Read-only queries only."},
                indent=2,
            )

    try:
        columns, rows = _execute_sql(normalized)
        result = [dict(zip(columns, row)) for row in rows]
        return json.dumps({"columns": columns, "row_count": len(result), "rows": result}, indent=2, default=str)
    except Exception as e:
        return json.dumps({"error": str(e)}, indent=2)


# ── Tool 2: test_forecast_model ─────────────────────────────────────────────

@mcp.tool()
def test_forecast_model(
    ticker: str,
    changepoint_scale: float = 0.05,
    days_ahead: int = 30,
) -> str:
    """Run the Prophet forecasting model on a ticker to test parameter tuning.

    This wraps the existing generate_ticker_forecast logic from
    tick_signals_core.py but bypasses database writes. The agent can adjust
    the Prophet changepoint_prior_scale and forecast horizon to evaluate how
    parameter changes affect confidence scores and signal outputs.

    Args:
        ticker: Stock ticker symbol (e.g. AAPL, MSFT).
        changepoint_scale: Prophet changepoint_prior_scale (lower = smoother
            trend, higher = more reactive). Default 0.05.
        days_ahead: Number of days to forecast. Default 30.
    """
    try:
        import yfinance as yf
        import pandas as pd
        import numpy as np
        from datetime import datetime, timedelta
        from prophet import Prophet

        data = yf.download(ticker, period="3y", progress=False, auto_adjust=True)

        if data.empty or len(data) < 200:
            return json.dumps(
                {"error": f"Insufficient data for {ticker}. Need 200+ trading days, got {len(data)}."},
                indent=2,
            )

        from tick_signals_core import calculate_rsi, calculate_days_to_crossover

        data["SMA50"] = data["Close"].rolling(window=50).mean()
        data["SMA200"] = data["Close"].rolling(window=200).mean()
        data["RSI"] = calculate_rsi(data["Close"], period=14)

        exp12 = data["Close"].ewm(span=12, adjust=False).mean()
        exp26 = data["Close"].ewm(span=26, adjust=False).mean()
        data["MACD"] = exp12 - exp26
        data["MACD_Signal"] = data["MACD"].ewm(span=9, adjust=False).mean()
        data["MACD_Hist"] = data["MACD"] - data["MACD_Signal"]
        data["Volume_MA"] = data["Volume"].rolling(window=20).mean()

        current_gap = float(data["SMA50"].iloc[-1] - data["SMA200"].iloc[-1])
        current_price = float(data["Close"].iloc[-1])
        rsi_value = float(data["RSI"].iloc[-1])
        macd_hist = float(data["MACD_Hist"].iloc[-1])
        days_to_cross = calculate_days_to_crossover(data)

        # Prophet forecast
        df_prophet = data.reset_index()
        df_prophet = df_prophet[["Date", "Close"]].copy()
        df_prophet.columns = ["ds", "y"]
        df_prophet["ds"] = pd.to_datetime(df_prophet["ds"])
        df_prophet = df_prophet.dropna()

        forecast_result = {}

        if len(df_prophet) > 100:
            model = Prophet(
                daily_seasonality=False,
                weekly_seasonality=True,
                yearly_seasonality=True,
                changepoint_prior_scale=changepoint_scale,
            )
            model.fit(df_prophet)

            future = model.make_future_dataframe(periods=max(days_ahead, 60))
            forecast = model.predict(future)

            target_date = df_prophet["ds"].max() + timedelta(days=days_ahead)
            forecast_target = forecast[forecast["ds"] == target_date]

            if not forecast_target.empty:
                forecast_price = float(forecast_target["yhat"].iloc[0])
                forecast_lower = float(forecast_target["yhat_lower"].iloc[0])
                forecast_upper = float(forecast_target["yhat_upper"].iloc[0])
                price_change_pct = (forecast_price - current_price) / current_price

                forecast_result = {
                    "forecast_price": round(forecast_price, 2),
                    "forecast_lower": round(forecast_lower, 2),
                    "forecast_upper": round(forecast_upper, 2),
                    "price_change_pct": round(price_change_pct * 100, 2),
                }

        # Signal determination (same logic as tick_signals_core)
        signal = "NEUTRAL"
        confidence = 0
        gap_pct = abs(current_gap) / current_price * 100 if current_price > 0 else 0

        if current_gap < 0 and gap_pct < 8:
            if 25 <= rsi_value <= 70:
                if days_to_cross and days_to_cross < 90:
                    signal = "BUY_FORECAST"
                    confidence = 60
                    if 40 <= rsi_value <= 60:
                        confidence += 10
                    if macd_hist > -0.5:
                        confidence += 5
                    if days_to_cross < 30:
                        confidence += 10
                    confidence = min(confidence, 85)
        elif current_gap > 0 and gap_pct < 8:
            if 30 <= rsi_value <= 75:
                if days_to_cross and days_to_cross < 90:
                    signal = "SELL_FORECAST"
                    confidence = 60
                    if rsi_value > 65:
                        confidence += 10
                    if macd_hist < 0:
                        confidence += 5
                    if days_to_cross < 30:
                        confidence += 10
                    confidence = min(confidence, 85)

        # Price history for context
        price_30d_ago = float(data["Close"].iloc[-30]) if len(data) >= 30 else None
        price_roc = round(((current_price - price_30d_ago) / price_30d_ago) * 100, 2) if price_30d_ago else None

        result = {
            "ticker": ticker,
            "parameters": {
                "changepoint_prior_scale": changepoint_scale,
                "days_ahead": days_ahead,
            },
            "current_state": {
                "price": round(current_price, 2),
                "sma50": round(float(data["SMA50"].iloc[-1]), 2),
                "sma200": round(float(data["SMA200"].iloc[-1]), 2),
                "sma_gap_pct": round(gap_pct, 2),
                "rsi": round(rsi_value, 2),
                "macd_histogram": round(macd_hist, 4),
                "days_to_crossover": round(days_to_cross, 1) if days_to_cross else None,
                "price_roc_30d": price_roc,
            },
            "forecast": forecast_result if forecast_result else "No forecast data for target date",
            "signal": signal,
            "confidence": confidence,
        }

        return json.dumps(result, indent=2, default=str)

    except Exception as e:
        return json.dumps({"error": str(e)}, indent=2)


if __name__ == "__main__":
    mcp.run(transport="stdio")
