import { idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { readJson, validationError } from '@/lib/http';
import { serializeSheet, sheetDetail, stampSheet } from '@/lib/sheets';
import { parse, sheetSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** GET — the whole lembar: design, current cell values, and progress. */
export async function GET(request, context) {
  const id = await idParam(context);

  return withAdmin(request, (db) => {
    if (!id) return notFound('Lembar tugas tidak ditemukan');
    const detail = sheetDetail(db, id);
    if (!detail) return notFound('Lembar tugas tidak ditemukan');
    return Response.json(detail);
  });
}

/**
 * PUT — edits the lembar's own fields.
 *
 * Columns and rows are NOT touched here even though sheetSchema accepts them,
 * because editing a published design one whole-object PUT at a time would make
 * "remove a column" and "the browser sent a stale copy" indistinguishable. They
 * have their own routes, where each change is explicit and separately audited.
 */
export async function PUT(request, context) {
  const id = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Lembar tugas tidak ditemukan');

    const existing = db.prepare('SELECT * FROM task_sheets WHERE id = ?').get(id);
    if (!existing) return notFound('Lembar tugas tidak ditemukan');

    const parsed = parse(sheetSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const {
      title, description, status, dueDate, assignedShift, allowOperatorRows, isActive,
    } = parsed.data;

    db.transaction(() => {
      db.prepare(`
        UPDATE task_sheets
           SET title = ?, description = ?, status = ?, due_date = ?,
               assigned_shift = ?, allow_operator_rows = ?, is_active = ?
         WHERE id = ?
      `).run(
        title, description, status, dueDate, assignedShift,
        allowOperatorRows ? 1 : 0, isActive ? 1 : 0, id,
      );

      stampSheet(db, id);
      recordAction(db, username, {
        action: 'UPDATE',
        entity: 'task_sheet',
        entityId: id,
        detail: existing.status !== status ? `${title}: ${existing.status} → ${status}` : title,
      });
    })();

    return Response.json({ sheet: serializeSheet(db.prepare('SELECT * FROM task_sheets WHERE id = ?').get(id)) });
  });
}

/**
 * DELETE — soft delete (doc 05 §3).
 *
 * The cells stay. An operator's photographs are evidence that a pump was in a
 * given state on a given day, and a supervisor tidying their task list is not a
 * reason to destroy that. The delta carries is_active = false so handsets prune
 * the lembar from view without the history going anywhere.
 */
export async function DELETE(request, context) {
  const id = await idParam(context);

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Lembar tugas tidak ditemukan');

    const existing = db.prepare('SELECT * FROM task_sheets WHERE id = ?').get(id);
    if (!existing) return notFound('Lembar tugas tidak ditemukan');

    db.transaction(() => {
      db.prepare('UPDATE task_sheets SET is_active = 0 WHERE id = ?').run(id);
      stampSheet(db, id);
      recordAction(db, username, {
        action: 'DELETE', entity: 'task_sheet', entityId: id, detail: existing.title,
      });
    })();

    return Response.json({ ok: true });
  });
}
