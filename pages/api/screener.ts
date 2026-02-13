import type { NextApiRequest, NextApiResponse } from 'next';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const DATA_FILE = join(process.cwd(), 'data', 'screener_cache.json');

function readCache(): { stocks: any[]; totalStocks: number; lastUpdated: string | null } {
    try {
        if (existsSync(DATA_FILE)) {
            const raw = readFileSync(DATA_FILE, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (err) {
        console.error('[Screener] Error reading cache file:', err);
    }
    return { stocks: [], totalStocks: 0, lastUpdated: null };
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    try {
        // Detect Vercel Cron (sends GET with special header)
        const isVercelCron = req.headers['x-vercel-cron'] === '1'
            || req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;

        if (req.method === 'GET' && !isVercelCron) {
            // Normal GET: return cached data from JSON file
            const cache = readCache();
            return res.status(200).json(cache);
        }

        // POST (manual trigger) or GET from Vercel Cron → run scan
        if (req.method === 'POST' || isVercelCron) {
            console.log('[Screener] Triggering scan...');
            const startTime = Date.now();

            const scriptPath = join(process.cwd(), 'scripts', 'scan.py');

            try {
                // Check if script exists
                if (!existsSync(scriptPath)) {
                    throw new Error(`Script not found at ${scriptPath}`);
                }

                const output = execSync(`python3 "${scriptPath}"`, {
                    timeout: 300000, // 5 min timeout
                    encoding: 'utf-8',
                    cwd: process.cwd(),
                    env: { ...process.env },
                });

                console.log('[Screener] Scan output:', output);

                const cache = readCache();
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);

                return res.status(200).json({
                    success: true,
                    processed: cache.totalStocks,
                    total: cache.totalStocks,
                    durationSeconds: duration,
                    message: `${cache.totalStocks} stocks scanned in ${duration}s`,
                });
            } catch (execErr: any) {
                console.error('[Screener] Scan failed:', execErr.message);

                // Return the cached data even if scan fails
                const cache = readCache();

                return res.status(500).json({
                    error: 'Scan execution failed',
                    details: execErr.message,
                    cached: cache.totalStocks,
                });
            }
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (error: any) {
        console.error('Screener API error:', error);
        return res.status(500).json({
            error: 'Screener failed',
            details: error.message,
        });
    }
}

// Allow long-running scans
export const config = {
    api: {
        responseLimit: false,
        bodyParser: {
            sizeLimit: '1mb',
        },
    },
    maxDuration: 300,
};
