import type { NextApiRequest, NextApiResponse } from 'next';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const DATA_FILE = join(process.cwd(), 'data', 'screener_cache.json');

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    let count = 0;
    let lastUpdated = null;

    if (existsSync(DATA_FILE)) {
      const raw = readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(raw);
      count = data.totalStocks || 0;
      lastUpdated = data.lastUpdated || null;
    }

    return res.status(200).json({
      totalStocks: count,
      lastUpdated,
    });
  } catch (error: any) {
    return res.status(500).json({
      error: 'Failed to get stats',
      details: error.message,
    });
  }
}