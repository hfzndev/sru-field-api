import { stampMaster } from './dataversion.js';
import { evaluateReading } from './midband.js';
import { nowIso } from './time.js';

/**
 * The sync engine (doc 06 §5, doc 07).
 *
 * Two guarantees shape everything here:
 *
 *   Nothing is lost — a record is only ever acked once it is committed, so a
 *   phone that never sees an ack keeps the record queued and retries.
 *
 *   Nothing is duplicated — client_id is UNIQUE, so a retried batch returns
 *   `duplicates` instead of inserting twice. The Sync button is safe to press
 *   any number of times (doc 07 §3).
 *
 * One invalid record must never fail the batch: an operator with nine good
 * readings and one bad one must not lose the nine. Handlers therefore report
 * failures by pushing to `errors` and never throw.
 *
 * Attribution is split deliberately. `shift_group` is taken from the
 * authenticated account and the payload's value is discarded: doc 02 §1.3 says
 * "Akun = per shift group", so the token already determines it and a handset
 * has no standing to claim another shift's work. `shift_time` and
 * `operator_name` do come from the payload -- those are the operator's own
 * choices and legitimately vary within one account across a rotation.
 *
 * This is not only about forged attribution. `recent` in lib/pull.js scopes the
 * 7-day refill by shift_group, so a record written under a group that does not
 * match its account could never be pulled back by the device that wrote it --
 * it would simply disappear from the operator's own history.
 */

export const SYNC_ERRORS = {
  TANK_NOT_FOUND: 'TANK_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  EQUIPMENT_NOT_FOUND: 'EQUIPMENT_NOT_FOUND',
  CONTRACTOR_REQUIRED: 'CONTRACTOR_REQUIRED',
  SHEET_NOT_FOUND: 'SHEET_NOT_FOUND',
  SHEET_CLOSED: 'SHEET_CLOSED',
  SHEET_ROWS_LOCKED: 'SHEET_ROWS_LOCKED',
  SHEET_ROW_NOT_FOUND: 'SHEET_ROW_NOT_FOUND',
  SHEET_COLUMN_NOT_FOUND: 'SHEET_COLUMN_NOT_FOUND',
  SHEET_COLUMN_NOT_FILLABLE: 'SHEET_COLUMN_NOT_FILLABLE',
};

function fail(errors, clientId, code, message) {
  errors.push({ clientId, error: { code, message } });
}

/* ------------------------------------------------------------------ readings */

function handleReading(db, record, out, shiftGroup) {
  const existing = db.prepare('SELECT id FROM tank_readings WHERE client_id = ?').get(record.clientId);
  if (existing) {
    out.duplicates.push({ clientId: record.clientId, serverId: existing.id });
    return;
  }

  const tank = db.prepare('SELECT id, height_mm FROM tanks WHERE id = ? AND is_active = 1').get(record.tankId);
  if (!tank) {
    fail(out.errors, record.clientId, SYNC_ERRORS.TANK_NOT_FOUND, 'Tangki tidak ditemukan atau sudah tidak aktif');
    return;
  }

  // The phone's arithmetic is never trusted; the level is recomputed here and
  // the result returned in the ack so the phone can reconcile (doc 04 §3.2).
  const evaluated = evaluateReading({
    heightMm: tank.height_mm,
    tapeLengthMm: record.tapeLengthMm,
    bandulSulfurMm: record.bandulSulfurMm,
    dcsLevelMm: record.dcsLevelMm,
  });

  if (!evaluated.ok) {
    fail(out.errors, record.clientId, evaluated.error.code, evaluated.error.message);
    return;
  }

  const info = db.prepare(`
    INSERT INTO tank_readings
      (client_id, tank_id, dcs_level_mm, tape_length_mm, bandul_sulfur_mm, level_mm, deviation_mm,
       attempts, operator_name, shift_group, shift_time, photo_path, note, reading_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO NOTHING
  `).run(
    record.clientId, tank.id, record.dcsLevelMm, record.tapeLengthMm, record.bandulSulfurMm,
    evaluated.levelMm, evaluated.deviationMm, record.attempts, record.operatorName,
    shiftGroup, record.shiftTime, record.photoPath, record.note, record.readingAt,
  );

  // DO NOTHING rather than letting the UNIQUE constraint throw: a concurrent
  // duplicate degrades to `duplicates` instead of rolling back the whole batch.
  if (info.changes === 0) {
    const row = db.prepare('SELECT id FROM tank_readings WHERE client_id = ?').get(record.clientId);
    out.duplicates.push({ clientId: record.clientId, serverId: row?.id ?? null });
    return;
  }

  out.acked.push({
    clientId: record.clientId,
    serverId: Number(info.lastInsertRowid),
    levelMm: evaluated.levelMm,
    deviationMm: evaluated.deviationMm,
  });
}

