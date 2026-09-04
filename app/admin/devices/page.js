'use client';

import { useState } from 'react';
import { api } from '../_lib/api';
import { useLoader } from '../_lib/useLoader';
import { formatDateTime, relative } from '../_lib/format';
import { Alert, ConfirmDialog, Empty, Field, Loading, PageHead, Toast } from '../_components/ui';

export default function DevicesPage() {
  const { data, error, reload: load } = useLoader(async () => ({
    devices: (await api.get('/api/admin/devices')).devices,
    version: await api.get('/api/version').catch(() => null),
    apks: (await api.get('/api/admin/apk')).apks,
  }));
  const devices = data?.devices ?? null;
  const version = data?.version ?? null;
  const apks = data?.apks ?? [];
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
  const latest = apks[0] ?? null;
  // Which handsets have not taken the newest build yet. This is the number the
  // product owner is actually here for (doc 09 §3): a phone still on an old
  // version is a phone whose bugs are still live in the plant.
  const behind = latest
    ? live.filter((d) => d.appVersion && d.appVersion !== latest.version)
    : [];

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

      <ApkPanel apks={apks} latest={latest} behind={behind} onDone={(message) => { setToast(message); load(); }} />

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
                    <td className="mono">
                      {device.appVersion || '—'}
                      {latest && device.appVersion && device.appVersion !== latest.version && !device.revoked
                        ? <span className="chip chip-warn" style={{ marginLeft: 8 }}>perlu update</span>
                        : null}
                    </td>
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

/**
 * Published builds, and the form that publishes one.
 *
 * It lives on the Devices page rather than a tab of its own because the two
 * questions belong together: what is the newest build, and which handsets are
 * still behind it. Separating them means checking one page to learn a version
 * number and another to find out it matters.
 */
function ApkPanel({ apks, latest, behind, onDone }) {
  const [file, setFile] = useState(null);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function publish(event) {
    event.preventDefault();
    if (!file) return setError('Pilih file APK dulu.');
    if (!/^\d+\.\d+\.\d+$/.test(version.trim())) {
      return setError('Versi harus berbentuk x.y.z, mis. 0.3.0.');
    }

    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.set('version', version.trim());
      form.set('file', file);
      await api.postForm('/api/admin/apk', form);
      setFile(null);
      setVersion('');
      onDone(`APK ${version.trim()} terbit`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">APK</div>

      {latest ? (
        <div className="card-meta">
          Terbaru <span className="mono">{latest.version}</span> ·{' '}
          {Math.round(latest.bytes / 1024 / 1024)}MB · terbit {relative(latest.uploadedAt)}
          {apks.length > 1 ? ` · ${apks.length} build tersimpan` : ''}
        </div>
      ) : (
        <div className="card-meta">Belum ada APK di server. HP tidak akan menawarkan update.</div>
      )}

      {behind.length > 0 && (
        <div className="card-meta" style={{ marginTop: 6 }}>
          <strong>{behind.length} HP belum update</strong> — {behind.map((d) => d.deviceName).join(', ')}
        </div>
      )}

      <Alert error={error || null} />

      <form onSubmit={publish} style={{ marginTop: 12 }}>
        <Field label="File APK" hint="Hasil gradlew assembleRelease dari workstation.">
          <input
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(''); }}
          />
        </Field>

        <Field
          label="Versi"
          hint="Harus x.y.z dan belum pernah dipakai — versi yang sudah terbit tidak bisa ditimpa."
        >
          <input
            value={version}
            onChange={(event) => { setVersion(event.target.value); setError(''); }}
            placeholder="0.3.0"
            inputMode="decimal"
          />
        </Field>

        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Mengunggah…' : 'Terbitkan APK'}
        </button>
      </form>
    </div>
  );
}
