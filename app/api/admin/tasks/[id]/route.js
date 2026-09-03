import { idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { parse, taskSchema } from '@/lib/validation';
import { serializeTask } from '../route.js';

export const dynamic = 'force-dynamic';

const SELECT_TASK = `
  SELECT t.*, e.tag_number, e.name AS equipment_name
    FROM maintenance_tasks t
    LEFT JOIN equipment e ON e.id = t.equipment_id
   WHERE t.id = ?
`;

export async function PUT(request, context) {
  const id = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Task tidak ditemukan');

    const existing = db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(id);
    if (!existing) return notFound('Task tidak ditemukan');

    const parsed = parse(taskSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const { equipmentId, title, description, status, progressPct, dueDate } = parsed.data;
    if (!db.prepare('SELECT id FROM equipment WHERE id = ?').get(equipmentId)) {
      return notFound('Equipment tidak ditemukan');
    }

    db.transaction(() => {
      db.prepare(`
        UPDATE maintenance_tasks
           SET equipment_id = ?, title = ?, description = ?, status = ?, progress_pct = ?, due_date = ?
         WHERE id = ?
      `).run(equipmentId, title, description, status, progressPct, dueDate, id);

      // Operators also move this row from the field, through task logs on sync
      // (doc 06 §5). Both paths stamp, so whichever wrote last is what the
      // handsets converge on.
      stampMaster(db, 'maintenance_tasks', id);
      recordAction(db, username, {
        action: 'UPDATE', entity: 'maintenance_task', entityId: id,
        detail: existing.status !== status ? `${title}: ${existing.status} → ${status}` : title,
      });
    })();

    return Response.json({ task: serializeTask(db.prepare(SELECT_TASK).get(id)) });
  });
}