/* ------------------------------------------------------------------ cleaning */

/**
 * Status is derived, never taken from the client: a session is DONE exactly
 * when it has an after photo (doc 05 §1). Letting the phone assert DONE would
 * allow a session marked complete with no evidence.
 */
function cleaningStatus(afterPhoto) {
  return afterPhoto ? 'DONE' : 'IN_PROGRESS';
}

/**
 * The one field-data table that may be updated after insert (doc 05 §3).
 * Cleaning is inherently two-stage: BEFORE now, AFTER once the mess is gone.
 */
function handleCleaning(db, record, out, shiftGroup) {
  const existing = db.prepare(`
    SELECT id, after_photo FROM cleaning_sessions WHERE client_id = ?
  `).get(record.clientId);

  if (existing) {
    const completing = record.afterPhoto && !existing.after_photo;
    if (!completing) {
      // Replaying an already-complete session, or re-sending the BEFORE stage.
      out.duplicates.push({ clientId: record.clientId, serverId: existing.id });
      return;
    }

    // Only these four columns may move. location, before_photo and the
    // attribution fields stay as first recorded even if the payload differs.
    db.prepare(`
      UPDATE cleaning_sessions
         SET after_photo = ?, after_photo_at = ?, status = 'DONE', note = ?
       WHERE id = ?
    `).run(record.afterPhoto, record.afterPhotoAt ?? null, record.note, existing.id);

    out.acked.push({ clientId: record.clientId, serverId: existing.id, updated: true });
    return;
  }

  const info = db.prepare(`
    INSERT INTO cleaning_sessions
      (client_id, location, note, status, operator_name, shift_group, shift_time,
       before_photo, before_photo_at, after_photo, after_photo_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO NOTHING
  `).run(
    record.clientId, record.location, record.note, cleaningStatus(record.afterPhoto),
    record.operatorName, shiftGroup, record.shiftTime,
    record.beforePhoto, record.beforePhotoAt ?? null,
    record.afterPhoto, record.afterPhotoAt ?? null,
  );

  if (info.changes === 0) {
    const row = db.prepare('SELECT id FROM cleaning_sessions WHERE client_id = ?').get(record.clientId);
    out.duplicates.push({ clientId: record.clientId, serverId: row?.id ?? null });
    return;
  }

  out.acked.push({ clientId: record.clientId, serverId: Number(info.lastInsertRowid) });
}

/* ---------------------------------------------------------------- activities */

