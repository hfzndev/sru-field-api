#!/usr/bin/env node
/**
 * Operator handset simulator.
 *
 * The mobile app is Phase 2 and does not exist yet, so this stands in for it:
 * it speaks the same protocol a handset will (doc 06, doc 07), keeps its own
 * local queue on disk, and only touches the network when you tell it to sync.
 * That makes the offline-first behaviour testable by hand today, and it lets
 * the Phase 2 build start against a contract that has already been exercised.
 *
 * It deliberately implements two things the server does NOT:
 *
 *   the tape-length suggestion (doc 02 §2.2), which lives on the phone so it
 *   keeps working with no signal — this is the first running implementation of
 *   the algorithm the whole feature is built around;
 *
 *   the pending/synced queue (doc 07 §1), so "nothing is lost" can actually be
 *   observed rather than taken on trust.
 *
 * Usage:
 *   node tools/operator-sim.js help
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, '.operator-sim');
const BASE_URL = process.env.SRU_BASE_URL || 'http://127.0.0.1:3000';
const DEVICE = process.env.SRU_DEVICE || 'HP-1';

/** How many past readings feed the deviation average (doc 02 §2.2). */
const DEVIATION_SAMPLE_SIZE = 5;

/* ------------------------------------------------------------------- state */

const statePath = () => path.join(STATE_DIR, `${DEVICE.replace(/[^\w-]/g, '_')}.json`);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { token: null, shiftGroup: null, shiftTime: 'pagi', operator: '', bootstrap: null, queue: [], synced: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

/* ------------------------------------------------------------------ output */

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const die = (message) => { console.error(c.red(`\n  ${message}\n`)); process.exit(1); };
const mm = (n) => `${Number(n).toLocaleString('id-ID')} mm`;

/* --------------------------------------------------------------- transport */

async function call(method, endpoint, { body, token, raw } = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${endpoint}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // What a handset sees in a dead zone. The queue is untouched, so this is
    // survivable by design — retry later.
    throw new Error(`tidak ada koneksi ke ${BASE_URL} (${err.cause?.code || err.message})`);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok && !raw) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return { status: response.status, payload };
}

/* ----------------------------------------------------- the midband algorithm

   This is the client-side half of doc 02 §2.2 — the part the server never
   computes, because the phone must be able to do it with no signal.          */

function tapeSuggestion(bootstrap, tankId, dcsLevelMm) {
  const tank = bootstrap.tanks.find((t) => t.id === tankId);
  if (!tank) die(`tangki id ${tankId} tidak ada di bootstrap`);

  const samples = (bootstrap.tankDeviation?.[tankId] || [])
    .slice(0, DEVIATION_SAMPLE_SIZE)
    .map((r) => r.levelMm - r.dcsLevelMm);

  // Fallback with no history: trust DCS as-is (doc 02 §2.2).
  const avgDeviation = samples.length
    ? samples.reduce((a, b) => a + b, 0) / samples.length
    : 0;

  const estimatedLevel = dcsLevelMm + avgDeviation;
  const suggestion = tank.heightMm - estimatedLevel;

  return {
    tank,
    samples,
    avgDeviation: Math.round(avgDeviation * 100) / 100,
    estimatedLevel: Math.round(estimatedLevel * 100) / 100,
    suggestion: Math.round(suggestion * 100) / 100,
  };
}

/* ---------------------------------------------------------------- commands */

