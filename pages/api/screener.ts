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
            const { subset } = req.body || {};
            const subsetArg = subset ? ` ${subset}` : '';

            console.log(`[Screener] Triggering scan${subset ? ` (subset: ${subset})` : ''}...`);

            const startTime = Date.now();

            try {
                // Run the scan script as a child process (outside Next.js context)
                const scriptPath = join(process.cwd(), 'scripts', 'scan.js');
                const output = execSync(`node ${scriptPath}${subsetArg}`, {
                    timeout: 300000, // 5 min timeout
                    encoding: 'utf-8',
                    cwd: process.cwd(),
                    env: { ...process.env, NODE_ENV: 'production' },
                });

                console.log('[Screener] Scan output:', output);

                // Read the results
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
                console.error('[Screener] Scan script error:', execErr.message);
                if (execErr.stdout) console.log('[Screener] stdout:', execErr.stdout);
                if (execErr.stderr) console.error('[Screener] stderr:', execErr.stderr);

                return res.status(500).json({
                    error: 'Scan failed',
                    details: execErr.message,
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