function handleActivity(db, record, out, shiftGroup) {
  const existing = db.prepare('SELECT id FROM activity_logs WHERE client_id = ?').get(record.clientId);
  if (existing) {
    out.duplicates.push({ clientId: record.clientId, serverId: existing.id });
    return;
  }

  if (record.type === 'KONTRAKTOR' && !record.contractorName.trim()) {
    fail(
      out.errors, record.clientId, SYNC_ERRORS.CONTRACTOR_REQUIRED,
      'Nama kontraktor wajib diisi untuk aktivitas kontraktor',
    );
    return;
  }

  // A contractor name on an OPERATOR activity is stripped, not rejected
  // (doc 10 §2.4) — it is meaningless there, but it is not the operator's
  // mistake to pay for.
  const contractorName = record.type === 'KONTRAKTOR' ? record.contractorName.trim() : '';

  const info = db.prepare(`
    INSERT INTO activity_logs
      (client_id, type, description, contractor_name, unit_area, activity_at,
       operator_name, shift_group, shift_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO NOTHING
  `).run(
    record.clientId, record.type, record.description, contractorName, record.unitArea,
    record.activityAt, record.operatorName, shiftGroup, record.shiftTime,
  );

  if (info.changes === 0) {
    const row = db.prepare('SELECT id FROM activity_logs WHERE client_id = ?').get(record.clientId);
    out.duplicates.push({ clientId: record.clientId, serverId: row?.id ?? null });
    return;
  }

  out.acked.push({ clientId: record.clientId, serverId: Number(info.lastInsertRowid) });
}

/* ----------------------------------------------------------------- task logs */

function handleTaskLog(db, record, out, shiftGroup) {
  const existing = db.prepare('SELECT id FROM maintenance_task_logs WHERE client_id = ?').get(record.clientId);
  if (existing) {
    out.duplicates.push({ clientId: record.clientId, serverId: existing.id });
    return;
  }

  const task = db.prepare('SELECT id, status, progress_pct FROM maintenance_tasks WHERE id = ?').get(record.taskId);
  if (!task) {
    fail(out.errors, record.clientId, SYNC_ERRORS.TASK_NOT_FOUND, 'Task maintenance tidak ditemukan');
    return;
  }

  // old_status comes from the database as it stands right now; whatever the
  // client believed the previous state was is ignored (doc 06 §5).
  const oldStatus = task.status;
  const newStatus = record.newStatus ?? null;
  const progressPct = record.progressPct ?? null;

  const info = db.prepare(`
    INSERT INTO maintenance_task_logs
      (client_id, task_id, old_status, new_status, progress_pct, note, photo_path,
       operator_name, shift_group, shift_time, log_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO NOTHING
  `).run(
    record.clientId, task.id, oldStatus, newStatus, progressPct, record.note, record.photoPath,
    record.operatorName, shiftGroup, record.shiftTime, record.logTime ?? null,
  );

  if (info.changes === 0) {
    const row = db.prepare('SELECT id FROM maintenance_task_logs WHERE client_id = ?').get(record.clientId);
    out.duplicates.push({ clientId: record.clientId, serverId: row?.id ?? null });
    return;
  }

  // The log is history and is never merged; the task row carries the current
  // state, so the last log to arrive wins (doc 07 §4, LWW by received_at).
  if (newStatus !== null || progressPct !== null) {
    db.prepare(`
      UPDATE maintenance_tasks
         SET status = COALESCE(?, status), progress_pct = COALESCE(?, progress_pct)
       WHERE id = ?
    `).run(newStatus, progressPct, task.id);

    // maintenance_tasks is master data pulled by delta, so this counts as a
    // master mutation (doc 07 §7 lists "task create-update-delete"). Without
    // the stamp the other phones would never learn the task moved.
    stampMaster(db, 'maintenance_tasks', task.id);
  }

  out.acked.push({ clientId: record.clientId, serverId: Number(info.lastInsertRowid) });
}

/* --------------------------------------------------- equipment status changes */

/**
 * A status change raised in the field (doc 02 §1.2, doc 05 §3).
 *
 * Unlike everything else in this file, one record writes to master data: the
 * history row, the equipment row, and the delta stamp move together in the
 * batch transaction, so no phone can ever pull a status without the reason
 * behind it having been written first.
 */
