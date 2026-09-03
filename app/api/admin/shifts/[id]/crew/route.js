import { idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { crewSchema, parse } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(request, context) {
  const id = await idParam(context);

  return withAdmin(request, (db) => {
    if (!id) return notFound('Akun shift tidak ditemukan');
    const crew = db.prepare(`
      SELECT id, name, sort_order, is_active FROM shift_crew
       WHERE shift_account_id = ? ORDER BY sort_order, id
    `).all(id).map((c) => ({
      id: c.id, name: c.name, sortOrder: c.sort_order, isActive: c.is_active === 1,
    }));
    return Response.json({ crew });
  });
}

/**
 * POST — adds a crew member. Until a roster exists the operator types their
 * name by hand (doc 01 §8), so this list is a convenience, not a constraint:
 * nothing validates a record's operator_name against it.
 */
export async function POST(request, context) {
  const id = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Akun shift tidak ditemukan');

    const shift = db.prepare('SELECT id, code FROM shift_accounts WHERE id = ?').get(id);
    if (!shift) return notFound('Akun shift tidak ditemukan');

    const parsed = parse(crewSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const { name, sortOrder } = parsed.data;

    const crewId = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO shift_crew (shift_account_id, name, sort_order) VALUES (?, ?, ?)
      `).run(id, name, sortOrder);
      stampMaster(db, 'shift_crew', info.lastInsertRowid);
      recordAction(db, username, {
        action: 'CREATE', entity: 'shift_crew', entityId: Number(info.lastInsertRowid),
        detail: `${name} → ${shift.code}`,
      });
      return Number(info.lastInsertRowid);
    })();

    return Response.json({ crew: { id: crewId, name, sortOrder, isActive: true } }, { status: 201 });
  });
}
