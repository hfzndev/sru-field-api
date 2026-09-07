import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listSheets, POST as createSheet } from '@/app/api/admin/sheets/route';
import {
  DELETE as deleteSheet, GET as getSheet, PUT as updateSheet,
} from '@/app/api/admin/sheets/[id]/route';
import { POST as addColumn } from '@/app/api/admin/sheets/[id]/columns/route';
import {
  DELETE as deleteColumn, PUT as updateColumn,
} from '@/app/api/admin/sheets/[id]/columns/[columnId]/route';
import { POST as addRows } from '@/app/api/admin/sheets/[id]/rows/route';
import {
  DELETE as deleteRow, PUT as updateRow,
} from '@/app/api/admin/sheets/[id]/rows/[rowId]/route';
import { POST as fillCell } from '@/app/api/admin/sheets/[id]/cells/route';
import { buildPull } from '@/lib/pull';
import { createSession, SESSION_COOKIE } from '@/lib/session';
import { SHEET_LIMITS } from '@/lib/validation';
import {
  cleanupTempDbs, postRequest, samplePhotoPath, seedAdmin, seedShiftAccount, useTempDb,
} from './helpers/seed.js';

/**
 * The supervisor's half of lembar tugas (doc 06 §6).
 *
 * Two rules are checked on every mutation here rather than trusted: an
 * admin_actions row is written, and dataVersion moves so the design actually
 * reaches a handset. Both have failed silently before (lib/admin.js header).
 */

const BASE = 'http://localhost';

let db;
let cookie;

beforeEach(() => {
  db = useTempDb();
  process.env.SESSION_SECRET = 'a'.repeat(64);
  seedAdmin(db);
  seedShiftAccount(db);
  cookie = { cookie: `${SESSION_COOKIE}=${createSession('admin')}` };
});
afterAll(cleanupTempDbs);