function handleEquipmentStatus(db, record, out, shiftGroup) {
  const existing = db.prepare('SELECT id FROM equipment_status_log WHERE client_id = ?').get(record.clientId);
  if (existing) {
    out.duplicates.push({ clientId: record.clientId, serverId: existing.id });
    return;
  }

  // is_active is not required here. Equipment retired between the operator
  // noticing the fault and the phone finding signal should still record what
  // was seen; refusing it would discard the observation over a race.
  const equipment = db.prepare('SELECT id, status FROM equipment WHERE id = ?').get(record.equipmentId);
  if (!equipment) {
    fail(out.errors, record.clientId, SYNC_ERRORS.EQUIPMENT_NOT_FOUND, 'Equipment tidak ditemukan');
    return;
  }

  // Read from the row, not from the payload: the phone's idea of the previous
  // status may be days old (doc 05 §3).
  const oldStatus = equipment.status;
  const changed = oldStatus !== record.newStatus;

  const info = db.prepare(`
    INSERT INTO equipment_status_log
      (client_id, equipment_id, old_status, new_status, description,
       changed_by_name, shift_group, shift_time, changed_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(client_id) DO NOTHING
  `).run(
    record.clientId, equipment.id, oldStatus, record.newStatus, record.description,
    record.operatorName, shiftGroup, record.shiftTime, record.changedAt,
  );

  if (info.changes === 0) {
    const row = db.prepare('SELECT id FROM equipment_status_log WHERE client_id = ?').get(record.clientId);
    out.duplicates.push({ clientId: record.clientId, serverId: row?.id ?? null });
    return;
  }

  // Re-asserting the status the equipment already has is accepted here, where
  // the admin route answers 409 STATUS_UNCHANGED. The asymmetry is deliberate
  // (doc 05 §3): an admin is at a keyboard and can be told; an operator has
  // walked away, and the reason they wrote is worth keeping either way. What is
  // skipped is the master mutation — nothing about the equipment changed.
  if (changed) {
    db.prepare("UPDATE equipment SET status = ?, status_changed_at = datetime('now') WHERE id = ?")
      .run(record.newStatus, equipment.id);
    stampMaster(db, 'equipment', equipment.id);
  }

  out.acked.push({
    clientId: record.clientId,
    serverId: Number(info.lastInsertRowid),
    // The phone shows "status tidak berubah" rather than silently implying it
    // moved the equipment.
    statusChanged: changed,
  });
}

/* ---------------------------------------------------------- lembar tugas */

/**
 * Loads the lembar a field record claims to belong to and decides whether it is
 * still accepting work.
 *
 * A sheet that was closed while the handset was offline is a real refusal, not
 * a silent drop: the operator did the walk, and telling them the lembar was
 * closed is the only honest answer. The handset surfaces it in the rejected
 * queue (app/(tabs)/sync.tsx) with the record still on disk.
 *
 * `assigned_shift` is checked against the authenticated group, never against
 * the payload — same reasoning as shift_group in this file's header.
 */
function loadOpenSheet(db, sheetId, shiftGroup, clientId, out) {
  const sheet = db.prepare(
    'SELECT id, status, is_active, assigned_shift, allow_operator_rows FROM task_sheets WHERE id = ?',
  ).get(sheetId);

  if (!sheet || sheet.is_active !== 1) {
    fail(out.errors, clientId, SYNC_ERRORS.SHEET_NOT_FOUND, 'Lembar tugas tidak ditemukan atau sudah dihapus');
    return null;
  }
  if (sheet.assigned_shift && sheet.assigned_shift !== shiftGroup) {
    // Deliberately the same code and message as "not found": a handset has no
    // business learning that another shift's lembar exists.
    fail(out.errors, clientId, SYNC_ERRORS.SHEET_NOT_FOUND, 'Lembar tugas tidak ditemukan atau sudah dihapus');
    return null;
  }
  if (sheet.status !== 'OPEN') {
    fail(out.errors, clientId, SYNC_ERRORS.SHEET_CLOSED, 'Lembar tugas sudah ditutup supervisor');
    return null;
  }

  return sheet;
}