async function login(state, [username, password]) {
  if (!username || !password) die('pakai: login <shift_a|shift_b|shift_c|shift_d> <password>');

  const { payload } = await call('POST', '/api/auth/login', {
    body: { username, password, deviceName: DEVICE, appVersion: 'sim-1.0.0' },
  });

  state.token = payload.token;
  state.shiftGroup = payload.shiftGroup.displayName;
  state.bootstrap = payload;
  state.operator = state.operator || payload.crew[0] || 'Operator';
  saveState(state);

  console.log(`\n  ${c.green('Masuk')} sebagai ${c.bold(payload.shiftGroup.displayName)} di ${DEVICE}`);
  console.log(`  Crew        : ${payload.crew.length ? payload.crew.join(', ') : c.dim('(belum diisi admin — ketik manual)')}`);
  console.log(`  Tangki      : ${payload.tanks.map((t) => `${t.code} (${mm(t.heightMm)})`).join(', ')}`);
  console.log(`  Kontraktor  : ${payload.contractors.length} · Equipment: ${payload.equipment.length} · Task: ${payload.tasks.length}`);
  console.log(`  dataVersion : ${payload.dataVersion}`);
  console.log(c.dim(`\n  Bootstrap disimpan lokal — mulai sekarang bisa kerja tanpa sinyal.\n`));
}

function requireSession(state) {
  if (!state.token) die('belum login. Jalankan: node tools/operator-sim.js login shift_a <password>');
  return state;
}

function suggest(state, [tankCode, dcs]) {
  requireSession(state);
  if (!tankCode || dcs === undefined) die('pakai: suggest <93T-401|93T-402> <levelDCS>');

  const tank = state.bootstrap.tanks.find((t) => t.code === tankCode);
  if (!tank) die(`tangki ${tankCode} tidak dikenal. Ada: ${state.bootstrap.tanks.map((t) => t.code).join(', ')}`);

  const s = tapeSuggestion(state.bootstrap, tank.id, Number(dcs));

  console.log(`\n  ${c.bold(tank.code)} — tinggi ${mm(tank.heightMm)}`);
  console.log(`  Level DCS         : ${mm(dcs)}`);
  if (s.samples.length) {
    console.log(`  Deviasi rata²     : ${c.cyan(`${s.avgDeviation > 0 ? '+' : ''}${s.avgDeviation} mm`)} dari ${s.samples.length} pengukuran terakhir`);
    console.log(c.dim(`                      (${s.samples.map((d) => (d > 0 ? `+${d}` : d)).join(', ')})`));
  } else {
    console.log(`  Deviasi rata²     : ${c.yellow('belum ada data')} — pakai DCS apa adanya`);
  }
  console.log(`  Estimasi level    : ${mm(s.estimatedLevel)}`);
  console.log(`\n  ${c.bold(c.green(`Turunkan meteran ±${mm(s.suggestion)}`))}`);
  console.log(c.dim('\n  Bandul tetap hakim akhir — kalau kosong, ulangi lebih panjang.\n'));
}

