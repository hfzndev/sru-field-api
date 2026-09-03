'use client';

import { useState } from 'react';
import { api } from '../_lib/api';
import { useLoader } from '../_lib/useLoader';
import { formatDateTime, relative } from '../_lib/format';
import { Alert, ConfirmDialog, Empty, Loading, PageHead, Toast } from '../_components/ui';

export default function DevicesPage() {
  const { data, error, reload: load } = useLoader(async () => ({
    devices: (await api.get('/api/admin/devices')).devices,
    version: await api.get('/api/version').catch(() => null),
  }));
  const devices = data?.devices ?? null;
  const version = data?.version ?? null;
  const [toast, setToast] = useState('');
  const [revoking, setRevoking] = useState(null);

  async function revoke(device) {
    await api.post(`/api/admin/devices/${device.id}/revoke`);
    setRevoking(null);
    setToast(`${device.deviceName} dicabut aksesnya`);
    load();
  }

  if (error && !devices) return <Alert error={error} />;
  if (!devices) return <Loading />;

  const live = devices.filter((d) => !d.revoked);

  return (
    <>
      <PageHead
        title="Devices"
        subtitle={
          version
            ? `Server versi ${version.version}. Versi APK tercatat saat HP login.`
            : 'Versi APK tercatat saat HP login.'
        }
      />

      {devices.length === 0 ? (
        <Empty icon="📱" title="Belum ada HP yang login" hint="Daftar terisi setelah operator masuk dari aplikasi." />
      ) : (
        <>
          <div className="cards-only">
            {devices.map((device) => (
              <div className="card" key={device.id}>
                <div className="card-row">
                  <div className="grow">
                    <div className="card-title">{device.deviceName}</div>
                    <div className="card-meta">
                      {device.shiftName} · versi {device.appVersion}
                    </div>
                    <div className="card-meta">Terakhir aktif {relative(device.lastSeenAt)}</div>
                  </div>
                  {device.revoked && <span className="chip chip-neutral">Dicabut</span>}
                </div>
                {!device.revoked && (
                  <div className="card-actions">
                    <button className="btn-sm btn-danger" onClick={() => setRevoking(device)}>
                      Cabut akses
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Shift</th>
                  <th>Versi app</th>
                  <th>Terakhir aktif</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id} style={device.revoked ? { opacity: .55 } : undefined}>
                    <td>{device.deviceName}</td>
                    <td>{device.shiftName}</td>
                    <td className="mono">{device.appVersion}</td>
                    <td title={formatDateTime(device.lastSeenAt)}>{relative(device.lastSeenAt)}</td>
                    <td className="right">
                      {device.revoked
                        ? <span className="chip chip-neutral">Dicabut</span>
                        : <button className="btn-sm btn-danger" onClick={() => setRevoking(device)}>Cabut</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card-meta" style={{ marginTop: 12 }}>
            {live.length} HP aktif dari {devices.length} sesi tercatat.
          </div>
        </>
      )}

      {revoking && (
        <ConfirmDialog
          title="Cabut akses HP?"
          message={`${revoking.deviceName} langsung tidak bisa sync lagi. Catatan yang belum terkirim di HP itu tidak akan pernah sampai ke server — pastikan sudah sync sebelum mencabut.`}
          confirmLabel="Cabut akses"
          onConfirm={() => revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}
