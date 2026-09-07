'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../_lib/api';
import { useLoader } from '../../_lib/useLoader';
import { completionText, formatDate, formatDateTime } from '../../_lib/format';
import {
  Alert, Card, Chip, ConfirmDialog, Dialog, Field, Loading, PageHead, Progress, Toast,
} from '../../_components/ui';
import { CheckCircle, ICON, Plus, Trash } from '../../_components/icons';
import {
  ColumnFields, ExamplePhotoField, FILLABLE_KINDS, KIND_NEEDS_OPTIONS, KIND_NEEDS_PHOTO,
} from '../_components/ColumnEditor';

/**
 * One lembar tugas as a grid (doc 03 §4).
 *
 * The supervisor's view is the whole table at once — that is the point of
 * designing it as a table. The operator's view on the handset is one row at a
 * time, because a 5-inch screen cannot show a grid and a thumb cannot hit a
 * cell in one.
 *
 * The supervisor can fill cells here too. A name typed at the desk and a photo
 * taken in the field land in the same column, which is what the brief asked
 * for; the difference shows only in the attribution under the value.
 */

const CHECK_YES = 'Ya';
const CHECK_NO = 'Tidak';

export default function SheetPage({ params }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, error, reload } = useLoader(() => api.get(`/api/admin/sheets/${id}`), [id]);

  const [toast, setToast] = useState('');
  const [editingCell, setEditingCell] = useState(null);
  const [addingRows, setAddingRows] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const [confirming, setConfirming] = useState(null);

  if (error && !data) return <Alert error={error} />;
  if (!data) return <Loading />;

  const { sheet, columns, rows, cells, progress } = data;
  const byKey = new Map(cells.map((cell) => [`${cell.rowId}:${cell.columnId}`, cell]));
  const percent = progress.rows === 0 ? 0 : Math.round((progress.rowsDone / progress.rows) * 100);

  function after(message) {
    setEditingCell(null);
    setAddingRows(false);
    setAddingColumn(false);
    setConfirming(null);
    setToast(message);
    reload();
  }

  return (
    <>
      <PageHead
        title={sheet.title}
        subtitle={sheet.description || undefined}
        action={<Chip value={sheet.status} />}
      />

      <Card>
        <div className="card-meta">
          {sheet.assignedShift || 'Semua shift'}
          {sheet.dueDate ? ` · target ${formatDate(sheet.dueDate)}` : ''}
          {sheet.allowOperatorRows ? ' · operator boleh menambah baris' : ' · daftar baris dikunci'}
        </div>
        <div className="sheet-count">
          {completionText(progress.rowsDone, progress.rows, progress.total)}
        </div>
        <Progress value={percent} />

        <div className="card-actions">
          <button className="btn-sm" onClick={() => setAddingRows(true)}>
            <Plus size={ICON.inline} aria-hidden="true" /> Baris
          </button>
          <button className="btn-sm" onClick={() => setAddingColumn(true)}>
            <Plus size={ICON.inline} aria-hidden="true" /> Kolom
          </button>
          {sheet.status === 'OPEN' ? (
            <button
              className="btn-sm"
              onClick={() => setConfirming({
                kind: 'close',
                title: 'Tutup lembar tugas?',
                message: 'Operator tidak bisa mengisi lagi setelah ditutup. Data yang sudah masuk tetap tersimpan.',
                confirmLabel: 'Tutup',
              })}
            >
              <CheckCircle size={ICON.inline} aria-hidden="true" /> Tutup lembar
            </button>
          ) : (
            <button className="btn-sm" onClick={() => setStatus(id, 'OPEN').then(() => after('Lembar dibuka lagi'))}>
              Buka lagi
            </button>
          )}
          <button
            className="btn-sm"
            onClick={() => setConfirming({
              kind: 'delete',
              title: 'Hapus lembar tugas?',
              message: 'Lembar hilang dari HP semua operator. Foto dan isian yang sudah masuk tetap tersimpan.',
            })}
          >
            <Trash size={ICON.inline} aria-hidden="true" /> Hapus
          </button>
        </div>
      </Card>

      {rows.length === 0 || columns.length === 0 ? (
        <Card>
          <div className="card-meta">
            {columns.length === 0
              ? 'Belum ada kolom — tambahkan kolom agar operator tahu apa yang harus diisi.'
              : 'Belum ada baris — tambahkan nama equipment yang harus didatangi.'}
          </div>
        </Card>
      ) : (
        <div className="sheet-scroll">
          <table className="sheet-grid">
            <thead>
              <tr>
                <th className="sheet-rowhead" scope="col">Equipment</th>
                {columns.map((column) => (
                  <th key={column.id} scope="col">
                    {column.label}
                    <span className="sheet-colkind">
                      {column.isRequired && FILLABLE_KINDS.has(column.kind) ? 'wajib' : 'opsional'}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th className="sheet-rowhead" scope="row">
                    <span className="mono">{row.label}</span>
                    {row.addedByName && row.addedByName !== 'admin' && (
                      <span className="cell-by">ditambah {row.addedByName}</span>
                    )}
                  </th>
                  {columns.map((column) => (
                    <td key={column.id}>
                      <CellView
                        column={column}
                        cell={byKey.get(`${row.id}:${column.id}`)}
                        onEdit={() => setEditingCell({ row, column, cell: byKey.get(`${row.id}:${column.id}`) })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingCell && (
        <CellDialog
          sheetId={id}
          {...editingCell}
          onClose={() => setEditingCell(null)}
          onSaved={() => after('Sel diperbarui')}
        />
      )}

      {addingRows && (
        <AddRowsDialog
          sheetId={id}
          onClose={() => setAddingRows(false)}
          onSaved={(count) => after(`${count} baris ditambahkan`)}
        />
      )}

      {addingColumn && (
        <AddColumnDialog
          sheetId={id}
          onClose={() => setAddingColumn(false)}
          onSaved={() => after('Kolom ditambahkan')}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming.title}
          message={confirming.message}
          confirmLabel={confirming.confirmLabel}
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            if (confirming.kind === 'delete') {
              await api.del(`/api/admin/sheets/${id}`);
              router.replace('/admin/sheets');
              return;
            }
            await setStatus(id, 'DONE');
            after('Lembar ditutup');
          }}
        />
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

/**
 * Status changes go through the same PUT the edit form uses, so the sheet's own
 * fields are sent whole and the route never has to guess which half is a patch.
 */
async function setStatus(id, status) {
  const { sheet } = await api.get(`/api/admin/sheets/${id}`);
  return api.put(`/api/admin/sheets/${id}`, {
    title: sheet.title,
    description: sheet.description,
    status,
    dueDate: sheet.dueDate,
    assignedShift: sheet.assignedShift,
    allowOperatorRows: sheet.allowOperatorRows,
  });
}

/** One cell. A button, not text, so the whole area is the target. */
function CellView({ column, cell, onEdit }) {
  if (!FILLABLE_KINDS.has(column.kind)) {
    return <span className="muted">{column.hint || '—'}</span>;
  }

  const filled = isFilled(column.kind, cell);

  return (
    <button
      type="button"
      className={`cell ${filled ? 'cell-filled' : 'cell-blank'}`}
      onClick={onEdit}
      title={filled ? `Diisi ${cell.filledByName || '—'} · ${formatDateTime(cell.filledAt)}` : 'Belum diisi'}
    >
      {filled ? <CellValue column={column} cell={cell} /> : 'Belum diisi'}
      {filled && cell.filledByName && <span className="cell-by">{cell.filledByName}</span>}
    </button>
  );
}

function CellValue({ column, cell }) {
  if (column.kind === 'PHOTO') {
    return (
      <img
        className="cell-thumb"
        src={`/api/admin/photo?path=${encodeURIComponent(cell.photoPath)}`}
        alt={`${column.label} terisi`}
      />
    );
  }
  if (column.kind === 'NUMBER') {
    const unit = column.options[0] ? ` ${column.options[0]}` : '';
    return <span className="mono">{cell.valueNumber}{unit}</span>;
  }
  return <span>{cell.valueText}</span>;
}

/**
 * Whether a cell reads as done. Per kind rather than "any field non-empty": a
 * NUMBER of 0 is a real answer and must not look blank. Mirrors
 * lib/sheets.js cellIsFilled, which is what the progress count uses.
 */
function isFilled(kind, cell) {
  if (!cell) return false;
  if (kind === 'PHOTO') return Boolean(cell.photoPath);
  if (kind === 'NUMBER') return cell.valueNumber !== null && cell.valueNumber !== undefined;
  return Boolean(cell.valueText);
}

/* --------------------------------------------------------------- dialogs */

function CellDialog({ sheetId, row, column, cell, onClose, onSaved }) {
  const [valueText, setValueText] = useState(cell?.valueText ?? '');
  const [valueNumber, setValueNumber] = useState(
    cell?.valueNumber === null || cell?.valueNumber === undefined ? '' : String(cell.valueNumber),
  );
  const [photoPath, setPhotoPath] = useState(cell?.photoPath ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post(`/api/admin/sheets/${sheetId}/cells`, {
        rowId: row.id,
        columnId: column.id,
        valueText: column.kind === 'NUMBER' || column.kind === 'PHOTO' ? '' : valueText,
        valueNumber: column.kind === 'NUMBER' && valueNumber !== '' ? Number(valueNumber) : null,
        photoPath: column.kind === 'PHOTO' ? photoPath : '',
      });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={`${row.label} · ${column.label}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert error={error} />
        {column.hint && <p className="muted">{column.hint}</p>}

        {column.kind === 'PHOTO' && (
          <>
            {/* The supervisor's reference shot sits beside the picker here for
                the same reason it sits beside the shutter on the handset: the
                person filling the cell should not have to remember what the
                column meant by "wide". */}
            {column.examplePhoto && (
              <Field label="Contoh dari supervisor">
                <img
                  className="example-thumb"
                  src={`/api/admin/photo?path=${encodeURIComponent(column.examplePhoto)}`}
                  alt="Foto contoh"
                />
              </Field>
            )}
            <Field label="Foto" hint="Foto lama tetap tersimpan sebagai riwayat.">
              <ExamplePhotoField
                value={photoPath}
                onChange={setPhotoPath}
                emptyLabel="Unggah foto"
                replaceLabel="Ganti foto"
              />
            </Field>
          </>
        )}

        {column.kind === 'NUMBER' && (
          <Field label={column.options[0] ? `Angka (${column.options[0]})` : 'Angka'}>
            <input
              type="number" step="any" inputMode="decimal"
              value={valueNumber} onChange={(e) => setValueNumber(e.target.value)}
            />
          </Field>
        )}

        {column.kind === 'TEXT' && (
          <Field label="Isi">
            <textarea value={valueText} onChange={(e) => setValueText(e.target.value)} maxLength={500} />
          </Field>
        )}

        {column.kind === 'CHECK' && (
          <Field label="Isi">
            <select value={valueText} onChange={(e) => setValueText(e.target.value)}>
              <option value="">Belum diisi</option>
              <option value={CHECK_YES}>{CHECK_YES}</option>
              <option value={CHECK_NO}>{CHECK_NO}</option>
            </select>
          </Field>
        )}

        {column.kind === 'CHOICE' && (
          <Field label="Isi">
            <select value={valueText} onChange={(e) => setValueText(e.target.value)}>
              <option value="">Belum diisi</option>
              {column.options.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </Field>
        )}

        {cell && (
          <p className="muted">
            Terakhir diisi {cell.filledByName || '—'}
            {cell.shiftGroup ? ` (${cell.shiftGroup})` : ''} · {formatDateTime(cell.filledAt)}
          </p>
        )}

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

function AddRowsDialog({ sheetId, onClose, onSaved }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = text.split('\n').map((line) => line.trim()).filter(Boolean);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post(`/api/admin/sheets/${sheetId}/rows`, { rows: rows.map((label) => ({ label })) });
      onSaved(rows.length);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="Tambah baris" onClose={onClose}>
      <form onSubmit={submit}>
        <Alert error={error} />
        <Field label="Nama equipment" hint="Satu per baris. Baris baru ditambahkan di bawah.">
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Batal</button>
          <button type="submit" className="btn-primary" disabled={busy || rows.length === 0}>
            {busy ? 'Menyimpan…' : `Tambah ${rows.length || ''}`.trim()}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AddColumnDialog({ sheetId, onClose, onSaved }) {
  const [column, setColumn] = useState({
    label: '', kind: 'PHOTO', isRequired: true, options: '', examplePhoto: '', hint: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post(`/api/admin/sheets/${sheetId}/columns`, {
        label: column.label.trim(),
        kind: column.kind,
        isRequired: column.isRequired,
        options: KIND_NEEDS_OPTIONS.has(column.kind)
          ? column.options.split(',').map((o) => o.trim()).filter(Boolean)
          : [],
        examplePhoto: KIND_NEEDS_PHOTO.has(column.kind) ? column.examplePhoto : '',
        hint: column.hint.trim(),
      });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="Tambah kolom" onClose={onClose}>
      <form onSubmit={submit}>
        <Alert error={error} />
        {/* Appended to the right, never inserted: a column that shifts position
            after operators have started filling makes their half-done rows read
            as answers to the wrong question. */}
        <ColumnFields
          column={column}
          index={0}
          onChange={(patch) => setColumn({ ...column, ...patch })}
        />
        {KIND_NEEDS_PHOTO.has(column.kind) && (
          <Field label="Foto contoh" hint="Ditampilkan di HP di samping tombol kamera.">
            <ExamplePhotoField
              value={column.examplePhoto}
              onChange={(path) => setColumn({ ...column, examplePhoto: path })}
            />
          </Field>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Batal</button>
          <button type="submit" className="btn-primary" disabled={busy || !column.label.trim()}>
            {busy ? 'Menyimpan…' : 'Tambah kolom'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
