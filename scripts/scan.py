#!/usr/bin/env python3
import sys
import os
import json
import time
import pandas as pd
import yfinance as yf
from datetime import datetime

# Path setup
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
CSV_PATH = os.path.join(BASE_DIR, 'python-service', 'vanguard.csv')
CACHE_FILE = os.path.join(DATA_DIR, 'screener_cache.json')

if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)

def load_tickers():
    try:
        with open(CSV_PATH, 'r', encoding='utf-8') as f:
            lines = f.read().splitlines()
        # Filter valid tickers - allow letters only, no slashes
        tickers = [l.strip() for l in lines if l.strip() and '/' not in l.strip() and l.strip().replace(' ', '').isalpha()]
        return sorted(list(set(tickers)))[:100]  # Limit to 100 for speed
    except Exception as e:
        print(f"Warning: Could not load tickers from {CSV_PATH}: {e}")
        return ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA']

def main():
    start_time = time.time()
    
    # Parse arguments
    subset = None
    if len(sys.argv) > 1:
        try:
            subset = int(sys.argv[1])
        except ValueError:
            pass

    all_tickers = load_tickers()
    if subset:
        tickers = all_tickers[:subset]
    else:
        # Limit to first 100 for testing speed if running full?
        # User said "stocks aren't getting pulled", so maybe run all or plenty.
        # But for robustness let's just run all requested.
        tickers = all_tickers

    # If list is empty
    if not tickers:
        print("No tickers found.")
        sys.exit(0)

    print(f"\n🔍 TickSignals Scanner (Python)")
    print(f"   {len(tickers)} tickers to scan ({len(all_tickers)} total in CSV)\n")

    stocks = []
    
    # Batch processing
    BATCH_SIZE = 50
    total_processed = 0

    for i in range(0, len(tickers), BATCH_SIZE):
        batch = tickers[i:i+BATCH_SIZE]
        print(f"   Processing batch {i} to {min(i+BATCH_SIZE, len(tickers))}...")

        try:
            # Download 1 year data to calculate 52w high/low
            # threads=True is default but let's be explicit
            data = yf.download(batch, period="1y", interval="1d", progress=False, group_by='ticker', auto_adjust=True, threads=True)
            
            current_date_iso = datetime.now().isoformat()

            for symbol in batch:
                try:
                    df = None
                    try:
                        # Try accessing as MultiIndex
                        df = data[symbol]
                    except KeyError:
                        # If failed, check if it's the only ticker and non-MultiIndex
                        if len(batch) == 1 and not isinstance(data.columns, pd.MultiIndex):
                            df = data
                        else:
                            # Symbol data missing
                            continue
                    
                    if df is None or df.empty:
                        continue
                        
                    # Get last valid row for current price
                    last_row = df.iloc[-1]
                    
                    # Check if 'Close' is NaN
                    if pd.isna(last_row['Close']):
                        continue
                        
                    current_price = float(last_row['Close'])
                    volume = int(last_row['Volume']) if not pd.isna(last_row['Volume']) else 0
                    
                    # Calculate 52-week stats
                    # 'High' and 'Low' columns
                    high_52 = float(df['High'].max())
                    low_52 = float(df['Low'].min())
                    
                    stock_data = {
                        "ticker": symbol,
                        "price": current_price,
                        "fifty_two_week_high": high_52,
                        "fifty_two_week_low": low_52,
                        "market_cap": None, 
                        "pe_ratio": None,
                        "company_name": symbol, # Fallback to symbol
                        "updated_at": current_date_iso
                    }
                    stocks.append(stock_data)

                except Exception as e:
                    # print(f"Error processing {symbol}: {e}")
                    pass
            
            total_processed += len(batch)
            print(f"   Progress: {len(stocks)} valid stocks so far")
            
        except Exception as e:
            print(f"   Batch error: {e}")

    # Sort by price descending (like original script)
    stocks.sort(key=lambda x: x.get('price', 0), reverse=True)

    duration = round(time.time() - start_time, 1)

    output = {
        "stocks": stocks,
        "totalStocks": len(stocks),
        "lastUpdated": datetime.now().isoformat(),
        "scanDuration": str(duration)
    }

    try:
        with open(CACHE_FILE, 'w') as f:
            json.dump(output, f, indent=2)
        
        print(f"\n✅ Scan complete!")
        print(f"   {len(stocks)} stocks saved to {CACHE_FILE}")
        print(f"   Duration: {duration}s\n")
        
    except Exception as e:
        print(f"❌ Error writing cache file: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
