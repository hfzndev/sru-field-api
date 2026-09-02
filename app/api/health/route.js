import { getDb } from '@/lib/db';

// Health must reflect the live process, never a cached render.
export const dynamic = 'force-dynamic';

/**
 * GET /api/health — dok 06 §3.
 * Polled by the VPS health cron every 6h and allowlisted at the CF edge,
 * so it must stay cheap and dependency-free beyond a single DB round trip.
 */
export async function GET() {
  try {
    getDb().prepare('SELECT 1').get();
    return Response.json({ status: 'healthy', database: 'connected' });
  } catch (err) {
    console.error('health check failed:', err);
    return Response.json({ status: 'unhealthy', database: 'disconnected' }, { status: 500 });
  }
}
