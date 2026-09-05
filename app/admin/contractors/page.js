'use client';

import { useState } from 'react';
import { api } from '../_lib/api';
import { useLoader } from '../_lib/useLoader';
import { Alert, Card, ConfirmDialog, Dialog, Empty, Field, Loading, PageHead, Toast } from '../_components/ui';
import { Crane, ICON, PencilSimple, Plus } from '../_components/icons';

export default function ContractorsPage() {
  const { data: contractors, error, reload: load } = useLoader(
    async () => (await api.get('/api/admin/contractors')).contractors,
  );
  const [toast, setToast] = useState('');
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);

  async function remove(contractor) {
    await api.del(`/api/admin/contractors/${contractor.id}`);
    setRemoving(null);
    setToast(`${contractor.name} dinonaktifkan`);
    load();
  }

  if (error && !contractors) return <Alert error={error} />;
  if (!contractors) return <Loading />;

  return (
    <>
      <PageHead
        title="Kontraktor"
        subtitle="Daftar ini muncul sebagai pilihan cepat saat operator mencatat aktivitas kontraktor."
        action={
          <button className="btn-primary" onClick={() => setEditing({ name: '', isActive: true })}>
            <Plus size={ICON.inline} aria-hidden="true" /> Tambah
          </button>
        }
      />

      {contractors.length === 0 ? (
        <Empty
          icon={Crane}
          title="Belum ada kontraktor"
          hint="Operator masih bisa mengetik nama manual; tambahkan di sini agar jadi pilihan cepat."
        />
      ) : contractors.map((contractor) => (
        <Card key={contractor.id}>
          <div className="card-row">
            <div className="grow">
              <div className="card-title">{contractor.name}</div>
            </div>
            {!contractor.isActive && <span className="chip chip-neutral">Nonaktif</span>}
          </div>
          <div className="card-actions">
            <button className="btn-sm" onClick={() => setEditing(contractor)}>
              <PencilSimple size={ICON.inline} aria-hidden="true" /> Ubah
            </button>
            {contractor.isActive && (
              <button className="btn-sm" onClick={() => setRemoving(contractor)}>Nonaktifkan</button>
            )}
          </div>
        </Card>
      ))}

      {editing && (
        <ContractorDialog
          contractor={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); setToast(message); load(); }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title="Nonaktifkan kontraktor?"
          message={`${removing.name} tidak akan muncul lagi di HP operator. Aktivitas yang sudah tercatat tetap utuh.`}
          confirmLabel="Nonaktifkan"
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

function ContractorDialog({ contractor, onClose, onSaved }) {
  const isNew = !contractor.id;
  const [name, setName] = useState(contractor.name);
  const [isActive, setIsActive] = useState(contractor.isActive !== false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (isNew) await api.post('/api/admin/contractors', { name, isActive });
      else await api.put(`/api/admin/contractors/${contractor.id}`, { name, isActive });
      onSaved(isNew ? 'Kontraktor ditambahkan' : 'Kontraktor diperbarui');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={isNew ? 'Tambah kontraktor' : 'Ubah kontraktor'} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert error={error} />

        <Field label="Nama perusahaan" hint="Contoh: PT Tejo Lomanis">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={150} />
        </Field>

        <div className="checkline field">
          <input id="c-active" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          <label htmlFor="c-active">Aktif</label>
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
