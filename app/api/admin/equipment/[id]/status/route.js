import { conflict, idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { STATUS_DISPLAY, equipmentStatusSchema, parse } from '@/lib/validation';
import { serializeEquipment } from '../../route.js';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/equipment/:id/status — doc 06 §6, doc 02 §1.2.
 *
 * Status never changes without a written reason. The pairing of state and
 * justification in equipment_status_log is the whole point: "On Repair" with no
 * explanation tells a later shift nothing about what is wrong or who to ask.
 */
export async function POST(request, context) {
  const id = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Equipment tidak ditemukan');

    const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
    if (!existing) return notFound('Equipment tidak ditemukan');

    // A blank description fails here, before anything is written (doc 10 §2.5).
    const parsed = parse(equipmentStatusSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const { status, description, changedByName } = parsed.data;

    // Re-asserting the current status is rejected rather than silently logged:
    // it would add a history entry recording no change at all.
    if (existing.status === status) {
      // Display label, not the storage code — an admin should never be shown
      // the raw enum (doc 02 §1.2).
      return conflict('STATUS_UNCHANGED', `Equipment sudah berstatus ${STATUS_DISPLAY[status]}`);
    }

    db.transaction(() => {
      db.prepare(`
        INSERT INTO equipment_status_log
          (equipment_id, old_status, new_status, description, changed_by_name, received_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(id, existing.status, status, description, changedByName || username);

      db.prepare("UPDATE equipment SET status = ?, status_changed_at = datetime('now') WHERE id = ?")
        .run(status, id);

      stampMaster(db, 'equipment', id);
      recordAction(db, username, {
        action: 'STATUS', entity: 'equipment', entityId: id,
        detail: `${existing.tag_number}: ${existing.status} → ${status}`,
      });
    })();

    return Response.json({
      equipment: serializeEquipment(db.prepare('SELECT * FROM equipment WHERE id = ?').get(id)),
    });
  });
}

/** GET — the status history for one item. */
export async function GET(request, context) {
  const id = await idParam(context);

  return withAdmin(request, (db) => {
    if (!id) return notFound('Equipment tidak ditemukan');
    const history = db.prepare(`
      -- id breaks ties: changed_at has one-second resolution, so two changes
      -- in the same second would otherwise come back in arbitrary order.
      SELECT * FROM equipment_status_log
       WHERE equipment_id = ? ORDER BY changed_at DESC, id DESC LIMIT 200
    `).all(id).map((row) => ({
      id: row.id,
      oldStatus: row.old_status,
      newStatus: row.new_status,
      description: row.description,
      changedByName: row.changed_by_name || '',
      changedAt: row.changed_at,
    }));
    return Response.json({ history });
  });
}
