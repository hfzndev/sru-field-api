import { notFound, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { toIso } from '@/lib/time';
import { parse, taskSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export function serializeTask(row) {
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    equipmentTag: row.tag_number ?? '',
    equipmentName: row.equipment_name ?? '',
    title: row.title,
    description: row.description || '',
    status: row.status,
    progressPct: row.progress_pct,
    dueDate: toIso(row.due_date),
    updatedAt: row.updated_at,
  };
}

const SELECT_TASKS = `
  SELECT t.*, e.tag_number, e.name AS equipment_name
    FROM maintenance_tasks t
    LEFT JOIN equipment e ON e.id = t.equipment_id
`;

export async function GET(request) {
  return withAdmin(request, (db) => Response.json({
    tasks: db.prepare(`${SELECT_TASKS} ORDER BY t.id DESC`).all().map(serializeTask),
  }));
}

/**
 * POST — creates a task.
 *
 * NOTE — spec gap: docs 03 §3.5 and §4 describe assigning a task to a shift,
 * but maintenance_tasks has no shift column (doc 05), so there is nothing to
 * assign to. Every shift sees every unfinished task. Closing this needs either
 * a schema addition or a correction to doc 03; it is not something to invent
 * here.
 */
export async function POST(request) {
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    const parsed = parse(taskSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const { equipmentId, title, description, status, progressPct, dueDate } = parsed.data;
    const equipment = db.prepare('SELECT id, tag_number FROM equipment WHERE id = ?').get(equipmentId);
    if (!equipment) return notFound('Equipment tidak ditemukan');

    const admin = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);

    const id = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO maintenance_tasks
          (equipment_id, title, description, status, progress_pct, due_date, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(equipmentId, title, description, status, progressPct, dueDate, admin?.id ?? null);

      stampMaster(db, 'maintenance_tasks', info.lastInsertRowid);
      recordAction(db, username, {
        action: 'CREATE', entity: 'maintenance_task', entityId: Number(info.lastInsertRowid),
        detail: `${equipment.tag_number}: ${title}`,
      });
      return Number(info.lastInsertRowid);
    })();

    const row = db.prepare(`${SELECT_TASKS} WHERE t.id = ?`).get(id);
    return Response.json({ task: serializeTask(row) }, { status: 201 });
  });
}
