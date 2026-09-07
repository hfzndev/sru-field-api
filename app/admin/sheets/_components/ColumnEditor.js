'use client';

import { useId, useRef, useState } from 'react';
import { api } from '../../_lib/api';
import { Field } from '../../_components/ui';

/**
 * Pieces shared by the lembar tugas builder and the grid's column editor.
 *
 * Both surfaces let a supervisor say the same things about a column, and both
 * have to agree on which kinds carry options and which carry an example photo.
 * Keeping that in one place is what stops the builder offering an example photo
 * for a NUMBER column while the editor quietly does not.
 */

/** Storage code → the label a supervisor reads. Order is the menu order. */
export const COLUMN_KIND_LABEL = {
  PHOTO: 'Foto',
  TEXT: 'Teks',
  NUMBER: 'Angka',
  CHECK: 'Centang (ya/tidak)',
  CHOICE: 'Pilihan',
  LABEL: 'Keterangan (tidak diisi)',
};

/** Kinds whose `options` list is meaningful. */
export const KIND_NEEDS_OPTIONS = new Set(['CHOICE']);

/** Kinds where an example photo helps the operator frame the shot. */
export const KIND_NEEDS_PHOTO = new Set(['PHOTO']);

/** Kinds an operator can actually put something in — LABEL is read-only text. */
export const FILLABLE_KINDS = new Set(['TEXT', 'NUMBER', 'PHOTO', 'CHECK', 'CHOICE']);

/**
 * A photo picker backed by the server's own upload endpoint.
 *
 * Named for its first job — the example photo, which is the point of the whole
 * feature.
 *
 * A supervisor writes "Foto Wide" and the operator guesses what wide means. One
 * reference shot next to the shutter removes the guess, which is why this sits
 * on the column rather than in the description text.
 *
 * Uploads through /api/admin/upload, which stores the file and returns the path
 * before the lembar is created — the same order the handset uses, so a photo
 * whose sheet is never submitted is an orphan and gets swept, rather than a
 * sheet pointing at a file that was never written.
 */
export function ExamplePhotoField({ value, onChange, emptyLabel = 'Foto contoh', replaceLabel = 'Ganti contoh' }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(event) {
    const file = event.target.files?.[0];
    // Cleared immediately so choosing the same file twice still fires a change.
    event.target.value = '';
    if (!file) return;

    setError('');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const { path } = await api.postForm('/api/admin/upload', form);
      onChange(path);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {value ? (
        <img
          className="example-thumb"
          src={`/api/admin/photo?path=${encodeURIComponent(value)}`}
          alt="Foto contoh"
        />
      ) : (
        <div className="example-thumb" aria-hidden="true" />
      )}

      <input ref={input} type="file" accept="image/*" hidden onChange={upload} />
      <button
        type="button"
        className="btn-sm"
        onClick={() => input.current?.click()}
        disabled={busy}
        style={{ marginTop: 'var(--space-2)' }}
      >
        {busy ? 'Mengunggah…' : value ? replaceLabel : emptyLabel}
      </button>
      {error && <div className="hint" role="alert">{error}</div>}
    </div>
  );
}

/** Checkbox in the panel's own markup — the label has to be a real sibling. */
export function CheckLine({ checked, onChange, children }) {
  const id = useId();
  return (
    <div className="checkline field">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{children}</label>
    </div>
  );
}

/**
 * The per-column form, used while building a new lembar and while editing a
 * published one.
 */
export function ColumnFields({ column, index, onChange }) {
  const set = (patch) => onChange(patch);

  return (
    <>
      <Field label={`Kolom ${index + 1}`}>
        <input
          value={column.label}
          onChange={(e) => set({ label: e.target.value })}
          maxLength={40}
          placeholder="Foto Wide"
        />
      </Field>

      <Field label="Jenis isian">
        <select value={column.kind} onChange={(e) => set({ kind: e.target.value })}>
          {Object.entries(COLUMN_KIND_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </Field>

      {KIND_NEEDS_OPTIONS.has(column.kind) && (
        <Field label="Pilihan" hint="Pisahkan dengan koma, mis. Bersih, Kotor, Bocor">
          <input value={column.options} onChange={(e) => set({ options: e.target.value })} />
        </Field>
      )}

      <Field label="Petunjuk singkat (opsional)">
        <input
          value={column.hint}
          onChange={(e) => set({ hint: e.target.value })}
          maxLength={120}
          placeholder="Ambil dari jarak 3 meter"
        />
      </Field>

      {/* LABEL columns are text the operator reads, so "wajib diisi" is
          meaningless there and offering it would only be confusing. */}
      {FILLABLE_KINDS.has(column.kind) && (
        <CheckLine checked={column.isRequired} onChange={(v) => set({ isRequired: v })}>
          Wajib diisi
        </CheckLine>
      )}
    </>
  );
}
