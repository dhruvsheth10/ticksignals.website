import type { NextApiRequest, NextApiResponse } from 'next';
import { initScreenerTable, getScanMetadata } from '../../lib/db';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await initScreenerTable();
    const meta = await getScanMetadata();

    res.status(200).json({
      totalStocks: meta.count,
      lastUpdated: meta.lastUpdated,
    });
  } catch (error) {
    console.error('Stats fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
}