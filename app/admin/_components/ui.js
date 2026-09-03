'use client';

import { useEffect, useState } from 'react';
import { STATUS_LABEL } from '../_lib/format';

/** Shared primitives for the admin pages. */

export function Chip({ value, kind }) {
  return <span className={`chip chip-${kind || value}`}>{STATUS_LABEL[value] || value}</span>;
}

export function Empty({ icon = '📋', title, hint }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div style={{ fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {hint && <div style={{ marginTop: 4, fontSize: '.9rem' }}>{hint}</div>}
    </div>
  );
}

export function Loading({ label = 'Memuat…' }) {
  return <div className="loading">{label}</div>;
}

export function Alert({ error, ok }) {
  if (!error && !ok) return null;
  return <div className={`alert ${error ? 'alert-error' : 'alert-ok'}`}>{error || ok}</div>;
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/**
 * Modal dialog. Closes on Escape and locks background scroll — on a phone the
 * sheet slides up from the bottom, within thumb reach.
 */
export function Dialog({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/**
 * Confirmation for destructive actions (doc 03 §1). Deactivating master data is
 * reversible, but it removes the row from every handset, so it still asks.
 */
export function ConfirmDialog({ title, message, confirmLabel = 'Hapus', onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <p style={{ color: 'var(--muted)' }}>{message}</p>
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>Batal</button>
        <button type="button" className="btn-danger" onClick={confirm} disabled={busy}>
          {busy ? 'Memproses…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

export function Toast({ message, onDone }) {
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(onDone, 2600);
    return () => clearTimeout(timer);
  }, [message, onDone]);

  if (!message) return null;
  return <div className="toast" role="status">{message}</div>;
}

/** Header with a title and a single primary action, per doc 03 §1. */
export function PageHead({ title, subtitle, action }) {
  return (
    <div className="page-head">
      <div className="grow">
        <h1>{title}</h1>
        {subtitle && <div className="sub">{subtitle}</div>}
      </div>
      {action}
    </div>
  );
}
