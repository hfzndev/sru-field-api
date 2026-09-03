'use client';

import { useState } from 'react';
import { api } from '../_lib/api';
import { useLoader } from '../_lib/useLoader';
import { mm } from '../_lib/format';
import { Alert, ConfirmDialog, Dialog, Empty, Field, Loading, PageHead, Toast } from '../_components/ui';

const BLANK = { code: '', name: '', heightMm: '', dcsTag: '', isActive: true };

export default function TanksPage() {
  const { data: tanks, error, reload: load } = useLoader(
    async () => (await api.get('/api/admin/tanks')).tanks,
  );
  const [toast, setToast] = useState('');
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);

  async function remove(tank) {
    await api.del(`/api/admin/tanks/${tank.id}`);
    setRemoving(null);
    setToast(`${tank.code} dinonaktifkan`);
    load();
  }

  if (error && !tanks) return <Alert error={error} />;
  if (!tanks) return <Loading />;

  return (
    <>
      <PageHead
        title="Tangki"
        subtitle="Tinggi tangki dipakai server untuk menghitung level. Ubah hanya bila dokumen tangki berubah."
        action={<button className="btn-primary" onClick={() => setEditing(BLANK)}>+ Tambah</button>}
      />

      {tanks.length === 0 ? (
        <Empty icon="🛢️" title="Belum ada tangki" hint="Tambah 93T-401 dan 93T-402 untuk mulai." />
      ) : tanks.map((tank) => (
        <div className="card" key={tank.id}>
          <div className="card-row">
            <div className="grow">
              {/* Always the full code — never "T-401" (doc 02 §1.1). */}
              <div className="card-title">{tank.code}</div>
              <div className="card-meta">
                {tank.name} · tinggi {mm(tank.heightMm)}
                {tank.dcsTag ? ` · tag ${tank.dcsTag}` : ''}
              </div>
            </div>
            {!tank.isActive && <span className="chip chip-neutral">Nonaktif</span>}
          </div>
          <div className="card-actions">
            <button className="btn-sm" onClick={() => setEditing(tank)}>Ubah</button>
            {tank.isActive && (
              <button className="btn-sm" onClick={() => setRemoving(tank)}>Nonaktifkan</button>
            )}
          </div>
        </div>
      ))}

      {editing && (
        <TankDialog
          tank={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); setToast(message); load(); }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title="Nonaktifkan tangki?"
          message={`${removing.code} akan hilang dari daftar di HP operator. Riwayat pengukuran tetap tersimpan.`}
          confirmLabel="Nonaktifkan"
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

function TankDialog({ tank, onClose, onSaved }) {
  const isNew = !tank.id;
  const [form, setForm] = useState({
    code: tank.code, name: tank.name,
    heightMm: tank.heightMm === '' ? '' : String(tank.heightMm),
    dcsTag: tank.dcsTag || '', isActive: tank.isActive !== false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = { ...form, heightMm: Number(form.heightMm) };
      if (isNew) await api.post('/api/admin/tanks', payload);
      else await api.put(`/api/admin/tanks/${tank.id}`, payload);
      onSaved(isNew ? 'Tangki ditambahkan' : 'Tangki diperbarui');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={isNew ? 'Tambah tangki' : `Ubah ${tank.code}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert error={error} />

        <Field label="Kode tangki" hint="Tulis lengkap, contoh 93T-401 — jangan disingkat.">
          <input value={form.code} onChange={set('code')} required maxLength={30} />
        </Field>

        <Field label="Nama">
          <input value={form.name} onChange={set('name')} required maxLength={120} />
        </Field>

        <Field label="Tinggi tangki (mm)" hint="Dipakai rumus: level = tinggi − meteran + bandul.">
          <input
            type="number" inputMode="decimal" step="0.1" min="1"
            value={form.heightMm} onChange={set('heightMm')} required
          />
        </Field>

        <Field label="Tag DCS (opsional)">
          <input value={form.dcsTag} onChange={set('dcsTag')} maxLength={60} />
        </Field>

        <div className="checkline field">
          <input
            id="tank-active" type="checkbox" checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
          />
          <label htmlFor="tank-active">Aktif</label>
        </div>

        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Batal</button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Menyimpan…' : 'Simpan'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
