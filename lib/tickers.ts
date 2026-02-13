import fs from 'fs';
import path from 'path';

// Read and parse tickers from vanguard.csv
function loadTickersFromCSV(): string[] {
    try {
        const csvPath = path.join(process.cwd(), 'python-service', 'vanguard.csv');
        const content = fs.readFileSync(csvPath, 'utf-8');

        // Split by newlines, trim whitespace, filter out empty lines and duplicates
        const tickers = content
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .filter(ticker => {
                // Filter out invalid ticker symbols (e.g., those with slashes like BRK/B)
                return !ticker.includes('/') && /^[A-Z]+$/.test(ticker);
            });

        // Remove duplicates
        const uniqueTickers = [...new Set(tickers)];

        return uniqueTickers.sort();
    } catch (error) {
        console.error('Error loading tickers from CSV:', error);
        // Fallback to a minimal list if CSV can't be read
        return ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA'];
    }
}

export const TICKER_LIST: string[] = loadTickersFromCSV();
