'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '../_lib/api';
import { useLoader } from '../_lib/useLoader';
import { deviation, formatDateTime, mm, SHIFT_TIME_LABEL, todayWib } from '../_lib/format';
import { Alert, Card, Chip, Empty, Field, Loading, PageHead } from '../_components/ui';
import { DownloadSimple, ICON, MagnifyingGlass } from '../_components/icons';

const TYPES = [
  { value: 'readings', label: 'Pengukuran' },
  { value: 'activities', label: 'Aktivitas' },
  { value: 'cleaning', label: 'Bersih-bersih' },
];

const SHIFT_GROUPS = ['Shift A', 'Shift B', 'Shift C', 'Shift D'];

export default function DataPageWrapper() {
  // useSearchParams needs a Suspense boundary during prerender.
  return (
    <Suspense fallback={<Loading />}>
      <DataPage />
    </Suspense>
  );
}

function DataPage() {
  const params = useSearchParams();
  const [filters, setFilters] = useState({
    type: TYPES.some((t) => t.value === params.get('type')) ? params.get('type') : 'readings',
    shiftGroup: '',
    shiftTime: '',
    from: '',
    to: '',
  });
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value !== ''),
  ).toString();

  // Refetches whenever the filters change. The hook discards responses for
  // filters the user has already moved away from, so a slow earlier request
  // cannot overwrite the current view.
  const { data: result, error } = useLoader(() => api.get(`/api/admin/data?${query}`), [query]);

  const set = (key) => (event) => setFilters({ ...filters, [key]: event.target.value });

  return (
    <>
      <PageHead
        title="Data Lapangan"
        subtitle="Hanya bisa dibaca. Catatan dari lapangan tidak pernah diubah atau dihapus dari server."
        action={
          <a className="btn btn-primary" href={`/api/admin/data/export?${query}`}>
            <DownloadSimple size={ICON.inline} aria-hidden="true" /> Export CSV
          </a>
        }
      />

      <Card className="mb-4">
        <div className="filters">
          <div className="full">
            <Field label="Jenis">
              <select value={filters.type} onChange={set('type')}>
                {TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Shift">
            <select value={filters.shiftGroup} onChange={set('shiftGroup')}>
              <option value="">Semua</option>
              {SHIFT_GROUPS.map((group) => <option key={group} value={group}>{group}</option>)}
            </select>
          </Field>

          <Field label="Waktu shift">
            <select value={filters.shiftTime} onChange={set('shiftTime')}>
              <option value="">Semua</option>
              {Object.entries(SHIFT_TIME_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>

          <Field label="Dari tanggal">
            <input type="date" value={filters.from} max={todayWib()} onChange={set('from')} />
          </Field>

          <Field label="Sampai tanggal">
            <input type="date" value={filters.to} max={todayWib()} onChange={set('to')} />
          </Field>
        </div>
      </Card>

      {error && <Alert error={error} />}
      {!result && !error && <Loading />}

      {result && (
        result.rows.length === 0 ? (
          <Empty icon={MagnifyingGlass} title="Tidak ada data" hint="Coba longgarkan filter atau ubah rentang tanggal." />
        ) : (
          <>
            <div className="card-meta mb-3"><span className="mono">{result.count}</span> catatan</div>
            {result.rows.map((row) => (
              filters.type === 'readings' ? <ReadingCard key={row.id} row={row} />
                : filters.type === 'activities' ? <ActivityCard key={row.id} row={row} />
                  : <CleaningCard key={row.id} row={row} />
            ))}
          </>
        )
      )}
    </>
  );
}

function Attribution({ row }) {
  return (
    <div className="card-meta attribution">
      {row.operatorName} · {row.shiftGroup || '—'}
      {row.shiftTime ? ` ${SHIFT_TIME_LABEL[row.shiftTime] || row.shiftTime}` : ''}
    </div>
  );
}

function ReadingCard({ row }) {
  return (
    <Card>
      <div className="card-row">
        <div className="grow">
          {/* Full tank code, never abbreviated (doc 02 §1.1). */}
          <div className="card-title mono">{row.tankCode || `Tangki #${row.tankId}`}</div>
          <div className="card-meta">{formatDateTime(row.readingAt)}</div>
        </div>
        <div className="right">
          <div className="reading-level mono">{mm(row.levelMm)}</div>
          <div className="card-meta mono">DCS {mm(row.dcsLevelMm)} · {deviation(row.deviationMm)}</div>
        </div>
      </div>
      <div className="card-meta mono">
        Meteran {mm(row.tapeLengthMm)} · bandul {mm(row.bandulSulfurMm)} · {row.attempts}× percobaan
      </div>
      {row.note && <div className="card-meta">{row.note}</div>}
      <Attribution row={row} />
      {row.photoPath && <Thumbs photos={[{ path: row.photoPath, label: 'Foto' }]} />}
    </Card>
  );
}

function ActivityCard({ row }) {
  return (
    <Card>
      <div className="card-row">
        <div className="grow">
          <div className="card-title">{row.description}</div>
          <div className="card-meta">{formatDateTime(row.activityAt)}</div>
        </div>
        <Chip value={row.type} kind={row.type === 'KONTRAKTOR' ? 'warn' : 'accent'} />
      </div>
      {(row.contractorName || row.unitArea) && (
        <div className="card-meta">
          {[row.contractorName, row.unitArea].filter(Boolean).join(' · ')}
        </div>
      )}
      <Attribution row={row} />
    </Card>
  );
}

function CleaningCard({ row }) {
  return (
    <Card>
      <div className="card-row">
        <div className="grow">
          <div className="card-title">{row.location}</div>
          <div className="card-meta">{formatDateTime(row.receivedAt)}</div>
        </div>
        <Chip value={row.status} />
      </div>
      {row.note && <div className="card-meta">{row.note}</div>}
      <Attribution row={row} />
      <Thumbs
        photos={[
          { path: row.beforePhoto, label: 'Sebelum' },
          { path: row.afterPhoto, label: 'Sesudah' },
        ]}
      />
    </Card>
  );
}

/**
 * Photos are served through the authenticated admin endpoint — they are never
 * reachable as static files (doc 08 §7).
 */
function Thumbs({ photos }) {
  const present = photos.filter((photo) => photo.path);
  if (present.length === 0) return null;

  return (
    <div className="thumbs">
      {present.map((photo) => (
        <div key={photo.path}>
          <a href={`/api/admin/photo?path=${encodeURIComponent(photo.path)}`} target="_blank" rel="noreferrer">
            <img
              className="thumb"
              src={`/api/admin/photo?path=${encodeURIComponent(photo.path)}`}
              alt={photo.label}
              loading="lazy"
            />
          </a>
          <div className="thumb-label">{photo.label}</div>
        </div>
      ))}
    </div>
  );
}
