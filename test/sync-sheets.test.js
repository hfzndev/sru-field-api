import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildBootstrap } from '@/lib/bootstrap';
import { buildPull } from '@/lib/pull';
import { processSync, SYNC_ERRORS } from '@/lib/sync';
import { parse, syncSchema } from '@/lib/validation';
import {
  cleanupTempDbs, samplePhotoPath, seedSheet, seedShiftAccount, useTempDb,
} from './helpers/seed.js';

/**
 * Lembar tugas over the sync boundary (doc 05 §4, doc 07 §4).
 *
 * The cases that matter here are the ones a handset can only hit after being
 * offline for a while: a row it invented, a lembar closed behind its back, a
 * batch it sends twice because the ack never arrived.
 */

const ACCOUNT = { id: 1, code: 'SHIFT_A', displayName: 'Shift A' };

let db;
let sheet;

beforeEach(() => {
  db = useTempDb();
  seedShiftAccount(db);
  sheet = seedSheet(db);
});
afterAll(cleanupTempDbs);

const uuid = () => randomUUID();

function cell(overrides = {}) {
  return {
    clientId: uuid(),
    sheetId: sheet.sheetId,
    rowId: sheet.rowIds[0],
    columnId: sheet.columnIds[0],
    photoPath: samplePhotoPath(),
    operatorName: 'Budi',
    shiftGroup: 'Shift A',
    shiftTime: 'pagi',
    filledAt: '2026-09-02T01:10:00.000Z',
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    clientId: uuid(),
    sheetId: sheet.sheetId,
    label: '93P-104C',
    operatorName: 'Budi',
    shiftGroup: 'Shift A',
    shiftTime: 'pagi',
    ...overrides,
  };
}

function sync(payload, account = ACCOUNT) {
  const parsed = parse(syncSchema, payload);
  expect(parsed.ok, JSON.stringify(parsed.details)).toBe(true);
  return processSync(db, parsed.data, account);
}

const errorCodes = (result) => result.errors.map((e) => e.error.code);

/* ------------------------------------------------------------------- cells */

describe('sheet cells', () => {
  it('accepts a cell against a server-known row', () => {
    const result = sync({ sheetCells: [cell()] });

    expect(result.errors).toEqual([]);
    expect(result.acked).toHaveLength(1);
    expect(result.acked[0].rowId).toBe(sheet.rowIds[0]);
  });

  it('stamps the authenticated shift, not the one the payload claimed', () => {
    sync({ sheetCells: [cell({ shiftGroup: 'Shift D' })] });

    const stored = db.prepare('SELECT shift_group FROM task_sheet_cells').get();
    expect(stored.shift_group).toBe('Shift A');
  });

  it('treats a replayed batch as duplicates, not as new cells', () => {
    const batch = { sheetCells: [cell(), cell({ columnId: sheet.columnIds[1] })] };

    const first = sync(batch);
    const second = sync(batch);

    expect(first.acked).toHaveLength(2);
    expect(second.acked).toEqual([]);
    expect(second.duplicates).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) n FROM task_sheet_cells').get().n).toBe(2);
  });

  it('keeps both writes when the same cell is filled twice — append-only', () => {
    sync({ sheetCells: [cell({ filledAt: '2026-09-02T01:00:00.000Z' })] });
    sync({ sheetCells: [cell({ filledAt: '2026-09-02T03:00:00.000Z', photoPath: samplePhotoPath('b') })] });

    expect(db.prepare('SELECT COUNT(*) n FROM task_sheet_cells').get().n).toBe(2);

    // The later filled_at is what a reader sees.
    const current = buildPull(db, ACCOUNT, 0).recent.sheetCells;
    expect(current).toHaveLength(1);
    expect(current[0].photoPath).toBe(samplePhotoPath('b'));
  });

  it('rejects an unknown column', () => {
    const result = sync({ sheetCells: [cell({ columnId: 9999 })] });
    expect(errorCodes(result)).toEqual([SYNC_ERRORS.SHEET_COLUMN_NOT_FOUND]);
  });

  it('rejects a column belonging to a different lembar', () => {
    const other = seedSheet(db, { title: 'Lembar lain' });
    const result = sync({ sheetCells: [cell({ columnId: other.columnIds[0] })] });
    expect(errorCodes(result)).toEqual([SYNC_ERRORS.SHEET_COLUMN_NOT_FOUND]);
  });

  it('rejects a LABEL column, which holds no cell', () => {
    const labelled = seedSheet(db, {
      columns: [{ label: 'Keterangan', kind: 'LABEL', isRequired: 0 }],
    });
    const result = sync({
      sheetCells: [cell({
        sheetId: labelled.sheetId,
        rowId: labelled.rowIds[0],
        columnId: labelled.columnIds[0],
      })],
    });
    expect(errorCodes(result)).toEqual([SYNC_ERRORS.SHEET_COLUMN_NOT_FILLABLE]);
  });

  it('rejects a lembar closed while the phone was offline, keeping the other cells', () => {
    const closed = seedSheet(db, { status: 'DONE' });
    const result = sync({
      sheetCells: [
        cell({ sheetId: closed.sheetId, rowId: closed.rowIds[0], columnId: closed.columnIds[0] }),
        cell(),
      ],
    });

    expect(errorCodes(result)).toEqual([SYNC_ERRORS.SHEET_CLOSED]);
    expect(result.acked).toHaveLength(1);
  });

  it('hides a lembar belonging to another shift behind the same not-found answer', () => {
    const other = seedSheet(db, { assignedShift: 'Shift B' });
    const result = sync({
      sheetCells: [cell({
        sheetId: other.sheetId,
        rowId: other.rowIds[0],
        columnId: other.columnIds[0],
      })],
    });
    expect(errorCodes(result)).toEqual([SYNC_ERRORS.SHEET_NOT_FOUND]);
  });
});

