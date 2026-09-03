import { idParam, notFound, recordAction, withAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/devices/:id/revoke — doc 06 §6, doc 08 §2.6.
 *
 * The response to a lost or stolen handset. Tokens have no expiry (an operator
 * may be offline for days), so revocation is the only way to end a session.
 *
 * Not a master mutation: device_tokens is not pulled by the handsets, so there
 * is nothing to stamp. It is still audited — revoking someone's access is
 * exactly the kind of act that needs a name against it.
 */
export async function POST(request, context) {
  const id = await idParam(context);

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Device tidak ditemukan');

    const existing = db.prepare(`
      SELECT t.id, t.device_name, t.revoked_at, a.code
        FROM device_tokens t
        JOIN shift_accounts a ON a.id = t.shift_account_id
       WHERE t.id = ?
    `).get(id);
    if (!existing) return notFound('Device tidak ditemukan');

    db.transaction(() => {
      db.prepare("UPDATE device_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
        .run(id);
      recordAction(db, username, {
        action: 'REVOKE', entity: 'device_token', entityId: id,
        detail: `${existing.device_name || '(tanpa nama)'} — ${existing.code}`,
      });
    })();

    return Response.json({ ok: true });
  });
}
