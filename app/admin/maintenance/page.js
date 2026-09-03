'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../_lib/api';
import { STATUS_LABEL, formatDate } from '../_lib/format';
import { Alert, Chip, Dialog, Empty, Field, Loading, PageHead, Toast } from '../_components/ui';

const TASK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'];

export default function MaintenancePage() {
  const [tasks, setTasks] = useState(null);
  const [equipment, setEquipment] = useState([]);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const [taskData, equipmentData] = await Promise.all([
        api.get('/api/admin/tasks'),
        api.get('/api/admin/equipment'),
      ]);
      setTasks(taskData.tasks);
      setEquipment(equipmentData.equipment.filter((e) => e.isActive));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error && !tasks) return <Alert error={error} />;
  if (!tasks) return <Loading />;

  const open = tasks.filter((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS');
  const closed = tasks.filter((t) => t.status === 'DONE' || t.status === 'CANCELLED');

  return (
    <>
      <PageHead
        title="Maintenance"
        subtitle="Task terlihat oleh semua shift di HP; progres diperbarui operator dari lapangan."
        action={
          <button
            className="btn-primary"
            disabled={equipment.length === 0}
            onClick={() => setEditing({ equipmentId: equipment[0]?.id, title: '', description: '', status: 'OPEN', progressPct: 0, dueDate: '' })}
          >
            + Task
          </button>
        }
      />

      {equipment.length === 0 && (
        <Alert error="Tambahkan equipment dulu — setiap task harus melekat pada satu alat." />
      )}

      {tasks.length === 0 ? (
        <Empty icon="🔧" title="Belum ada task" hint="Buat task agar operator melihatnya di HP." />
      ) : (
        <>
          <h2 style={{ margin: '4px 0 10px' }}>Belum selesai ({open.length})</h2>
          {open.length === 0
            ? <div className="card"><div className="card-meta">Semua task sudah selesai.</div></div>
            : open.map((task) => <TaskCard key={task.id} task={task} onEdit={() => setEditing(task)} />)}

          {closed.length > 0 && (
            <>
              <h2 style={{ margin: '22px 0 10px' }}>Selesai ({closed.length})</h2>
              {closed.map((task) => <TaskCard key={task.id} task={task} onEdit={() => setEditing(task)} />)}
            </>
          )}
        </>
      )}

      {editing && (
        <TaskDialog
          task={editing}
          equipment={equipment}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); setToast(message); load(); }}
        />
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

function TaskCard({ task, onEdit }) {
  return (
    <div className="card">
      <div className="card-row">
        <div className="grow">
          <div className="card-title">{task.title}</div>
          <div className="card-meta">
            {task.equipmentTag ? `${task.equipmentTag} — ${task.equipmentName}` : 'Equipment terhapus'}
            {task.dueDate ? ` · target ${formatDate(task.dueDate)}` : ''}
          </div>
          {task.description && <div className="card-meta">{task.description}</div>}
        </div>
        <Chip value={task.status} />
      </div>

      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, height: 8, background: 'var(--neutral-soft)', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ width: `${task.progressPct}%`, height: '100%', background: 'var(--accent)' }} />
        </div>
        <span className="mono" style={{ fontSize: '.85rem', color: 'var(--muted)' }}>{task.progressPct}%</span>
      </div>

      <div className="card-actions">
        <button className="btn-sm" onClick={onEdit}>Ubah</button>
      </div>
    </div>
  );
}

function TaskDialog({ task, equipment, onClose, onSaved }) {
  const isNew = !task.id;
  const [form, setForm] = useState({
    equipmentId: String(task.equipmentId ?? equipment[0]?.id ?? ''),
    title: task.title,
    description: task.description || '',
    status: task.status || 'OPEN',
    progressPct: String(task.progressPct ?? 0),
    dueDate: task.dueDate ? task.dueDate.slice(0, 10) : '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = {
        equipmentId: Number(form.equipmentId),
        title: form.title,
        description: form.description,
        status: form.status,
        progressPct: Number(form.progressPct),
        dueDate: form.dueDate ? `${form.dueDate}T00:00:00.000Z` : null,
      };
      if (isNew) await api.post('/api/admin/tasks', payload);
      else await api.put(`/api/admin/tasks/${task.id}`, payload);
      onSaved(isNew ? 'Task dibuat' : 'Task diperbarui');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={isNew ? 'Task baru' : 'Ubah task'} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert error={error} />

        <Field label="Equipment">
          <select value={form.equipmentId} onChange={set('equipmentId')} required>
            {equipment.map((item) => (
              <option key={item.id} value={item.id}>{item.tagNumber} — {item.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Judul">
          <input value={form.title} onChange={set('title')} required maxLength={120} />
        </Field>

        <Field label="Deskripsi (opsional)">
          <textarea value={form.description} onChange={set('description')} maxLength={500} />
        </Field>

        <Field label="Status">
          <select value={form.status} onChange={set('status')}>
            {TASK_STATUSES.map((value) => (
              <option key={value} value={value}>{STATUS_LABEL[value]}</option>
            ))}
          </select>
        </Field>

        <Field label={`Progres: ${form.progressPct}%`}>
          <input
            type="range" min="0" max="100" step="5"
            value={form.progressPct} onChange={set('progressPct')}
            style={{ minHeight: 44 }}
          />
        </Field>

        <Field label="Target selesai (opsional)">
          <input type="date" value={form.dueDate} onChange={set('dueDate')} />
        </Field>

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