/**
 * A row the operator appended in the field (doc 05 §4).
 *
 * Master data written from a handset, like handleEquipmentStatus: the row is
 * stamped so it fans out to every other phone on the next pull. Without the
 * stamp the operator who added "93P-104C" would be the only person who could
 * ever see it, and the supervisor's grid would show cells hanging off a row
 * that does not exist for anyone else.
 */
function handleSheetRow(db, record, out, shiftGroup) {
  const existing = db.prepare('SELECT id FROM task_sheet_rows WHERE client_id = ?').get(record.clientId);
  if (existing) {
    out.duplicates.push({ clientId: record.clientId, serverId: existing.id });
    return;
  }

  const sheet = loadOpenSheet(db, record.sheetId, shiftGroup, record.clientId, out);
  if (!sheet) return;

  if (sheet.allow_operator_rows !== 1) {
    fail(
      out.errors, record.clientId, SYNC_ERRORS.SHEET_ROWS_LOCKED,
      'Supervisor mengunci daftar baris pada lembar ini',
    );
    return;
  }

  // Appended to the end, using the sheet as it stands now. The phone never
  // proposes a position (lib/validation.js sheetRowSchema explains why).
  const last = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS last FROM task_sheet_rows WHERE sheet_id = ?',
  ).get(sheet.id);

  const info = db.prepare(`
    INSERT INTO task_sheet_rows (client_id, sheet_id, label, sort_order, added_by_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO NOTHING
  `).run(record.clientId, sheet.id, record.label, last.last + 1, record.operatorName);

  if (info.changes === 0) {
    const row = db.prepare('SELECT id FROM task_sheet_rows WHERE client_id = ?').get(record.clientId);
    out.duplicates.push({ clientId: record.clientId, serverId: row?.id ?? null });
    return;
  }

  stampMaster(db, 'task_sheet_rows', info.lastInsertRowid);
  out.acked.push({ clientId: record.clientId, serverId: Number(info.lastInsertRowid) });
}

/**
 * Resolves the row a cell belongs to.
 *
 * Two addressing modes because a cell can be written against a row the phone
 * pulled (`rowId`) or against one the same offline session invented
 * (`rowClientId`). The second is why processSync runs rows before cells: by the
 * time this looks the row up, the row handler has already inserted it and the
 * client_id is resolvable inside the same transaction.
 */
function resolveSheetRow(db, record, sheetId) {
  if (record.rowClientId) {
    return db.prepare('SELECT id FROM task_sheet_rows WHERE client_id = ? AND sheet_id = ?')
      .get(record.rowClientId, sheetId);
  }
  return db.prepare('SELECT id FROM task_sheet_rows WHERE id = ? AND sheet_id = ?')
    .get(record.rowId, sheetId);
}

/**
 * One filled cell (doc 05 §4, doc 07 §4).
 *
 * Append-only, and that is the whole conflict story: two operators who fill the
 * same cell offline both keep their record, and the later `filled_at` is what
 * the grid reads. Nothing is overwritten, nothing has to be merged, and the
 * earlier value stays as evidence of what was seen at that time.
 *
 * `is_active` on the row is not required. A row retired between the operator
 * photographing it and the phone finding signal should still keep the photo —
 * the same reasoning handleEquipmentStatus uses for retired equipment.
 */
