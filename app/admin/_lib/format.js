'use client';

/**
 * Display formatting.
 *
 * Everything is stored and transmitted in UTC (doc 06 §1) but shown in WIB
 * (doc 03 §1) — an operator comparing the screen against the control room clock
 * must see the same time. The timezone is pinned explicitly rather than left to
 * the browser: a handset with the wrong zone set would otherwise silently
 * relabel every record.
 */

const WIB = 'Asia/Jakarta';

const dateTime = new Intl.DateTimeFormat('id-ID', {
  timeZone: WIB, day: 'numeric', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

const timeOnly = new Intl.DateTimeFormat('id-ID', {
  timeZone: WIB, hour: '2-digit', minute: '2-digit', hour12: false,
});

const dateOnly = new Intl.DateTimeFormat('id-ID', {
  timeZone: WIB, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
});

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return `${dateTime.format(date)} WIB`;
}

export function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : `${timeOnly.format(date)} WIB`;
}

export function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : dateOnly.format(date);
}

/** "3 menit lalu" — for last-seen columns where the exact instant is noise. */
export function relative(iso) {
  if (!iso) return 'belum pernah';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'baru saja';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} menit lalu`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} jam lalu`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)} hari lalu`;
  return formatDate(iso);
}

/** Millimetres with thousands separators — levels run to four digits. */
export function mm(value) {
  if (value === null || value === undefined || value === '') return '—';
  return `${Number(value).toLocaleString('id-ID')} mm`;
}

/** Deviation always carries its sign: the direction is the whole point. */
export function deviation(value) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toLocaleString('id-ID')} mm`;
}

export const STATUS_LABEL = {
  NORMAL: 'Normal',
  STANDBY: 'Stand By',
  ON_REPAIR: 'On Repair',
  NEED_REPAIR: 'Need Repair',
  OPEN: 'Open',
  IN_PROGRESS: 'Dikerjakan',
  DONE: 'Selesai',
  CANCELLED: 'Dibatalkan',
};

export const SHIFT_TIME_LABEL = { pagi: 'Pagi', sore: 'Sore', malam: 'Malam' };

/** Today in WIB as YYYY-MM-DD, for date inputs and filters. */
export function todayWib() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WIB, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return parts;
}
