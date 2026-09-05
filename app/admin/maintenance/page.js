'use client';

import { useState } from 'react';
import { api } from '../_lib/api';
import { useLoader } from '../_lib/useLoader';
import { STATUS_LABEL, formatDate } from '../_lib/format';
import { Alert, Card, Chip, Dialog, Empty, Field, Loading, PageHead, Progress, SectionHead, Toast } from '../_components/ui';
import { ICON, PencilSimple, Plus, Wrench } from '../_components/icons';

const TASK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'];

export default function MaintenancePage() {
  const { data, error, reload: load } = useLoader(async () => {
    const [taskData, equipmentData] = await Promise.all([
      api.get('/api/admin/tasks'),
      api.get('/api/admin/equipment'),
    ]);
    return { tasks: taskData.tasks, equipment: equipmentData.equipment.filter((e) => e.isActive) };
  });
  const tasks = data?.tasks ?? null;
  const equipment = data?.equipment ?? [];
  const [toast, setToast] = useState('');
  const [editing, setEditing] = useState(null);

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
            <Plus size={ICON.inline} aria-hidden="true" /> Task
          </button>
        }
      />

      {equipment.length === 0 && (
        <Alert error="Tambahkan equipment dulu — setiap task harus melekat pada satu alat." />
      )}

      {tasks.length === 0 ? (
        <Empty icon={Wrench} title="Belum ada task" hint="Buat task agar operator melihatnya di HP." />
      ) : (
        <>
          <SectionHead>Belum selesai ({open.length})</SectionHead>
          {open.length === 0
            ? <Card><div className="card-meta">Semua task sudah selesai.</div></Card>
            : open.map((task) => <TaskCard key={task.id} task={task} onEdit={() => setEditing(task)} />)}

          {closed.length > 0 && (
            <>
              <SectionHead>Selesai ({closed.length})</SectionHead>
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
    <Card>
      <div className="card-row">
        <div className="grow">
          <div className="card-title">{task.title}</div>
          <div className="card-meta">
            {task.equipmentTag
              ? <><span className="mono">{task.equipmentTag}</span>{` — ${task.equipmentName}`}</>
              : 'Equipment terhapus'}
            {task.dueDate ? ` · target ${formatDate(task.dueDate)}` : ''}
          </div>
          {task.description && <div className="card-meta">{task.description}</div>}
        </div>
        <Chip value={task.status} />
      </div>

      <Progress value={task.progressPct} />

      <div className="card-actions">
        <button className="btn-sm" onClick={onEdit}>
          <PencilSimple size={ICON.inline} aria-hidden="true" /> Ubah
        </button>
      </div>
    </Card>
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