const ctx = (params) => ({ params: Promise.resolve(params) });
const get = (url, headers = cookie) => new Request(`${BASE}${url}`, { method: 'GET', headers });
const post = (url, body, headers = cookie) => postRequest(`${BASE}${url}`, body, headers);
const put = (url, body, headers = cookie) => new Request(`${BASE}${url}`, {
  method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const del = (url, headers = cookie) => new Request(`${BASE}${url}`, { method: 'DELETE', headers });

const auditCount = () => db.prepare('SELECT COUNT(*) n FROM admin_actions').get().n;
const version = () => Number(db.prepare("SELECT value FROM meta WHERE key = 'dataVersion'").get().value);

/** The worked example from the brief: equipment name, wide shot, close shot. */
const PUMP_SHEET = {
  title: 'Foto Pompa Area 93',
  description: 'Foto setiap pompa dari jauh dan dekat',
  columns: [
    { label: 'Keterangan', kind: 'LABEL', isRequired: false },
    { label: 'Foto Wide', kind: 'PHOTO', examplePhoto: samplePhotoPath('a') },
    { label: 'Foto Close', kind: 'PHOTO', examplePhoto: samplePhotoPath('b') },
  ],
  rows: [{ label: '93P-101A' }, { label: '93P-101B' }, { label: '93P-102A' }],
};

async function createPumpSheet(overrides = {}) {
  const response = await createSheet(post('/api/admin/sheets', { ...PUMP_SHEET, ...overrides }));
  expect(response.status).toBe(201);
  return (await response.json()).sheet;
}

async function detail(id) {
  return (await (await getSheet(get(`/api/admin/sheets/${id}`), ctx({ id: String(id) }))).json());
}

/* ------------------------------------------------------------------ create */

describe('creating a lembar tugas', () => {
  it('writes the sheet, its columns and its rows in one request', async () => {
    const sheet = await createPumpSheet();
    const body = await detail(sheet.id);

    expect(body.sheet.title).toBe('Foto Pompa Area 93');
    expect(body.columns.map((c) => c.label)).toEqual(['Keterangan', 'Foto Wide', 'Foto Close']);
    expect(body.rows.map((r) => r.label)).toEqual(['93P-101A', '93P-101B', '93P-102A']);
    expect(body.columns[1].examplePhoto).toBe(samplePhotoPath('a'));
  });

  it('audits the creation and moves dataVersion', async () => {
    const before = version();
    await createPumpSheet();

    expect(version()).toBeGreaterThan(before);
    expect(auditCount()).toBe(1);
    expect(db.prepare('SELECT entity FROM admin_actions').get().entity).toBe('task_sheet');
  });

  it('stamps the columns and rows, not only the sheet', async () => {
    // Stamping the sheet alone would ship a headerless lembar to any handset
    // that had already pulled once (lib/sheets.js stampSheet).
    const before = version();
    const sheet = await createPumpSheet();

    const delta = buildPull(db, { id: 1, code: 'SHIFT_A', displayName: 'Shift A' }, before);
    expect(delta.master.sheets.map((s) => s.id)).toEqual([sheet.id]);
    expect(delta.master.sheetColumns).toHaveLength(3);
    expect(delta.master.sheetRows).toHaveLength(3);
  });

  it('rejects an unknown column kind', async () => {
    const response = await createSheet(post('/api/admin/sheets', {
      title: 'X', columns: [{ label: 'Video', kind: 'VIDEO' }],
    }));
    expect(response.status).toBe(400);
  });

  it('rejects an example photo that is not an upload path', async () => {
    const response = await createSheet(post('/api/admin/sheets', {
      title: 'X', columns: [{ label: 'Foto', kind: 'PHOTO', examplePhoto: '../../etc/passwd' }],
    }));
    expect(response.status).toBe(400);
  });

  it('refuses more columns than a handset can show one row at a time', async () => {
    const columns = Array.from({ length: SHEET_LIMITS.columns + 1 }, (_, i) => ({ label: `K${i}` }));
    const response = await createSheet(post('/api/admin/sheets', { title: 'X', columns }));
    expect(response.status).toBe(400);
  });
});

/* -------------------------------------------------------------------- list */

describe('listing lembar tugas', () => {
  it('reports progress against required fillable columns only', async () => {
    const sheet = await createPumpSheet();
    const body = await detail(sheet.id);

    // Three rows, two required photo columns; the LABEL column is not counted.
    expect(body.progress).toEqual({ filled: 0, total: 6, rowsDone: 0, rows: 3 });

    const [, wide, close] = body.columns;
    await fillCell(post(`/api/admin/sheets/${sheet.id}/cells`, {
      rowId: body.rows[0].id, columnId: wide.id, photoPath: samplePhotoPath('c'),
    }), ctx({ id: String(sheet.id) }));
    await fillCell(post(`/api/admin/sheets/${sheet.id}/cells`, {
      rowId: body.rows[0].id, columnId: close.id, photoPath: samplePhotoPath('d'),
    }), ctx({ id: String(sheet.id) }));

    const listed = await (await listSheets(get('/api/admin/sheets'))).json();
    expect(listed.sheets[0].progress).toEqual({ filled: 2, total: 6, rowsDone: 1, rows: 3 });
  });

  it('hides a deleted lembar from the list', async () => {
    const sheet = await createPumpSheet();
    await deleteSheet(del(`/api/admin/sheets/${sheet.id}`), ctx({ id: String(sheet.id) }));

    expect((await (await listSheets(get('/api/admin/sheets'))).json()).sheets).toEqual([]);
  });
});

/* ----------------------------------------------------------- editing design */

describe('editing a published lembar', () => {
  it('appends a column and stamps the sheet', async () => {
    const sheet = await createPumpSheet();
    const before = version();

    const response = await addColumn(
      post(`/api/admin/sheets/${sheet.id}/columns`, { label: 'Catatan', kind: 'TEXT', isRequired: false }),
      ctx({ id: String(sheet.id) }),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).column.sortOrder).toBe(3);
    expect(version()).toBeGreaterThan(before);
  });

  it('refuses a thirteenth column', async () => {
    const columns = Array.from({ length: SHEET_LIMITS.columns }, (_, i) => ({ label: `K${i}` }));
    const sheet = await createPumpSheet({ columns });

    const response = await addColumn(
      post(`/api/admin/sheets/${sheet.id}/columns`, { label: 'Satu lagi' }),
      ctx({ id: String(sheet.id) }),
    );
    expect(response.status).toBe(409);
  });

  it('soft-deletes a column, keeping the cells filled under it', async () => {
    const sheet = await createPumpSheet();
    const body = await detail(sheet.id);
    const wide = body.columns[1];

    await fillCell(post(`/api/admin/sheets/${sheet.id}/cells`, {
      rowId: body.rows[0].id, columnId: wide.id, photoPath: samplePhotoPath('c'),
    }), ctx({ id: String(sheet.id) }));

    await deleteColumn(
      del(`/api/admin/sheets/${sheet.id}/columns/${wide.id}`),
      ctx({ id: String(sheet.id), columnId: String(wide.id) }),
    );

    const after = await detail(sheet.id);
    expect(after.columns.map((c) => c.label)).toEqual(['Keterangan', 'Foto Close']);
    expect(db.prepare('SELECT COUNT(*) n FROM task_sheet_cells').get().n).toBe(1);
  });

  it('renames a column without touching its position', async () => {
    const sheet = await createPumpSheet();
    const wide = (await detail(sheet.id)).columns[1];

    await updateColumn(
      put(`/api/admin/sheets/${sheet.id}/columns/${wide.id}`, { label: 'Foto Jauh', kind: 'PHOTO' }),
      ctx({ id: String(sheet.id), columnId: String(wide.id) }),
    );

    const after = (await detail(sheet.id)).columns;
    expect(after.map((c) => c.label)).toEqual(['Keterangan', 'Foto Jauh', 'Foto Close']);
  });

  it('appends pasted rows to the end', async () => {
    const sheet = await createPumpSheet();

    const response = await addRows(
      post(`/api/admin/sheets/${sheet.id}/rows`, { rows: [{ label: '93P-103A' }, { label: '93P-103B' }] }),
      ctx({ id: String(sheet.id) }),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).rows.map((r) => r.label)).toEqual([
      '93P-101A', '93P-101B', '93P-102A', '93P-103A', '93P-103B',
    ]);
  });

  it('refuses to push a lembar past the row limit', async () => {
    const sheet = await createPumpSheet();
    const rows = Array.from({ length: SHEET_LIMITS.rows }, (_, i) => ({ label: `R${i}` }));

    const response = await addRows(
      post(`/api/admin/sheets/${sheet.id}/rows`, { rows }),
      ctx({ id: String(sheet.id) }),
    );
    expect(response.status).toBe(409);
  });

  it('renames and soft-deletes a row', async () => {
    const sheet = await createPumpSheet();
    const row = (await detail(sheet.id)).rows[0];

    await updateRow(
      put(`/api/admin/sheets/${sheet.id}/rows/${row.id}`, { label: '93P-101A/B' }),
      ctx({ id: String(sheet.id), rowId: String(row.id) }),
    );
    expect((await detail(sheet.id)).rows[0].label).toBe('93P-101A/B');

    await deleteRow(
      del(`/api/admin/sheets/${sheet.id}/rows/${row.id}`),
      ctx({ id: String(sheet.id), rowId: String(row.id) }),
    );
    expect((await detail(sheet.id)).rows.map((r) => r.label)).toEqual(['93P-101B', '93P-102A']);
  });

  it('closes a lembar through status, keeping it readable', async () => {
    const sheet = await createPumpSheet();

    await updateSheet(
      put(`/api/admin/sheets/${sheet.id}`, { title: sheet.title, status: 'DONE' }),
      ctx({ id: String(sheet.id) }),
    );

    expect((await detail(sheet.id)).sheet.status).toBe('DONE');
  });
});

