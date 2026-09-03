import { hashPassword } from '@/lib/auth';
import { idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { stampMaster } from '@/lib/dataversion';
import { readJson, validationError } from '@/lib/http';
import { parse, shiftPasswordSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * PUT /api/admin/shifts/:id/password — doc 06 §6.
 *
 * Changing the password does not revoke live device tokens. That is deliberate:
 * a shift is often mid-way through work on three handsets, and silently signing
 * them out could strand unsynced records behind a login screen. Use the Devices
 * tab to revoke explicitly when that is what you mean.
 */
export async function PUT(request, context) {
  const id = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  const parsed = parse(shiftPasswordSchema, body.data);

  return withAdmin(request, async (db, username) => {
    if (!id) return notFound('Akun shift tidak ditemukan');

    const existing = db.prepare('SELECT id, code FROM shift_accounts WHERE id = ?').get(id);
    if (!existing) return notFound('Akun shift tidak ditemukan');
    if (!parsed.ok) return validationError(parsed.details);

    // Hashing is async, so it happens before the transaction opens — a
    // better-sqlite3 transaction body must stay synchronous.
    const passwordHash = await hashPassword(parsed.data.password);

    db.transaction(() => {
      db.prepare('UPDATE shift_accounts SET password_hash = ? WHERE id = ?').run(passwordHash, id);
      stampMaster(db, 'shift_accounts', id);
      // The password itself is never recorded, here or anywhere else.
      recordAction(db, username, {
        action: 'PASSWORD', entity: 'shift_account', entityId: id,
        detail: `Password ${existing.code} diubah`,
      });
    })();

    return Response.json({ ok: true });
  });
}