async function uploadPhoto(state, file) {
  // Photos go first so the path is already in the record when it is pushed
  // (doc 06 §5). A phone with no signal simply cannot attach one yet.
  const buffer = fs.readFileSync(file);
  const form = new FormData();
  form.append('file', new Blob([buffer]), path.basename(file));

  const response = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${state.token}` },
    body: form,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `upload gagal (${response.status})`);
  return payload.path;
}

function queueRecord(state, kind, record) {
  state.queue.push({ kind, clientId: crypto.randomUUID(), status: 'PENDING_SYNC', createdAt: new Date().toISOString(), record });
  saveState(state);
}

function measure(state, args) {
  requireSession(state);
  const [tankCode, dcs, tape, bandul, attempts = '1'] = args;
  if (!tankCode || tape === undefined || bandul === undefined) {
    die('pakai: measure <93T-401> <levelDCS|-> <panjangMeteran> <bandul> [percobaan]');
  }

  const tank = state.bootstrap.tanks.find((t) => t.code === tankCode);
  if (!tank) die(`tangki ${tankCode} tidak dikenal`);

  const dcsLevelMm = dcs === '-' ? null : Number(dcs);
  const levelMm = tank.heightMm - Number(tape) + Number(bandul);
  const deviationMm = dcsLevelMm === null ? null : levelMm - dcsLevelMm;

  queueRecord(state, 'readings', {
    tankId: tank.id,
    dcsLevelMm,
    tapeLengthMm: Number(tape),
    bandulSulfurMm: Number(bandul),
    attempts: Number(attempts),
    operatorName: state.operator,
    shiftGroup: state.shiftGroup,
    shiftTime: state.shiftTime,
    note: '',
    readingAt: new Date().toISOString(),
  });

  console.log(`\n  ${c.bold(tank.code)}`);
  console.log(`  Level aktual  : ${c.bold(mm(levelMm))}   ${c.dim(`(${tank.heightMm} − ${tape} + ${bandul})`)}`);
  console.log(`  Selisih DCS   : ${deviationMm === null ? c.dim('—') : c.cyan(`${deviationMm > 0 ? '+' : ''}${deviationMm} mm`)}`);
  console.log(`\n  ${c.green('Tersimpan')} · ${badge(state)}`);
  console.log(c.dim('  Angka di atas hanya pratinjau — server menghitung ulang saat sync.\n'));
}

function activity(state, args) {
  requireSession(state);
  const [type, description, contractorName = ''] = args;
  if (!type || !description) die('pakai: activity <OPERATOR|KONTRAKTOR> "<deskripsi>" ["<nama kontraktor>"]');
  if (type === 'KONTRAKTOR' && !contractorName) die('aktivitas KONTRAKTOR wajib menyertakan nama kontraktor');

  queueRecord(state, 'activities', {
    type,
    description,
    contractorName,
    unitArea: '',
    activityAt: new Date().toISOString(),
    operatorName: state.operator,
    shiftGroup: state.shiftGroup,
    shiftTime: state.shiftTime,
  });

  console.log(`\n  ${c.green('Tercatat')}: ${description}${contractorName ? ` (${contractorName})` : ''}`);
  console.log(`  ${badge(state)}
`);
}

async function cleaningStart(state, args) {
  requireSession(state);
  const [location, photo] = args;
  if (!location) die('pakai: cleaning-start "<lokasi>" [fotoSebelum.jpg]');

  let beforePhoto = '';
  if (photo) beforePhoto = await uploadPhoto(state, photo);

  queueRecord(state, 'cleaning', {
    location,
    note: '',
    beforePhoto,
    beforePhotoAt: beforePhoto ? new Date().toISOString() : null,
    afterPhoto: '',
    afterPhotoAt: null,
    operatorName: state.operator,
    shiftGroup: state.shiftGroup,
    shiftTime: state.shiftTime,
  });

  const entry = state.queue.at(-1);
  console.log(`\n  ${c.green('Sesi dimulai')} — ${location}`);
  console.log(`  clientId: ${c.dim(entry.clientId)}`);
  console.log(c.dim('  Setelah dibersihkan: cleaning-finish <clientId> [fotoSesudah.jpg]\n'));
}

async function cleaningFinish(state, args) {
  requireSession(state);
  const [clientId, photo] = args;
  if (!clientId) die('pakai: cleaning-finish <clientId> [fotoSesudah.jpg]');

  // The session may already be SYNCED; completing it moves it back to
  // PENDING_SYNC, which is the one place that transition is allowed (doc 07 §1).
  const entry = [...state.queue, ...state.synced].find((e) => e.clientId === clientId && e.kind === 'cleaning');
  if (!entry) die(`sesi cleaning ${clientId} tidak ditemukan`);

  entry.record.afterPhoto = photo ? await uploadPhoto(state, photo) : `uploads/${crypto.randomUUID()}.jpg`;
  entry.record.afterPhotoAt = new Date().toISOString();
  entry.status = 'PENDING_SYNC';

  if (!state.queue.includes(entry)) {
    state.synced = state.synced.filter((e) => e !== entry);
    state.queue.push(entry);
  }
  saveState(state);

  console.log(`\n  ${c.green('Sesi selesai')} — akan dikirim sebagai update, bukan baris baru.`);
  console.log(`  ${badge(state)}
`);
}

/** Records that will be retried on the next sync. */
const pending = (state) => state.queue.filter((e) => e.status === 'PENDING_SYNC');

/**
 * What the badge counts: everything not yet on the server, rejected records
 * included. A SYNC_ERROR is still unsent, and showing "0 belum terkirim" while
 * one sits rejected tells the operator their work arrived when it did not —
 * precisely the impression the offline design exists to prevent.
 */
const unsent = (state) => state.queue.filter((e) => e.status !== 'SYNCED');

function badge(state) {
  const count = unsent(state).length;
  return count === 0 ? c.green('⬆ 0 belum terkirim') : c.yellow(`⬆ ${count} belum terkirim`);
}

async function sync(state) {
  requireSession(state);
  const queued = pending(state);
  if (queued.length === 0) return console.log(`\n  ${c.dim('Tidak ada yang perlu dikirim.')}\n`);

  const batch = { readings: [], cleaning: [], activities: [], taskLogs: [] };
  for (const entry of queued) batch[entry.kind].push({ clientId: entry.clientId, ...entry.record });

  console.log(`\n  Mengirim ${queued.length} catatan…`);

  const { payload } = await call('POST', '/api/sync', { body: batch, token: state.token });

  for (const ack of payload.acked) {
    const entry = state.queue.find((e) => e.clientId === ack.clientId);
    if (!entry) continue;
    entry.status = 'SYNCED';
    entry.serverId = ack.serverId;

    // The server's number wins. If the phone's preview disagreed, this is where
    // it is corrected (doc 07 §2.4a).
    if (ack.levelMm !== undefined) {
      const preview = entry.record.tankLevelPreview;
      entry.record.levelMm = ack.levelMm;
      if (preview !== undefined && preview !== ack.levelMm) {
        console.log(c.yellow(`  ! level dikoreksi server: ${preview} → ${ack.levelMm}`));
      }
    }
  }

  for (const dup of payload.duplicates) {
    const entry = state.queue.find((e) => e.clientId === dup.clientId);
    if (entry) { entry.status = 'SYNCED'; entry.serverId = dup.serverId; }
  }

  for (const err of payload.errors || []) {
    const entry = state.queue.find((e) => e.clientId === err.clientId);
    if (entry) { entry.status = 'SYNC_ERROR'; entry.error = err.error; }
  }

  // SYNCED records move out of the queue; anything rejected stays put, which is
  // the whole "nothing is lost" guarantee made visible.
  state.synced.push(...state.queue.filter((e) => e.status === 'SYNCED'));
  state.queue = state.queue.filter((e) => e.status !== 'SYNCED');
  saveState(state);

  console.log(`  ${c.green(`✓ ${payload.acked.length} diterima`)}`
    + (payload.duplicates.length ? ` · ${c.dim(`${payload.duplicates.length} duplikat (aman)`)}` : '')
    + (payload.errors?.length ? ` · ${c.red(`${payload.errors.length} ditolak`)}` : ''));

  for (const err of payload.errors || []) {
    console.log(`  ${c.red('✗')} ${err.error.code}: ${err.error.message}`);
  }
  console.log(`  ${badge(state)}
`);
}

async function pull(state) {
  requireSession(state);
  const since = state.bootstrap.dataVersion ?? 0;
  const { payload } = await call('GET', `/api/pull?since=${since}`, { token: state.token });

  const master = payload.master;
  const changed = Object.entries(master).filter(([, rows]) => rows.length);

  console.log(`\n  dataVersion ${since} → ${payload.dataVersion}`);
  console.log(`  Master berubah : ${changed.length ? changed.map(([k, v]) => `${k} ${v.length}`).join(', ') : c.dim('tidak ada')}`);
  console.log(`  Window 7 hari  : ${payload.recent.readings.length} pengukuran, ${payload.recent.activities.length} aktivitas, ${payload.recent.cleaning.length} bersih-bersih`);

  // Refresh the cached bootstrap so the tape suggestion uses the newest
  // deviations without needing another login.
  if (master.tanks.length) state.bootstrap.tanks = master.tanks;
  state.bootstrap.dataVersion = payload.dataVersion;

  const byTank = {};
  for (const r of payload.recent.readings) {
    if (r.dcsLevelMm === null) continue;
    (byTank[r.tankId] = byTank[r.tankId] || []).push({ levelMm: r.levelMm, dcsLevelMm: r.dcsLevelMm, readingAt: r.readingAt });
  }
  for (const [tankId, rows] of Object.entries(byTank)) {
    state.bootstrap.tankDeviation[tankId] = rows.slice(0, DEVIATION_SAMPLE_SIZE);
  }
  saveState(state);
  console.log(c.dim('  Cache deviasi diperbarui — saran meteran ikut menyesuaikan.\n'));
}

function status(state) {
  console.log(`\n  Device      : ${c.bold(DEVICE)}  ${c.dim(BASE_URL)}`);
  console.log(`  Sesi        : ${state.token ? `${c.green(state.shiftGroup)} ${state.shiftTime}` : c.red('belum login')}`);
  console.log(`  Operator    : ${state.operator || c.dim('—')}`);

  const failed = state.queue.filter((e) => e.status === 'SYNC_ERROR');

  console.log(`\n  ${badge(state)}`
    + `   ${c.dim(`${state.synced.length} sudah terkirim`)}`
    + (failed.length ? `   ${c.red(`${failed.length} ditolak — perlu diperbaiki`)}` : ''));

  for (const entry of state.queue) {
    const mark = entry.status === 'SYNC_ERROR' ? c.red('✗') : c.yellow('•');
    const label = entry.kind === 'readings'
      ? `pengukuran tangki #${entry.record.tankId} (meteran ${entry.record.tapeLengthMm})`
      : entry.kind === 'activities' ? `${entry.record.type}: ${entry.record.description}`
        : `cleaning: ${entry.record.location}${entry.record.afterPhoto ? ' (selesai)' : ' (menunggu foto sesudah)'}`;
    console.log(`    ${mark} ${label}`);
    if (entry.error) console.log(`      ${c.red(entry.error.message)}`);
  }
  console.log();
}

