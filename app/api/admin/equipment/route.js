import { conflict, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { toIso } from '@/lib/time';
import { equipmentSchema, parse } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export function serializeEquipment(row) {
  return {
    id: row.id,
    tagNumber: row.tag_number,
    name: row.name,
    unitKey: row.unit_key || '',
    location: row.location || '',
    status: row.status,
    statusChangedAt: toIso(row.status_changed_at),
    isActive: row.is_active === 1,
  };
}

export async function GET(request) {
  return withAdmin(request, (db) => Response.json({
    equipment: db.prepare('SELECT * FROM equipment ORDER BY tag_number').all().map(serializeEquipment),
  }));
}

export async function POST(request) {
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    const parsed = parse(equipmentSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const { tagNumber, name, unitKey, location, status, isActive } = parsed.data;
    if (db.prepare('SELECT id FROM equipment WHERE tag_number = ?').get(tagNumber)) {
      return conflict('DUPLICATE_TAG', `Tag "${tagNumber}" sudah dipakai`);
    }

    const id = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO equipment (tag_number, name, unit_key, location, status, status_changed_at, is_active)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
      `).run(tagNumber, name, unitKey, location, status, isActive ? 1 : 0);

      stampMaster(db, 'equipment', info.lastInsertRowid);
      recordAction(db, username, {
        action: 'CREATE', entity: 'equipment', entityId: Number(info.lastInsertRowid),
        detail: `${tagNumber} — ${name}`,
      });
      return Number(info.lastInsertRowid);
    })();

    const row = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
    return Response.json({ equipment: serializeEquipment(row) }, { status: 201 });
  });
}
