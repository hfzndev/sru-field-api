import { conflict, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { contractorSchema, parse } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export function serializeContractor(row) {
  return { id: row.id, name: row.name, isActive: row.is_active === 1 };
}

export async function GET(request) {
  return withAdmin(request, (db) => Response.json({
    contractors: db.prepare('SELECT * FROM contractors ORDER BY name').all().map(serializeContractor),
  }));
}

export async function POST(request) {
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    const parsed = parse(contractorSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const { name, isActive } = parsed.data;
    if (db.prepare('SELECT id FROM contractors WHERE name = ?').get(name)) {
      return conflict('DUPLICATE_NAME', `Kontraktor "${name}" sudah terdaftar`);
    }

    const id = db.transaction(() => {
      const info = db.prepare('INSERT INTO contractors (name, is_active) VALUES (?, ?)')
        .run(name, isActive ? 1 : 0);
      stampMaster(db, 'contractors', info.lastInsertRowid);
      recordAction(db, username, {
        action: 'CREATE', entity: 'contractor', entityId: Number(info.lastInsertRowid), detail: name,
      });
      return Number(info.lastInsertRowid);
    })();

    return Response.json(
      { contractor: serializeContractor(db.prepare('SELECT * FROM contractors WHERE id = ?').get(id)) },
      { status: 201 },
    );
  });
}
