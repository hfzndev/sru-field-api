'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from './_lib/api';
import { formatDate } from './_lib/format';
import { Alert, Chip, Empty, Loading, PageHead } from './_components/ui';

const EQUIPMENT_ORDER = ['NORMAL', 'STANDBY', 'ON_REPAIR', 'NEED_REPAIR'];

export default function DashboardPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/admin/dashboard').then(setData).catch((err) => setError(err.message));
  }, []);

  if (error) return <Alert error={error} />;
  if (!data) return <Loading />;

  const { today, byShift, equipment, openTasks, pendingCleaning } = data;

  return (
    <>
      <PageHead title="Dashboard" subtitle={`Hari ini · ${formatDate(data.windowStart)}`} />

      <div className="grid stats">
        <div className="stat">
          <div className="n">{today.readings}</div>
          <div className="l">Pengukuran tangki</div>
        </div>
        <div className="stat">
          <div className="n">{today.activitiesOperator}</div>
          <div className="l">Aktivitas operator</div>
        </div>
        <div className="stat">
          <div className="n">{today.activitiesContractor}</div>
          <div className="l">Aktivitas kontraktor</div>
        </div>
        <div className="stat">
          <div className="n">{today.cleaningDone}</div>
          <div className="l">Bersih-bersih selesai</div>
        </div>
      </div>

      <h2 style={{ margin: '22px 0 10px' }}>Per shift hari ini</h2>
      {byShift.length === 0 ? (
        <Empty
          icon="🌙"
          title="Belum ada data hari ini"
          hint="Catatan akan muncul di sini begitu operator melakukan sync."
        />
      ) : (
        <>
          <div className="cards-only">
            {byShift.map((row) => (
              <div className="card" key={row.shiftGroup}>
                <div className="card-title">{row.shiftGroup}</div>
                <div className="card-meta">
                  {row.readings} pengukuran · {row.activities} aktivitas · {row.cleaning} bersih-bersih
                </div>
              </div>
            ))}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Shift</th>
                  <th className="right">Pengukuran</th>
                  <th className="right">Aktivitas</th>
                  <th className="right">Bersih-bersih</th>
                </tr>
              </thead>
              <tbody>
                {byShift.map((row) => (
                  <tr key={row.shiftGroup}>
                    <td>{row.shiftGroup}</td>
                    <td className="num right">{row.readings}</td>
                    <td className="num right">{row.activities}</td>
                    <td className="num right">{row.cleaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 style={{ margin: '22px 0 10px' }}>Status peralatan</h2>
      <div className="card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {EQUIPMENT_ORDER.every((status) => !equipment[status]) ? (
            <span style={{ color: 'var(--muted)' }}>Belum ada equipment terdaftar.</span>
          ) : EQUIPMENT_ORDER.filter((status) => equipment[status]).map((status) => (
            <span key={status} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Chip value={status} />
              <strong>{equipment[status]}</strong>
            </span>
          ))}
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 10 }}>
        <Link href="/admin/maintenance" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="card-title">Task belum selesai</div>
          <div className="n" style={{ fontSize: '1.6rem', fontWeight: 680 }}>{openTasks}</div>
          <div className="card-meta">Ketuk untuk kelola maintenance</div>
        </Link>
        <Link href="/admin/data?type=cleaning" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="card-title">Bersih-bersih belum selesai</div>
          <div className="n" style={{ fontSize: '1.6rem', fontWeight: 680 }}>{pendingCleaning}</div>
          <div className="card-meta">Menunggu foto sesudah</div>
        </Link>
      </div>
    </>
  );
}
