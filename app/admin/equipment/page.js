'use client';

import { useEffect, useState } from 'react';
import { api } from '../_lib/api';
import { useLoader } from '../_lib/useLoader';
import { STATUS_LABEL, formatDateTime } from '../_lib/format';
import { Alert, Card, Chip, ConfirmDialog, Dialog, Empty, Field, Loading, PageHead, Toast } from '../_components/ui';
import { Gear, ICON, PencilSimple, Plus } from '../_components/icons';

const STATUSES = ['NORMAL', 'STANDBY', 'ON_REPAIR', 'NEED_REPAIR'];

export default function EquipmentPage() {
  const { data: equipment, error, reload: load } = useLoader(
    async () => (await api.get('/api/admin/equipment')).equipment,
  );
  const [toast, setToast] = useState('');
  const [editing, setEditing] = useState(null);
  const [changing, setChanging] = useState(null);
  const [removing, setRemoving] = useState(null);

  async function remove(item) {
    await api.del(`/api/admin/equipment/${item.id}`);
    setRemoving(null);
    setToast(`${item.tagNumber} dinonaktifkan`);
    load();
  }

  if (error && !equipment) return <Alert error={error} />;
  if (!equipment) return <Loading />;

  return (
    <>
      <PageHead
        title="Equipment"
        subtitle="Perubahan status selalu perlu alasan tertulis dan tersimpan di riwayat."
        action={
          <button
            className="btn-primary"
            onClick={() => setEditing({ tagNumber: '', name: '', unitKey: '', location: '', isActive: true })}
          >
            <Plus size={ICON.inline} aria-hidden="true" /> Tambah
          </button>
        }
      />

      {equipment.length === 0 ? (
        <Empty icon={Gear} title="Belum ada equipment" hint="Tambahkan alat yang dipantau operator." />
      ) : equipment.map((item) => (
        <Card key={item.id}>
          <div className="card-row">
            <div className="grow">
              <div className="card-title"><span className="mono">{item.tagNumber}</span> — {item.name}</div>
              <div className="card-meta">
                {[item.unitKey, item.location].filter(Boolean).join(' · ') || 'Tanpa lokasi'}
                {item.statusChangedAt ? ` · sejak ${formatDateTime(item.statusChangedAt)}` : ''}
              </div>
            </div>
            <Chip value={item.status} />
          </div>
          <div className="card-actions">
            <button className="btn-sm btn-primary" onClick={() => setChanging(item)}>Ubah status</button>
            <button className="btn-sm" onClick={() => setEditing(item)}>
              <PencilSimple size={ICON.inline} aria-hidden="true" /> Ubah data
            </button>
            {item.isActive && <button className="btn-sm" onClick={() => setRemoving(item)}>Nonaktifkan</button>}
          </div>
        </Card>
      ))}

      {editing && (
        <EquipmentDialog
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); setToast(message); load(); }}
        />
      )}

      {changing && (
        <StatusDialog
          item={changing}
          onClose={() => setChanging(null)}
          onSaved={(message) => { setChanging(null); setToast(message); load(); }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title="Nonaktifkan equipment?"
          message={`${removing.tagNumber} akan hilang dari daftar di HP. Riwayat status tetap tersimpan.`}
          confirmLabel="Nonaktifkan"
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

/**
 * Status changes go through their own dialog because the description is
 * mandatory — the pairing of state and reason is what makes the history useful
 * to the next shift (doc 02 §1.2).
 */
function StatusDialog({ item, onClose, onSaved }) {
  const [status, setStatus] = useState(item.status);
  const [description, setDescription] = useState('');
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/api/admin/equipment/${item.id}/status`)
      .then((data) => setHistory(data.history))
      .catch(() => setHistory([]));
  }, [item.id]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post(`/api/admin/equipment/${item.id}/status`, { status, description });
      onSaved(`${item.tagNumber} → ${STATUS_LABEL[status]}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Status ${item.tagNumber}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert error={error} />

        <Field label="Status baru">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((value) => (
              <option key={value} value={value}>{STATUS_LABEL[value]}</option>
            ))}
          </select>
        </Field>

        <Field label="Alasan perubahan" hint="Wajib diisi — dibaca shift berikutnya.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required maxLength={500}
            placeholder="Contoh: bearing rusak, menunggu spare part"
          />
        </Field>

        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Batal</button>
          <button type="submit" className="btn-primary" disabled={busy || !description.trim()}>
            {busy ? 'Menyimpan…' : 'Simpan'}
          </button>
        </div>
      </form>

      {history && history.length > 0 && (
        <>
          <h3 className="history-head">Riwayat</h3>
          {history.slice(0, 8).map((entry) => (
            <div key={entry.id} className="history-entry">
              <div className="row">
                {entry.oldStatus && <Chip value={entry.oldStatus} />}
                <span aria-hidden="true">→</span>
                <Chip value={entry.newStatus} />
              </div>
              <div className="card-meta">{entry.description}</div>
              <div className="card-meta history-by">
                {entry.changedByName || 'admin'} · {formatDateTime(entry.changedAt)}
              </div>
            </div>
          ))}
        </>
      )}
    </Dialog>
  );
}

function EquipmentDialog({ item, onClose, onSaved }) {
  const isNew = !item.id;
  const [form, setForm] = useState({
    tagNumber: item.tagNumber, name: item.name,
    unitKey: item.unitKey || '', location: item.location || '',
    isActive: item.isActive !== false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (isNew) await api.post('/api/admin/equipment', form);
      else await api.put(`/api/admin/equipment/${item.id}`, form);
      onSaved(isNew ? 'Equipment ditambahkan' : 'Equipment diperbarui');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={isNew ? 'Tambah equipment' : `Ubah ${item.tagNumber}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert error={error} />

        <Field label="Tag number">
          <input value={form.tagNumber} onChange={set('tagNumber')} required maxLength={60} />
        </Field>

        <Field label="Nama alat">
          <input value={form.name} onChange={set('name')} required maxLength={120} />
        </Field>

        <Field label="Unit (opsional)">
          <input value={form.unitKey} onChange={set('unitKey')} maxLength={60} />
        </Field>

        <Field label="Lokasi (opsional)">
          <input value={form.location} onChange={set('location')} maxLength={200} />
        </Field>

        {!isNew && (
          <div className="hint mb-3">
            Status diubah lewat tombol “Ubah status” agar alasannya ikut tercatat.
          </div>
        )}

        <div className="checkline field">
          <input
            id="eq-active" type="checkbox" checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
          />
          <label htmlFor="eq-active">Aktif</label>
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
