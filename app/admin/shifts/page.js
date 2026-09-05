'use client';

import { useState } from 'react';
import { api } from '../_lib/api';
import { useLoader } from '../_lib/useLoader';
import { Alert, Card, ChipRemove, ConfirmDialog, Dialog, Field, Loading, PageHead, Toast } from '../_components/ui';
import { ICON, Plus } from '../_components/icons';

export default function ShiftsPage() {
  const { data: shifts, error, reload: load } = useLoader(
    async () => (await api.get('/api/admin/shifts')).shifts,
  );
  const [toast, setToast] = useState('');
  const [passwordFor, setPasswordFor] = useState(null);
  const [crewFor, setCrewFor] = useState(null);
  const [removingCrew, setRemovingCrew] = useState(null);

  async function removeCrew() {
    const { shiftId, crew } = removingCrew;
    await api.del(`/api/admin/shifts/${shiftId}/crew/${crew.id}`);
    setRemovingCrew(null);
    setToast(`${crew.name} dihapus dari daftar`);
    load();
  }

  if (error && !shifts) return <Alert error={error} />;
  if (!shifts) return <Loading />;

  return (
    <>
      <PageHead
        title="Shift & Crew"
        subtitle="Akun dipakai bersama satu shift, bukan per orang. Nama crew hanya untuk mempercepat input di HP."
      />

      {shifts.map((shift) => {
        const active = shift.crew.filter((c) => c.isActive);
        return (
          <Card key={shift.id}>
            <div className="card-row">
              <div className="grow">
                <div className="card-title">{shift.displayName}</div>
                <div className="card-meta">Login: <span className="mono">{shift.code.toLowerCase()}</span></div>
              </div>
              {!shift.isActive && <span className="chip chip-neutral">Nonaktif</span>}
            </div>

            <div className="crew mt-3">
              <div className="card-meta mb-3">Crew ({active.length})</div>
              {active.length === 0 ? (
                <div className="card-meta crew-none">
                  Belum ada — operator akan mengetik nama manual.
                </div>
              ) : (
                <div className="row">
                  {active.map((member) => (
                    <span key={member.id} className="chip chip-accent">
                      {member.name}
                      <ChipRemove
                        label={`Hapus ${member.name}`}
                        onClick={() => setRemovingCrew({ shiftId: shift.id, crew: member })}
                      />
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="card-actions">
              <button className="btn-sm" onClick={() => setCrewFor(shift)}>
                <Plus size={ICON.inline} aria-hidden="true" /> Tambah crew
              </button>
              <button className="btn-sm" onClick={() => setPasswordFor(shift)}>Reset password</button>
            </div>
          </Card>
        );
      })}

      {passwordFor && (
        <PasswordDialog
          shift={passwordFor}
          onClose={() => setPasswordFor(null)}
          onSaved={() => { setPasswordFor(null); setToast('Password diperbarui'); }}
        />
      )}

      {crewFor && (
        <CrewDialog
          shift={crewFor}
          onClose={() => setCrewFor(null)}
          onSaved={(name) => { setCrewFor(null); setToast(`${name} ditambahkan`); load(); }}
        />
      )}

      {removingCrew && (
        <ConfirmDialog
          title="Hapus dari daftar crew?"
          message={`${removingCrew.crew.name} tidak akan muncul lagi sebagai pilihan. Catatan yang sudah ada tetap atas namanya.`}
          onConfirm={removeCrew}
          onClose={() => setRemovingCrew(null)}
        />
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}

function PasswordDialog({ shift, onClose, onSaved }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (password !== confirm) {
      setError('Konfirmasi password tidak cocok');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await api.put(`/api/admin/shifts/${shift.id}/password`, { password });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Reset password ${shift.displayName}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert error={error} />

        <Field label="Password baru" hint="Minimal 8 karakter.">
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            required minLength={8} autoComplete="new-password"
          />
        </Field>

        <Field label="Ulangi password baru">
          <input
            type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            required minLength={8} autoComplete="new-password"
          />
        </Field>

        {/* Deliberate behaviour, worth stating so nobody assumes otherwise. */}
        <div className="hint mb-3">
          HP yang sedang login tidak ikut keluar. Untuk memutus akses sebuah HP,
          gunakan tab Devices.
        </div>

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

function CrewDialog({ shift, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post(`/api/admin/shifts/${shift.id}/crew`, { name });
      onSaved(name);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Tambah crew ${shift.displayName}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Alert error={error} />
        <Field label="Nama crew">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
        </Field>
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
