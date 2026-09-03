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
 */

export const SYNC_ERRORS = {
  TANK_NOT_FOUND: 'TANK_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  CONTRACTOR_REQUIRED: 'CONTRACTOR_REQUIRED',
};

function fail(errors, clientId, code, message) {
  errors.push({ clientId, error: { code, message } });
}

/* ------------------------------------------------------------------ readings */

function handleReading(db, record, out) {
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
    record.shiftGroup, record.shiftTime, record.photoPath, record.note, record.readingAt,
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
function handleCleaning(db, record, out) {
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
    record.operatorName, record.shiftGroup, record.shiftTime,
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

function handleActivity(db, record, out) {
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
    record.activityAt, record.operatorName, record.shiftGroup, record.shiftTime,
  );

  if (info.changes === 0) {
    const row = db.prepare('SELECT id FROM activity_logs WHERE client_id = ?').get(record.clientId);
    out.duplicates.push({ clientId: record.clientId, serverId: row?.id ?? null });
    return;
  }

  out.acked.push({ clientId: record.clientId, serverId: Number(info.lastInsertRowid) });
}

/* ----------------------------------------------------------------- task logs */

function handleTaskLog(db, record, out) {
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
    record.operatorName, record.shiftGroup, record.shiftTime, record.logTime ?? null,
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

/* ------------------------------------------------------------------- driver */

/**
 * Processes a validated payload. One transaction for the whole batch: either
 * everything committed here lands, or a genuine failure rolls all of it back
 * and the phone retries with nothing half-applied.
 *
 * @returns {{acked: Array, duplicates: Array, errors: Array, serverTime: string}}
 */
export function processSync(db, payload) {
  const out = { acked: [], duplicates: [], errors: [] };

  db.transaction(() => {
    for (const record of payload.readings) handleReading(db, record, out);
    for (const record of payload.cleaning) handleCleaning(db, record, out);
    for (const record of payload.activities) handleActivity(db, record, out);
    for (const record of payload.taskLogs) handleTaskLog(db, record, out);
  })();

  return { ...out, serverTime: nowIso() };
}

export function isEmptyPayload(payload) {
  return payload.readings.length === 0
    && payload.cleaning.length === 0
    && payload.activities.length === 0
    && payload.taskLogs.length === 0;
}
