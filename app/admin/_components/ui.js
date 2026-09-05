'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { STATUS_LABEL } from '../_lib/format';
import { CheckCircle, ICON, WarningCircle, X } from './icons';

/** Shared primitives for the admin pages. */

export function Chip({ value, kind }) {
  return <span className={`chip chip-${kind || value}`}>{STATUS_LABEL[value] || value}</span>;
}

/**
 * A hairline panel. Pass `href` to get the link affordance — before this the
 * dashboard tiles were `<Link className="card">` plus an inline style to undo
 * the anchor colour and underline.
 */
export function Card({ as: As = 'div', className = '', children, ...rest }) {
  const classes = ['card', rest.href ? 'card-link' : '', className].filter(Boolean).join(' ');
  return <As className={classes} {...rest}>{children}</As>;
}

/** Small mono label with a rule running off to the right. */
export function SectionHead({ children }) {
  return (
    <div className="section-head">
      <h2>{children}</h2>
    </div>
  );
}

/** Dashboard tile. `lead` makes it the dominant one in the row. */
export function StatTile({ value, label, icon: Icon, lead = false }) {
  return (
    <div className={`stat${lead ? ' stat-lead' : ''}`}>
      <div className="stat-top">
        <div className="n">{value}</div>
        {Icon && <span className="ico" aria-hidden="true"><Icon size={ICON.tile} /></span>}
      </div>
      <div className="l">{label}</div>
    </div>
  );
}

/** Task progress. Was six inline style objects per card. */
export function Progress({ value }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="progress">
      <div
        className="progress-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progres task"
      >
        <div className="progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-value mono">{pct}%</span>
    </div>
  );
}

export function Empty({ icon: Icon, title, hint }) {
  return (
    <div className="empty">
      {Icon && <div className="big" aria-hidden="true"><Icon size={ICON.empty} /></div>}
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

/**
 * Loading placeholder shaped like the rows that are coming. On a plant
 * connection the page sits here long enough that a bare "Memuat…" reads as a
 * page that failed.
 */
export function Skeleton({ rows = 3 }) {
  return (
    <div aria-busy="true" aria-label="Memuat…">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i}>
          <div className="skeleton-line" style={{ width: '42%' }} />
          <div className="skeleton-line" style={{ width: '72%' }} />
        </div>
      ))}
    </div>
  );
}

export function Loading({ rows = 3 }) {
  return <Skeleton rows={rows} />;
}

export function Alert({ error, ok }) {
  if (!error && !ok) return null;
  const Icon = error ? WarningCircle : CheckCircle;
  return (
    <div className={`alert ${error ? 'alert-error' : 'alert-ok'}`} role={error ? 'alert' : 'status'}>
      <span className="ico" aria-hidden="true"><Icon size={ICON.inline} /></span>
      <span>{error || ok}</span>
    </div>
  );
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

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog. Closes on Escape and locks background scroll — on a phone the
 * sheet slides up from the bottom, within thumb reach.
 *
 * Focus is trapped inside and handed back to whatever opened the dialog when it
 * closes. Without that, tabbing out of an open sheet lands on the tab bar
 * behind it and a keyboard user has no way of telling where they are.
 */
export function Dialog({ title, onClose, children }) {
  const ref = useRef(null);

  useEffect(() => {
    const opener = document.activeElement;
    const node = ref.current;

    // Focus the first real control, not the panel, so typing starts in the form.
    const first = node?.querySelector(FOCUSABLE);
    (first || node)?.focus();

    function onKey(event) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !node) return;

      const items = Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const edge = event.shiftKey ? items[0] : items[items.length - 1];
      if (document.activeElement === edge) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    }

    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}>
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
      <p className="muted">{message}</p>
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
  return (
    <div className="toast" role="status">
      <span className="ico" aria-hidden="true"><CheckCircle size={ICON.inline} /></span>
      {message}
    </div>
  );
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

/* Kept to one short word each so the control still fits a 375px topbar beside
   the brand and Keluar, without shrinking below the 44px/16px floor. */
const THEMES = [
  ['system', 'Sistem'],
  ['light', 'Terang'],
  ['dark', 'Gelap'],
];

const THEME_KEY = 'sru-theme';

/*
 * localStorage is the source of truth for the theme, so the select subscribes
 * to it rather than mirroring it into React state. Reading it in an effect and
 * calling setState would work, but it costs a second render on every page and
 * would not notice the setting changing in another tab — which it does here,
 * because `storage` fires on every other tab of the panel.
 */
const themeListeners = new Set();

function readTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'dark' || saved === 'light' ? saved : 'system';
  } catch {
    // Private mode or blocked storage: the system preference still applies.
    return 'system';
  }
}

function subscribeTheme(onChange) {
  themeListeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    themeListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The server has no localStorage, so it always renders the neutral option. */
function serverTheme() {
  return 'system';
}

/**
 * Theme control. A three-way select rather than a sun/moon switch: "ikut
 * sistem" is a real preference and a two-state toggle cannot express it.
 *
 * The theme itself is already applied by the time this renders — the inline
 * script in app/layout.js stamps it before first paint. This only shows and
 * changes the setting.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, serverTheme);

  const change = useCallback((event) => {
    const next = event.target.value;
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // Non-persistent is better than broken.
    }
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    themeListeners.forEach((listener) => listener());
  }, []);

  return (
    <select className="theme-select" value={theme} onChange={change} aria-label="Tema tampilan">
      {THEMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  );
}

/** The × on a removable chip. Was six inline properties at every call site. */
export function ChipRemove({ onClick, label }) {
  return (
    <button type="button" className="chip-x" onClick={onClick} aria-label={label}>
      <X size={12} />
    </button>
  );
}
