import { conflict, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { parse, tankSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export function serializeTank(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    heightMm: row.height_mm,
    dcsTag: row.dcs_tag || '',
    isActive: row.is_active === 1,
    dataVersion: row.data_version,
    updatedAt: row.updated_at,
  };
}

/** GET /api/admin/tanks — includes inactive rows so admins can reactivate. */
export async function GET(request) {
  return withAdmin(request, (db) => Response.json({
    tanks: db.prepare('SELECT * FROM tanks ORDER BY code').all().map(serializeTank),
  }));
}

export async function POST(request) {
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    const parsed = parse(tankSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const { code, name, heightMm, dcsTag, isActive } = parsed.data;
    if (db.prepare('SELECT id FROM tanks WHERE code = ?').get(code)) {
      return conflict('DUPLICATE_CODE', `Kode tangki "${code}" sudah dipakai`);
    }

    // The insert, the version stamp and the audit row commit together: a change
    // the handsets can see but nobody can account for is not acceptable.
    const id = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO tanks (code, name, height_mm, dcs_tag, is_active) VALUES (?, ?, ?, ?, ?)
      `).run(code, name, heightMm, dcsTag, isActive ? 1 : 0);

      stampMaster(db, 'tanks', info.lastInsertRowid);
      recordAction(db, username, {
        action: 'CREATE', entity: 'tank', entityId: Number(info.lastInsertRowid),
        detail: `${code} (${heightMm} mm)`,
      });
      return Number(info.lastInsertRowid);
    })();

    const row = db.prepare('SELECT * FROM tanks WHERE id = ?').get(id);
    return Response.json({ tank: serializeTank(row) }, { status: 201 });
  });
}
