import { conflict, idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { contractorSchema, parse } from '@/lib/validation';
import { serializeContractor } from '../route.js';

export const dynamic = 'force-dynamic';

export async function PUT(request, context) {
  const id = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Kontraktor tidak ditemukan');

    const existing = db.prepare('SELECT * FROM contractors WHERE id = ?').get(id);
    if (!existing) return notFound('Kontraktor tidak ditemukan');

    const parsed = parse(contractorSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const { name, isActive } = parsed.data;
    if (db.prepare('SELECT id FROM contractors WHERE name = ? AND id != ?').get(name, id)) {
      return conflict('DUPLICATE_NAME', `Kontraktor "${name}" sudah terdaftar`);
    }

    db.transaction(() => {
      db.prepare('UPDATE contractors SET name = ?, is_active = ? WHERE id = ?')
        .run(name, isActive ? 1 : 0, id);
      stampMaster(db, 'contractors', id);
      recordAction(db, username, {
        action: 'UPDATE', entity: 'contractor', entityId: id,
        detail: existing.name !== name ? `${existing.name} → ${name}` : name,
      });
    })();

    return Response.json({
      contractor: serializeContractor(db.prepare('SELECT * FROM contractors WHERE id = ?').get(id)),
    });
  });
}

/**
 * Soft delete. Activity records store the contractor name as text, so past work
 * stays readable; only the quick-pick list on the handsets loses the entry.
 */
export async function DELETE(request, context) {
  const id = await idParam(context);

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Kontraktor tidak ditemukan');

    const existing = db.prepare('SELECT * FROM contractors WHERE id = ?').get(id);
    if (!existing) return notFound('Kontraktor tidak ditemukan');

    db.transaction(() => {
      db.prepare('UPDATE contractors SET is_active = 0 WHERE id = ?').run(id);
      stampMaster(db, 'contractors', id);
      recordAction(db, username, {
        action: 'DELETE', entity: 'contractor', entityId: id, detail: `${existing.name} dinonaktifkan`,
      });
    })();

    return Response.json({ ok: true });
  });
}
