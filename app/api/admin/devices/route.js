import { withAdmin } from '@/lib/admin';
import { toIso } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/devices — doc 06 §6, doc 09 §4 layer 2.
 *
 * The APK is sideloaded with no store to manage updates, so this tab is the
 * only way to see which handsets are still on an old build: app_version is
 * recorded at each login.
 *
 * token_hash is never selected. Nothing outside authentication has any reason
 * to see it, and it must not end up in a browser's memory or an admin's
 * network log.
 */
export async function GET(request) {
  return withAdmin(request, (db) => {
    const devices = db.prepare(`
      SELECT t.id, t.device_name, t.app_version, t.last_seen_at, t.revoked_at, t.created_at,
             a.code, a.display_name
        FROM device_tokens t
        JOIN shift_accounts a ON a.id = t.shift_account_id
       ORDER BY (t.revoked_at IS NOT NULL), t.last_seen_at DESC, t.id DESC
       LIMIT 500
    `).all().map((d) => ({
      id: d.id,
      deviceName: d.device_name || '(tanpa nama)',
      shiftCode: d.code,
      shiftName: d.display_name,
      appVersion: d.app_version || '(tidak diketahui)',
      lastSeenAt: toIso(d.last_seen_at),
      createdAt: toIso(d.created_at),
      revoked: d.revoked_at !== null,
      revokedAt: toIso(d.revoked_at),
    }));

    return Response.json({ devices });
  });
}
