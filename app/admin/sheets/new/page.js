'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '../../_lib/api';
import { useLoader } from '../../_lib/useLoader';
import { Alert, Card, Field, PageHead, SectionHead } from '../../_components/ui';
import { ICON, Plus, X } from '../../_components/icons';
import {
  CheckLine, ColumnFields, ExamplePhotoField, KIND_NEEDS_OPTIONS, KIND_NEEDS_PHOTO,
} from '../_components/ColumnEditor';

/**
 * The lembar tugas builder (doc 03 §4).
 *
 * Three steps in one page rather than a wizard: the whole design goes to the
 * server in a single request, because a lembar published with its columns but
 * not its rows is the failure an operator would actually hit — headers and
 * nothing to walk, indistinguishable from a lembar deliberately left empty.
 *
 * The worked example in the brief: photograph every pump wide and close. Three
 * columns — the row itself is the equipment tag, then Foto Wide and Foto Close,
 * each carrying an example photo the operator sees beside the shutter.
 */

const MAX_COLUMNS = 12;
const MAX_ROWS = 200;

let nextKey = 1;

function blankColumn() {
  return {
    key: nextKey++,
    label: '',
    kind: 'PHOTO',
    isRequired: true,
    options: '',
    examplePhoto: '',
    hint: '',
  };
}

export default function NewSheetPage() {
  const router = useRouter();
  const { data: shiftData } = useLoader(() => api.get('/api/admin/shifts'));
  const shifts = shiftData?.shifts ?? [];

  const [form, setForm] = useState({
    title: '',
    description: '',
    dueDate: '',
    assignedShift: '',
    allowOperatorRows: true,
  });
  const [columns, setColumns] = useState([
    { ...blankColumn(), label: 'Foto Wide' },
    { ...blankColumn(), label: 'Foto Close' },
  ]);
  // A textarea, not a repeated "add row" click: the real input is a supervisor
  // pasting twelve pump tags out of a list they already have.
  const [rowText, setRowText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({
    ...form,
    [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value,
  });

  const rows = rowText.split('\n').map((line) => line.trim()).filter(Boolean);

  function updateColumn(key, patch) {
    setColumns((current) => current.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  function removeColumn(key) {
    setColumns((current) => current.filter((c) => c.key !== key));
  }

  async function submit(event) {
    event.preventDefault();
    setError('');

    if (columns.some((c) => !c.label.trim())) {
      setError('Setiap kolom harus punya nama.');
      return;
    }
    if (rows.length === 0) {
      setError('Isi minimal satu baris — satu nama equipment per baris.');
      return;
    }

    setBusy(true);
    try {
      const { sheet } = await api.post('/api/admin/sheets', {
        title: form.title,
        description: form.description,
        dueDate: form.dueDate ? `${form.dueDate}T00:00:00.000Z` : null,
        assignedShift: form.assignedShift,
        allowOperatorRows: form.allowOperatorRows,
        columns: columns.map((column) => ({
          label: column.label.trim(),
          kind: column.kind,
          isRequired: column.isRequired,
          options: KIND_NEEDS_OPTIONS.has(column.kind)
            ? column.options.split(',').map((o) => o.trim()).filter(Boolean)
            : [],
          examplePhoto: KIND_NEEDS_PHOTO.has(column.kind) ? column.examplePhoto : '',
          hint: column.hint.trim(),
        })),
        rows: rows.map((label) => ({ label })),
      });
      router.replace(`/admin/sheets/${sheet.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <PageHead title="Lembar tugas baru" subtitle="Tentukan kolom dan baris; operator mengisinya dari HP." />

      <Alert error={error} />

      <SectionHead>1 · Tugas</SectionHead>
      <Card>
        <Field label="Judul tugas">
          <input
            value={form.title} onChange={set('title')} required maxLength={120}
            placeholder="Foto Pompa Area 93"
          />
        </Field>

        <Field label="Penjelasan (opsional)" hint="Ditampilkan di HP sebelum operator mulai.">
          <textarea value={form.description} onChange={set('description')} maxLength={500} />
        </Field>

        <Field label="Untuk shift">
          <select value={form.assignedShift} onChange={set('assignedShift')}>
            <option value="">Semua shift</option>
            {shifts.map((shift) => (
              <option key={shift.id} value={shift.displayName}>{shift.displayName}</option>
            ))}
          </select>
        </Field>

        <Field label="Target selesai (opsional)">
          <input type="date" value={form.dueDate} onChange={set('dueDate')} />
        </Field>

        <CheckLine
          checked={form.allowOperatorRows}
          onChange={(value) => setForm({ ...form, allowOperatorRows: value })}
        >
          Operator boleh menambah baris sendiri
        </CheckLine>
        <div className="hint">
          Operator sering menemukan alat yang belum terdaftar; biarkan aktif kecuali daftarnya memang harus tetap.
        </div>
      </Card>

      <SectionHead>2 · Kolom ({columns.length})</SectionHead>
      {columns.map((column, index) => (
        <div className="builder-item" key={column.key}>
          <div className="grow">
            <ColumnFields
              column={column}
              index={index}
              onChange={(patch) => updateColumn(column.key, patch)}
            />
          </div>

          {KIND_NEEDS_PHOTO.has(column.kind) && (
            <ExamplePhotoField
              value={column.examplePhoto}
              onChange={(path) => updateColumn(column.key, { examplePhoto: path })}
            />
          )}

          <button
            type="button"
            className="btn-sm"
            onClick={() => removeColumn(column.key)}
            disabled={columns.length === 1}
            aria-label={`Hapus kolom ${index + 1}`}
          >
            <X size={ICON.inline} aria-hidden="true" />
          </button>
        </div>
      ))}

      <button
        type="button"
        className="btn-sm"
        onClick={() => setColumns([...columns, blankColumn()])}
        disabled={columns.length >= MAX_COLUMNS}
      >
        <Plus size={ICON.inline} aria-hidden="true" /> Kolom
      </button>

      <SectionHead>3 · Baris ({rows.length})</SectionHead>
      <Card>
        <Field
          label="Nama equipment"
          hint={`Satu per baris — tempel langsung dari daftar yang sudah ada. Maksimal ${MAX_ROWS} baris.`}
        >
          <textarea
            rows={8}
            value={rowText}
            onChange={(e) => setRowText(e.target.value)}
            placeholder={'93P-101A\n93P-101B\n93P-102A'}
          />
        </Field>
        {rows.length > MAX_ROWS && (
          <Alert error={`Terlalu banyak baris (${rows.length}). Maksimal ${MAX_ROWS}.`} />
        )}
      </Card>

      <div className="card-actions">
        <button type="button" onClick={() => router.back()} disabled={busy}>Batal</button>
        <button
          type="submit"
          className="btn-primary"
          disabled={busy || rows.length === 0 || rows.length > MAX_ROWS}
        >
          {busy ? 'Membuat…' : 'Buat tugas'}
        </button>
      </div>
    </form>
  );
}