function handleSheetCell(db, record, out, shiftGroup) {
  const existing = db.prepare('SELECT id FROM task_sheet_cells WHERE client_id = ?').get(record.clientId);
  if (existing) {
    out.duplicates.push({ clientId: record.clientId, serverId: existing.id });
    return;
  }

  const sheet = loadOpenSheet(db, record.sheetId, shiftGroup, record.clientId, out);
  if (!sheet) return;

  const row = resolveSheetRow(db, record, sheet.id);
  if (!row) {
    fail(out.errors, record.clientId, SYNC_ERRORS.SHEET_ROW_NOT_FOUND, 'Baris lembar tugas tidak ditemukan');
    return;
  }

  const column = db.prepare(
    'SELECT id, kind FROM task_sheet_columns WHERE id = ? AND sheet_id = ?',
  ).get(record.columnId, sheet.id);
  if (!column) {
    fail(out.errors, record.clientId, SYNC_ERRORS.SHEET_COLUMN_NOT_FOUND, 'Kolom lembar tugas tidak ditemukan');
    return;
  }
  // A LABEL column is text the supervisor wrote for the operator to read. It
  // holds no cell, so a payload aimed at one is a client bug worth naming.
  if (column.kind === 'LABEL') {
    fail(
      out.errors, record.clientId, SYNC_ERRORS.SHEET_COLUMN_NOT_FILLABLE,
      'Kolom keterangan tidak bisa diisi',
    );
    return;
  }

  const info = db.prepare(`
    INSERT INTO task_sheet_cells
      (client_id, sheet_id, row_id, column_id, value_text, value_number, photo_path,
       filled_by_name, shift_group, shift_time, filled_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(client_id) DO NOTHING
  `).run(
    record.clientId, sheet.id, row.id, column.id, record.valueText, record.valueNumber,
    record.photoPath, record.operatorName, shiftGroup, record.shiftTime, record.filledAt,
  );

  if (info.changes === 0) {
    const dupe = db.prepare('SELECT id FROM task_sheet_cells WHERE client_id = ?').get(record.clientId);
    out.duplicates.push({ clientId: record.clientId, serverId: dupe?.id ?? null });
    return;
  }

  out.acked.push({
    clientId: record.clientId,
    serverId: Number(info.lastInsertRowid),
    // The phone stores this so a cell written against a locally-invented row
    // stops depending on the client_id once the row has a server identity.
    rowId: row.id,
  });
}

/* ------------------------------------------------------------------- driver */

/**
 * Processes a validated payload. One transaction for the whole batch: either
 * everything committed here lands, or a genuine failure rolls all of it back
 * and the phone retries with nothing half-applied.
 *
 * @param account the authenticated shift account; its displayName becomes every
 *   record's shift_group, overriding whatever the payload claimed
 * @returns {{acked: Array, duplicates: Array, errors: Array, serverTime: string}}
 */
export function processSync(db, payload, account) {
  if (!account?.displayName) {
    // Not a validation error to report per record -- a caller that reaches here
    // without an authenticated account is a routing bug, and silently writing
    // an empty shift_group would orphan every record in the batch.
    throw new TypeError('processSync needs the authenticated account');
  }

  const out = { acked: [], duplicates: [], errors: [] };
  const shiftGroup = account.displayName;

  db.transaction(() => {
    for (const record of payload.readings) handleReading(db, record, out, shiftGroup);
    for (const record of payload.cleaning) handleCleaning(db, record, out, shiftGroup);
    for (const record of payload.activities) handleActivity(db, record, out, shiftGroup);
    for (const record of payload.taskLogs) handleTaskLog(db, record, out, shiftGroup);
    for (const record of payload.equipmentStatus) handleEquipmentStatus(db, record, out, shiftGroup);
    // Rows strictly before cells: a cell may address its row by client_id, and
    // that only resolves once the row handler has inserted it (doc 07 §4).
    for (const record of payload.sheetRows) handleSheetRow(db, record, out, shiftGroup);
    for (const record of payload.sheetCells) handleSheetCell(db, record, out, shiftGroup);
  })();

  return { ...out, serverTime: nowIso() };
}

export function isEmptyPayload(payload) {
  return payload.readings.length === 0
    && payload.cleaning.length === 0
    && payload.activities.length === 0
    && payload.taskLogs.length === 0
    && payload.equipmentStatus.length === 0
    && payload.sheetRows.length === 0
    && payload.sheetCells.length === 0;
}