/* -------------------------------------------------------------------- rows */

describe('operator-added rows', () => {
  it('appends the row and records who added it', () => {
    const result = sync({ sheetRows: [row()] });

    expect(result.acked).toHaveLength(1);
    const stored = db.prepare('SELECT * FROM task_sheet_rows WHERE label = ?').get('93P-104C');
    expect(stored.added_by_name).toBe('Budi');
    // Two seeded rows at 0 and 1, so the appended one lands at 2.
    expect(stored.sort_order).toBe(2);
  });

  it('stamps the row so other handsets receive it on the next delta', () => {
    const before = buildPull(db, ACCOUNT, 0).dataVersion;
    sync({ sheetRows: [row()] });

    const delta = buildPull(db, ACCOUNT, before);
    expect(delta.master.sheetRows.map((r) => r.label)).toEqual(['93P-104C']);
  });

  it('refuses when the supervisor locked the row list', () => {
    const locked = seedSheet(db, { allowOperatorRows: 0 });
    const result = sync({ sheetRows: [row({ sheetId: locked.sheetId })] });
    expect(errorCodes(result)).toEqual([SYNC_ERRORS.SHEET_ROWS_LOCKED]);
  });

  it('resolves a cell that addresses a row created in the same batch', () => {
    const newRow = row();
    const result = sync({
      sheetRows: [newRow],
      sheetCells: [cell({ rowId: null, rowClientId: newRow.clientId })],
    });

    expect(result.errors).toEqual([]);
    const rowId = db.prepare('SELECT id FROM task_sheet_rows WHERE client_id = ?').get(newRow.clientId).id;
    expect(db.prepare('SELECT row_id FROM task_sheet_cells').get().row_id).toBe(rowId);
  });

  it('rejects a cell whose row client_id was never sent', () => {
    const result = sync({ sheetCells: [cell({ rowId: null, rowClientId: uuid() })] });
    expect(errorCodes(result)).toEqual([SYNC_ERRORS.SHEET_ROW_NOT_FOUND]);
  });

  it('rejects a cell that names neither a row id nor a row client_id', () => {
    const parsed = parse(syncSchema, { sheetCells: [cell({ rowId: null })] });
    expect(parsed.ok).toBe(false);
  });

  it('replays a row batch as a duplicate rather than a second row', () => {
    const batch = { sheetRows: [row()] };
    sync(batch);
    const second = sync(batch);

    expect(second.duplicates).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) n FROM task_sheet_rows WHERE label = '93P-104C'").get().n).toBe(1);
  });
});

/* ------------------------------------------------------------------- pull */

describe('lembar tugas over pull and bootstrap', () => {
  it('ships the design and the filled cells at login', () => {
    sync({ sheetCells: [cell()] });

    const bootstrap = buildBootstrap(db, { id: 1, code: 'SHIFT_A', display_name: 'Shift A' });
    expect(bootstrap.sheets.map((s) => s.title)).toEqual(['Foto Pompa Area 93']);
    expect(bootstrap.sheetColumns).toHaveLength(2);
    expect(bootstrap.sheetRows).toHaveLength(2);
    expect(bootstrap.sheetCells).toHaveLength(1);
  });

  it('does not leak a lembar assigned to another shift', () => {
    seedSheet(db, { title: 'Khusus Shift B', assignedShift: 'Shift B' });

    const bootstrap = buildBootstrap(db, { id: 1, code: 'SHIFT_A', display_name: 'Shift A' });
    expect(bootstrap.sheets.map((s) => s.title)).toEqual(['Foto Pompa Area 93']);
    expect(buildPull(db, ACCOUNT, 0).master.sheets).toHaveLength(1);
  });

  it('shows one shift the cells another shift already filled', () => {
    sync({ sheetCells: [cell()] }, ACCOUNT);

    const shiftB = buildPull(db, { id: 2, code: 'SHIFT_B', displayName: 'Shift B' }, 0);
    expect(shiftB.recent.sheetCells).toHaveLength(1);
    expect(shiftB.recent.sheetCells[0].shiftGroup).toBe('Shift A');
  });

  it('omits a closed lembar from the cell window', () => {
    sync({ sheetCells: [cell()] });
    db.prepare("UPDATE task_sheets SET status = 'DONE' WHERE id = ?").run(sheet.sheetId);

    expect(buildPull(db, ACCOUNT, 0).recent.sheetCells).toEqual([]);
  });
});