function reset() {
  fs.rmSync(statePath(), { force: true });
  console.log(`\n  ${c.green('State HP dihapus')} — seperti aplikasi baru diinstal.\n`);
}

function help() {
  console.log(`
  ${c.bold('Simulator HP operator')} — berbicara protokol yang sama dengan aplikasi Phase 2.

  ${c.dim('Server:')} ${BASE_URL}   ${c.dim('Device:')} ${DEVICE}
  ${c.dim('Ubah dengan SRU_BASE_URL / SRU_DEVICE.')}

  ${c.bold('Sesi')}
    login <shift_a> <password>        masuk + ambil bootstrap (butuh sinyal, sekali per shift)
    status                            lihat antrean dan sesi
    reset                             hapus state HP ini

  ${c.bold('Pengukuran tangki')} ${c.dim('(SOP midband, doc 02 §2)')}
    suggest <93T-401> <levelDCS>      saran panjang meteran dari deviasi terakhir
    measure <93T-401> <dcs|-> <meteran> <bandul> [percobaan]

  ${c.bold('Catatan lapangan')}
    activity OPERATOR "buka valve drain kolom A"
    activity KONTRAKTOR "pengecatan kompresor" "PT Tejo Lomanis"
    cleaning-start "lantai U-93" [foto.jpg]
    cleaning-finish <clientId> [foto.jpg]

  ${c.bold('Sinkronisasi')}
    sync                              kirim antrean ke server
    pull                              tarik master + window 7 hari

  ${c.dim('Semua perintah selain login/sync/pull bekerja tanpa jaringan.')}
`);
}

/* -------------------------------------------------------------------- main */

const [command, ...args] = process.argv.slice(2);
const state = loadState();

const commands = {
  login: () => login(state, args),
  suggest: () => suggest(state, args),
  measure: () => measure(state, args),
  activity: () => activity(state, args),
  'cleaning-start': () => cleaningStart(state, args),
  'cleaning-finish': () => cleaningFinish(state, args),
  sync: () => sync(state),
  pull: () => pull(state),
  status: () => status(state),
  reset: () => reset(),
  help: () => help(),
};

(async () => {
  const run = commands[command] || commands.help;
  try {
    await run();
  } catch (err) {
    die(err.message);
  }
})();
