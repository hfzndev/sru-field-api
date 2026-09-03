import { withAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/shifts — doc 06 §6.
 *
 * The four shift accounts with their crew. There is no create or delete: the
 * shift structure is fixed at A–D by the plant's 3-on-1-off rota (doc 02 §1.3),
 * so the only mutations are the password and the crew roster.
 *
 * password_hash is never selected — it has no reason to leave the database.
 */
export async function GET(request) {
  return withAdmin(request, (db) => {
    const shifts = db.prepare(`
      SELECT id, code, display_name, is_active FROM shift_accounts ORDER BY code
    `).all();

    const crewStatement = db.prepare(`
      SELECT id, name, sort_order, is_active FROM shift_crew
       WHERE shift_account_id = ? ORDER BY sort_order, id
    `);

    return Response.json({
      shifts: shifts.map((s) => ({
        id: s.id,
        code: s.code,
        displayName: s.display_name,
        isActive: s.is_active === 1,
        crew: crewStatement.all(s.id).map((c) => ({
          id: c.id, name: c.name, sortOrder: c.sort_order, isActive: c.is_active === 1,
        })),
      })),
    });
  });
}
