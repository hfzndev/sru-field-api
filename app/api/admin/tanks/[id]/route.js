import { conflict, idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { parse, tankSchema } from '@/lib/validation';
import { serializeTank } from '../route.js';

export const dynamic = 'force-dynamic';

export async function PUT(request, context) {
  const id = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Tangki tidak ditemukan');

    const existing = db.prepare('SELECT * FROM tanks WHERE id = ?').get(id);
    if (!existing) return notFound('Tangki tidak ditemukan');

    const parsed = parse(tankSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const { code, name, heightMm, dcsTag, isActive } = parsed.data;
    const clash = db.prepare('SELECT id FROM tanks WHERE code = ? AND id != ?').get(code, id);
    if (clash) return conflict('DUPLICATE_CODE', `Kode tangki "${code}" sudah dipakai`);

    db.transaction(() => {
      db.prepare(`
        UPDATE tanks SET code = ?, name = ?, height_mm = ?, dcs_tag = ?, is_active = ? WHERE id = ?
      `).run(code, name, heightMm, dcsTag, isActive ? 1 : 0, id);

      stampMaster(db, 'tanks', id);
      recordAction(db, username, {
        action: 'UPDATE', entity: 'tank', entityId: id,
        // Height changes are worth spelling out: every stored level was
        // computed from it, so a correction here changes what past readings mean.
        detail: existing.height_mm !== heightMm
          ? `${code}: tinggi ${existing.height_mm} → ${heightMm} mm`
          : code,
      });
    })();

    return Response.json({ tank: serializeTank(db.prepare('SELECT * FROM tanks WHERE id = ?').get(id)) });
  });
}

/**
 * DELETE is a soft delete (doc 05 §3): readings reference tanks, and history
 * must stay readable. The row keeps its stamp so the handsets learn it is gone.
 */
export async function DELETE(request, context) {
  const id = await idParam(context);

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Tangki tidak ditemukan');

    const existing = db.prepare('SELECT * FROM tanks WHERE id = ?').get(id);
    if (!existing) return notFound('Tangki tidak ditemukan');

    db.transaction(() => {
      db.prepare('UPDATE tanks SET is_active = 0 WHERE id = ?').run(id);
      stampMaster(db, 'tanks', id);
      recordAction(db, username, {
        action: 'DELETE', entity: 'tank', entityId: id, detail: `${existing.code} dinonaktifkan`,
      });
    })();

    return Response.json({ ok: true });
  });
}