/* ------------------------------------------------------------ filling cells */

describe('the supervisor filling cells', () => {
  it('writes a cell attributed to the admin, not to a shift', async () => {
    const sheet = await createPumpSheet();
    const body = await detail(sheet.id);

    const response = await fillCell(post(`/api/admin/sheets/${sheet.id}/cells`, {
      rowId: body.rows[0].id, columnId: body.columns[1].id, photoPath: samplePhotoPath('c'),
    }), ctx({ id: String(sheet.id) }));

    expect(response.status).toBe(201);
    const stored = db.prepare('SELECT * FROM task_sheet_cells').get();
    expect(stored.filled_by_name).toBe('admin');
    expect(stored.shift_group).toBe('');
  });

  it('appends rather than overwriting, so the correction and the original both survive', async () => {
    const sheet = await createPumpSheet();
    const body = await detail(sheet.id);
    const target = { rowId: body.rows[0].id, columnId: body.columns[1].id };

    await fillCell(post(`/api/admin/sheets/${sheet.id}/cells`, { ...target, photoPath: samplePhotoPath('c') }), ctx({ id: String(sheet.id) }));
    const second = await fillCell(post(`/api/admin/sheets/${sheet.id}/cells`, { ...target, photoPath: samplePhotoPath('d') }), ctx({ id: String(sheet.id) }));

    expect(db.prepare('SELECT COUNT(*) n FROM task_sheet_cells').get().n).toBe(2);
    const cells = (await second.json()).cells;
    expect(cells).toHaveLength(1);
    expect(cells[0].photoPath).toBe(samplePhotoPath('d'));
  });

  it('refuses a LABEL column, which holds no cell', async () => {
    const sheet = await createPumpSheet();
    const body = await detail(sheet.id);

    const response = await fillCell(post(`/api/admin/sheets/${sheet.id}/cells`, {
      rowId: body.rows[0].id, columnId: body.columns[0].id, valueText: 'apa saja',
    }), ctx({ id: String(sheet.id) }));

    expect(response.status).toBe(409);
  });

  it('refuses a row from a different lembar', async () => {
    const sheet = await createPumpSheet();
    const other = await createPumpSheet({ title: 'Lembar lain' });
    const body = await detail(sheet.id);
    const otherRow = (await detail(other.id)).rows[0];

    const response = await fillCell(post(`/api/admin/sheets/${sheet.id}/cells`, {
      rowId: otherRow.id, columnId: body.columns[1].id, photoPath: samplePhotoPath('c'),
    }), ctx({ id: String(sheet.id) }));

    expect(response.status).toBe(404);
  });

  it('audits every fill', async () => {
    const sheet = await createPumpSheet();
    const body = await detail(sheet.id);
    const before = auditCount();

    await fillCell(post(`/api/admin/sheets/${sheet.id}/cells`, {
      rowId: body.rows[0].id, columnId: body.columns[1].id, photoPath: samplePhotoPath('c'),
    }), ctx({ id: String(sheet.id) }));

    expect(auditCount()).toBe(before + 1);
  });
});

/* -------------------------------------------------------------------- auth */

describe('lembar tugas routes without a session', () => {
  it('refuses every one of them', async () => {
    const noCookie = {};
    for (const call of [
      () => listSheets(get('/api/admin/sheets', noCookie)),
      () => createSheet(post('/api/admin/sheets', { title: 'X' }, noCookie)),
      () => getSheet(get('/api/admin/sheets/1', noCookie), ctx({ id: '1' })),
      () => updateSheet(put('/api/admin/sheets/1', { title: 'X' }, noCookie), ctx({ id: '1' })),
      () => deleteSheet(del('/api/admin/sheets/1', noCookie), ctx({ id: '1' })),
      () => addColumn(post('/api/admin/sheets/1/columns', { label: 'X' }, noCookie), ctx({ id: '1' })),
      () => addRows(post('/api/admin/sheets/1/rows', { rows: [{ label: 'X' }] }, noCookie), ctx({ id: '1' })),
      () => fillCell(post('/api/admin/sheets/1/cells', { rowId: 1, columnId: 1 }, noCookie), ctx({ id: '1' })),
    ]) {
      expect((await call()).status).toBe(401);
    }
  });
});
