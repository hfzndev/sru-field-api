import { withAdmin } from '@/lib/admin';
import { toIso } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/actions — doc 06 §6, doc 08 §9.
 *
 * The audit trail. Append-only by construction: nothing in this codebase
 * updates or deletes an admin_actions row.
 */
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 100, 1), 1000);

  return withAdmin(request, (db) => {
    const actions = db.prepare(`
      SELECT * FROM admin_actions ORDER BY id DESC LIMIT ?
    `).all(limit).map((a) => ({
      id: a.id,
      adminUsername: a.admin_username,
      action: a.action,
      entity: a.entity,
      entityId: a.entity_id,
      detail: a.detail || '',
      at: toIso(a.at),
    }));

    return Response.json({ actions });
  });
}
