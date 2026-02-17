from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import json
import sys
from io import StringIO
import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import re
from sqlalchemy import create_engine, text
import os

app = Flask(__name__)
CORS(app)


def get_db_connection():
    """Creates a SQLAlchemy engine for PostgreSQL connection"""
    try:
        db_url = os.getenv('DATABASE_URL')
        if not db_url:
            print("Warning: No DATABASE_URL found")
            return None
        engine = create_engine(db_url)
        return engine
    except Exception as e:
        print(f"Database connection error: {e}")
        return None

def stream_log(message):
    """Helper to format SSE messages"""
    return f"data: {json.dumps({'log': message})}\n\n"

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({"status": "healthy", "service": "ticksignals-python"})

@app.route('/scan/mass', methods=['POST'])
def mass_scan():
    """Run mass signal generation for all tickers"""
    def generate():
        try:
            yield stream_log("Starting Mass Run...")
            yield stream_log("Connecting to database...")
            
            engine = get_db_connection()
            if not engine:
                yield stream_log("Failed to connect to database")
                yield f"data: {json.dumps({'complete': True, 'error': True})}\n\n"
                return
            
            # Get list of tickers from database or use default
            with engine.connect() as conn:
                result = conn.execute(text('SELECT DISTINCT "Ticker" FROM all_signals ORDER BY "Ticker" LIMIT 100'))
                tickers = [row[0] for row in result.fetchall()]
            
            if not tickers:
                # Fallback to reading from CSV if needed
                try:
                    ticker_df = pd.read_csv('vanguard.csv')
                    tickers = ticker_df.iloc[:, 0].tolist()[:100]  # Limit to 100 for speed
                except:
                    yield stream_log("No tickers found")
                    yield f"data: {json.dumps({'complete': True, 'error': True})}\n\n"
                    return
            
            yield stream_log(f"Processing {len(tickers)} tickers...")
            
            # Import and run your actual mass processing logic
            from tick_signals_core import process_ticker_signals
            
            signals_generated = 0
            for i, ticker in enumerate(tickers, 1):
                yield stream_log(f"[{i}/{len(tickers)}] Processing {ticker}...")
                
                try:
                    result = process_ticker_signals(ticker, engine)
                    if result:
                        signals_generated += result['signal_count']
                        yield stream_log(f"   {ticker}: {result['signal_count']} signals")
                    else:
                        yield stream_log(f"   {ticker}: No data")
                except Exception as e:
                    yield stream_log(f"   {ticker}: Error - {str(e)}")
            
            yield stream_log("\nMass Run Complete!")
            yield stream_log(f"Generated {signals_generated} total signals")
            yield stream_log(f"All data synced to cloud database")
            
            yield f"data: {json.dumps({'complete': True, 'signals': signals_generated})}\n\n"
            
        except Exception as e:
            yield stream_log(f"❌ Critical Error: {str(e)}")
            yield f"data: {json.dumps({'complete': True, 'error': True})}\n\n"
    
    return Response(generate(), mimetype='text/event-stream')

@app.route('/scan/forecast', methods=['POST'])
def forecast_scan():
    """Run forecast generation for all tickers"""
    def generate():
        try:
            yield stream_log("Starting Forecast Run...")
            yield stream_log("Connecting to database...")
            
            engine = get_db_connection()
            if not engine:
                yield stream_log("Failed to connect to database")
                yield f"data: {json.dumps({'complete': True, 'error': True})}\n\n"
                return
            
            # Get list of tickers
            with engine.connect() as conn:
                result = conn.execute(text('SELECT DISTINCT "Ticker" FROM all_signals ORDER BY "Ticker" LIMIT 100'))
                tickers = [row[0] for row in result.fetchall()]
            
            if not tickers:
                try:
                    ticker_df = pd.read_csv('vanguard.csv')
                    tickers = ticker_df.iloc[:, 0].tolist()[:100]
                except:
                    yield stream_log("No tickers found")
                    yield f"data: {json.dumps({'complete': True, 'error': True})}\n\n"
                    return
            
            yield stream_log(f"Analyzing {len(tickers)} tickers for forecasts...")
            
            # Import and run your forecast logic
            from tick_signals_core import generate_ticker_forecast
            
            forecasts_generated = 0
            for i, ticker in enumerate(tickers, 1):
                yield stream_log(f"[{i}/{len(tickers)}] Analyzing {ticker}...")
                
                try:
                    result = generate_ticker_forecast(ticker, engine)
                    if result and result['has_forecast']:
                        forecasts_generated += 1
                        yield stream_log(f"   {ticker}: {result['signal']} ({result['confidence']}%)")
                    else:
                        yield stream_log(f"   {ticker}: Neutral")
                except Exception as e:
                    yield stream_log(f"   {ticker}: Error - {str(e)}")
            
            yield stream_log("\nForecast Run Complete!")
            yield stream_log(f"Generated {forecasts_generated} forecast signals")
            yield stream_log(f"All data synced to cloud database")
            
            yield f"data: {json.dumps({'complete': True, 'forecasts': forecasts_generated})}\n\n"
            
        except Exception as e:
            yield stream_log(f"Critical Error: {str(e)}")
            yield f"data: {json.dumps({'complete': True, 'error': True})}\n\n"
    
    return Response(generate(), mimetype='text/event-stream')

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port)