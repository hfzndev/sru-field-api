'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from './_lib/api';
import { formatDate } from './_lib/format';
import { Alert, Card, Chip, Empty, Loading, PageHead, SectionHead, StatTile } from './_components/ui';
import { Broom, CaretRight, ClipboardText, Crane, Cylinder, ICON, MoonStars, Wrench } from './_components/icons';

const EQUIPMENT_ORDER = ['NORMAL', 'STANDBY', 'ON_REPAIR', 'NEED_REPAIR'];

export default function DashboardPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/admin/dashboard').then(setData).catch((err) => setError(err.message));
  }, []);

  if (error) return <Alert error={error} />;
  if (!data) return <Loading rows={4} />;

  const { today, byShift, equipment, openTasks, pendingCleaning } = data;

  return (
    <>
      <PageHead title="Dashboard" subtitle={`Hari ini · ${formatDate(data.windowStart)}`} />

      {/*
        Pengukuran tangki leads: it is the number the shift is judged on, and
        four identical boxes said nothing about which one that was.
      */}
      <div className="stat-grid">
        <StatTile lead value={today.readings} label="Pengukuran tangki" icon={Cylinder} />
        <StatTile value={today.activitiesOperator} label="Aktivitas operator" icon={ClipboardText} />
        <StatTile value={today.activitiesContractor} label="Aktivitas kontraktor" icon={Crane} />
        <StatTile value={today.cleaningDone} label="Bersih-bersih selesai" icon={Broom} />
      </div>

      <SectionHead>Per shift hari ini</SectionHead>
      {byShift.length === 0 ? (
        <Empty
          icon={MoonStars}
          title="Belum ada data hari ini"
          hint="Catatan akan muncul di sini begitu operator melakukan sync."
        />
      ) : (
        <>
          <div className="cards-only">
            {byShift.map((row) => (
              <Card key={row.shiftGroup}>
                <div className="card-title">{row.shiftGroup}</div>
                <div className="card-meta">
                  <span className="mono">{row.readings}</span> pengukuran ·{' '}
                  <span className="mono">{row.activities}</span> aktivitas ·{' '}
                  <span className="mono">{row.cleaning}</span> bersih-bersih
                </div>
              </Card>
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

      <SectionHead>Status peralatan</SectionHead>
      <Card>
        <div className="row">
          {EQUIPMENT_ORDER.every((status) => !equipment[status]) ? (
            <span className="muted">Belum ada equipment terdaftar.</span>
          ) : EQUIPMENT_ORDER.filter((status) => equipment[status]).map((status) => (
            <span key={status} className="row">
              <Chip value={status} />
              <strong className="mono">{equipment[status]}</strong>
            </span>
          ))}
        </div>
      </Card>

      <SectionHead>Perlu tindakan</SectionHead>
      <div className="grid two">
        <Card as={Link} href="/admin/maintenance">
          <div className="card-title">
            <span className="ico" aria-hidden="true"><Wrench size={ICON.inline} /></span>
            Task belum selesai
          </div>
          <div className="card-figure mono">{openTasks}</div>
          <div className="card-meta">
            Ketuk untuk kelola maintenance
            <CaretRight size={12} aria-hidden="true" />
          </div>
        </Card>
        <Card as={Link} href="/admin/data?type=cleaning">
          <div className="card-title">
            <span className="ico" aria-hidden="true"><Broom size={ICON.inline} /></span>
            Bersih-bersih belum selesai
          </div>
          <div className="card-figure mono">{pendingCleaning}</div>
          <div className="card-meta">
            Menunggu foto sesudah
            <CaretRight size={12} aria-hidden="true" />
          </div>
        </Card>
      </div>
    </>
  );
}
