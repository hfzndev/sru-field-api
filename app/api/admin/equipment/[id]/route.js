import { conflict, idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { equipmentSchema, parse } from '@/lib/validation';
import { serializeEquipment } from '../route.js';

export const dynamic = 'force-dynamic';

export async function PUT(request, context) {
  const id = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Equipment tidak ditemukan');

    const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
    if (!existing) return notFound('Equipment tidak ditemukan');

    const parsed = parse(equipmentSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    // `status` is intentionally not destructured — see the note on the update below.
    const { tagNumber, name, unitKey, location, isActive } = parsed.data;
    if (db.prepare('SELECT id FROM equipment WHERE tag_number = ? AND id != ?').get(tagNumber, id)) {
      return conflict('DUPLICATE_TAG', `Tag "${tagNumber}" sudah dipakai`);
    }

    // Status is deliberately not editable here — it has its own endpoint that
    // demands a reason and writes equipment_status_log. Allowing a silent
    // change through the general update would put a hole in that history.
    db.transaction(() => {
      db.prepare(`
        UPDATE equipment SET tag_number = ?, name = ?, unit_key = ?, location = ?, is_active = ?
         WHERE id = ?
      `).run(tagNumber, name, unitKey, location, isActive ? 1 : 0, id);

      stampMaster(db, 'equipment', id);
      recordAction(db, username, {
        action: 'UPDATE', entity: 'equipment', entityId: id, detail: `${tagNumber} — ${name}`,
      });
    })();

    return Response.json({
      equipment: serializeEquipment(db.prepare('SELECT * FROM equipment WHERE id = ?').get(id)),
    });
  });
}

export async function DELETE(request, context) {
  const id = await idParam(context);

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Equipment tidak ditemukan');

    const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
    if (!existing) return notFound('Equipment tidak ditemukan');

    db.transaction(() => {
      db.prepare('UPDATE equipment SET is_active = 0 WHERE id = ?').run(id);
      stampMaster(db, 'equipment', id);
      recordAction(db, username, {
        action: 'DELETE', entity: 'equipment', entityId: id,
        detail: `${existing.tag_number} dinonaktifkan`,
      });
    })();

    return Response.json({ ok: true });
  });
}
