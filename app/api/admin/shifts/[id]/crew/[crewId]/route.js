import { namedParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/admin/shifts/:id/crew/:crewId — doc 06 §6.
 *
 * Soft delete, like every other master row: records attribute work by the name
 * text they captured, so removing someone from the roster must not disturb what
 * they already did.
 */
export async function DELETE(request, context) {
  const shiftId = await namedParam(context, 'id');
  const crewId = await namedParam(context, 'crewId');

  return withAdmin(request, (db, username) => {
    if (!shiftId || !crewId) return notFound('Crew tidak ditemukan');

    const existing = db.prepare(
      'SELECT * FROM shift_crew WHERE id = ? AND shift_account_id = ?',
    ).get(crewId, shiftId);
    if (!existing) return notFound('Crew tidak ditemukan');

    db.transaction(() => {
      db.prepare('UPDATE shift_crew SET is_active = 0 WHERE id = ?').run(crewId);
      stampMaster(db, 'shift_crew', crewId);
      recordAction(db, username, {
        action: 'DELETE', entity: 'shift_crew', entityId: crewId,
        detail: `${existing.name} dihapus dari daftar`,
      });
    })();

    return Response.json({ ok: true });
  });
}
