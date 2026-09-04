import { currentDataVersion } from './dataversion.js';
import { equipmentSelect, serializeEquipmentRow, tankDeviation } from './master-queries.js';
import { nowIso, sqliteDaysAgo, toIso } from './time.js';

/**
 * Delta pull (doc 06 §5, doc 07 §5 and §7).
 *
 * Two independent halves:
 *
 *   `master` — reference data, delivered incrementally against the integer
 *   `data_version` stamp. The phone stores the returned `dataVersion` and sends
 *   it back as `since` next time.
 *
 *   `recent` — the caller's own field records from the last 7 days, so a shift
 *   moving to a different handset refills its offline window (doc 07 §5).
 */

/** Local retention window on the phone, mirrored by the server-side query. */
export const RECENT_WINDOW_DAYS = 7;

/**
 * Defensive cap. Real volume is dozens of records per week (doc 04 §5); this
 * only stops a pathological payload being assembled over a 2G link.
 */
const RECENT_LIMIT = 1000;

/**
 * Parses the `since` cursor. Anything unusable — absent, negative, not a
 * number — becomes 0, which means "send everything active" rather than an
 * error: a phone with a corrupt cursor should recover by resyncing, not be
 * locked out of pulling.
 */
export function parseSince(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/**
 * Whether a row is in the delta.
 *
 * The is_active handling differs by direction, and it matters:
 *
 *   Initial (since = 0): only active rows. Sending tombstones for things the
 *   phone has never seen is pure waste (doc 06 §5).
 *
 *   Incremental (since > 0): every changed row, including deactivated ones.
 *   Filtering to active here would make soft deletion invisible — a contractor
 *   removed by an admin would linger in the phone's quick-pick forever, since
 *   nothing would ever tell it the row went away. The row carries isActive so
 *   the client can prune. The spec does not state this case; it follows from
 *   soft delete being the deletion mechanism (doc 05 §3).
 */
function deltaClause(since, alias = '') {
  const col = alias ? `${alias}.` : '';
  return since > 0 ? `${col}data_version > ?` : `${col}is_active = 1`;
}

function deltaArgs(since) {
  return since > 0 ? [since] : [];
}

/**
 * maintenance_tasks has no is_active column — "currently relevant" means an
 * unfinished status instead, matching what the login bootstrap sends.
 */
function taskDeltaClause(since) {
  return since > 0 ? 't.data_version > ?' : "t.status IN ('OPEN', 'IN_PROGRESS')";
}

/**
 * Every active tank, regardless of the delta cursor.
 *
 * The deviation cache is keyed by tank and sent whole on every pull, so it
 * needs the full list — not the subset that happens to have changed.
 */
function allTanks(db) {
  return db.prepare('SELECT id FROM tanks WHERE is_active = 1 ORDER BY id').all();
}

function master(db, since, shiftAccountId) {
  const where = deltaClause(since);
  const args = deltaArgs(since);

  const tanks = db.prepare(`
    SELECT id, code, name, height_mm, dcs_tag, is_active
      FROM tanks WHERE ${where} ORDER BY id
  `).all(...args).map((t) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    heightMm: t.height_mm,
    dcsTag: t.dcs_tag || '',
    isActive: t.is_active === 1,
  }));

  // The reason rides along with the status, from whichever shift wrote it last.
  // Without it a handset can show "ON REPAIR" and nothing else, which is the
  // one thing an operator on the next shift actually needs to know (doc 02
  // §1.2). The join is free: every status change stamps the equipment row, so
  // a row in this delta is exactly a row whose note may have moved.
  //
  // Shared with the login bootstrap so the two cannot drift (lib/master-queries.js).
  const equipment = db.prepare(`${equipmentSelect(deltaClause(since, 'e'))} ORDER BY e.id`)
    .all(...args)
    .map(serializeEquipmentRow);

  const contractors = db.prepare(`
    SELECT id, name, is_active FROM contractors WHERE ${where} ORDER BY id
  `).all(...args).map((c) => ({ id: c.id, name: c.name, isActive: c.is_active === 1 }));

  // LEFT JOIN: a task whose equipment row was hard-deleted must still reach the
  // phone, otherwise it becomes permanently invisible rather than closeable.
  const tasks = db.prepare(`
    SELECT t.id, t.equipment_id, t.title, t.description, t.status, t.progress_pct, t.due_date,
           e.tag_number, e.name AS equipment_name
      FROM maintenance_tasks t
      LEFT JOIN equipment e ON e.id = t.equipment_id
     WHERE ${taskDeltaClause(since)}
     ORDER BY t.id
  `).all(...args).map((t) => ({
    id: t.id,
    equipmentId: t.equipment_id,
    equipmentTag: t.tag_number ?? '',
    equipmentName: t.equipment_name ?? '',
    title: t.title,
    description: t.description || '',
    status: t.status,
    progressPct: t.progress_pct,
    dueDate: toIso(t.due_date),
  }));

  // Crew is scoped to the caller's own shift: another shift's roster is not
  // something this handset ever displays, and the bootstrap scopes it the same
  // way (doc 06 §4).
  const crew = db.prepare(`
    SELECT id, name, sort_order, is_active
      FROM shift_crew
     WHERE shift_account_id = ? AND ${where}
     ORDER BY sort_order, id
  `).all(shiftAccountId, ...args).map((c) => ({
    id: c.id,
    name: c.name,
    sortOrder: c.sort_order,
    isActive: c.is_active === 1,
  }));

  return { tanks, equipment, contractors, tasks, crew };
}

/**
 * The caller's own records from the last 7 days.
 *
 * Scoped by `shift_group` string rather than a foreign key, by design: the
 * attribution stays meaningful even if an account is later renamed or
 * reassigned (doc 05 §3). The flip side is that renaming a shift's display name
 * orphans its history from this query.
 *
 * `received_at` is compared in SQLite's own storage format. Handing it an ISO
 * string here would compare "2026-09-02T.." against "2026-09-02 .." as plain
 * text and silently select the wrong window.
 */
function recent(db, shiftGroup) {
  const cutoff = sqliteDaysAgo(RECENT_WINDOW_DAYS);

  const readings = db.prepare(`
    SELECT * FROM tank_readings
     WHERE shift_group = ? AND received_at >= ?
     ORDER BY reading_at DESC LIMIT ?
  `).all(shiftGroup, cutoff, RECENT_LIMIT).map((r) => ({
    id: r.id,
    clientId: r.client_id,
    tankId: r.tank_id,
    dcsLevelMm: r.dcs_level_mm,
    tapeLengthMm: r.tape_length_mm,
    bandulSulfurMm: r.bandul_sulfur_mm,
    levelMm: r.level_mm,
    deviationMm: r.deviation_mm,
    attempts: r.attempts,
    operatorName: r.operator_name,
    shiftGroup: r.shift_group,
    shiftTime: r.shift_time,
    photoPath: r.photo_path || '',
    note: r.note || '',
    readingAt: toIso(r.reading_at),
    receivedAt: toIso(r.received_at),
  }));

  const activities = db.prepare(`
    SELECT * FROM activity_logs
     WHERE shift_group = ? AND received_at >= ?
     ORDER BY activity_at DESC LIMIT ?
  `).all(shiftGroup, cutoff, RECENT_LIMIT).map((a) => ({
    id: a.id,
    clientId: a.client_id,
    type: a.type,
    description: a.description,
    contractorName: a.contractor_name || '',
    unitArea: a.unit_area || '',
    activityAt: toIso(a.activity_at),
    operatorName: a.operator_name,
    shiftGroup: a.shift_group,
    shiftTime: a.shift_time,
    receivedAt: toIso(a.received_at),
  }));

  const cleaning = db.prepare(`
    SELECT * FROM cleaning_sessions
     WHERE shift_group = ? AND received_at >= ?
     ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(shiftGroup, cutoff, RECENT_LIMIT).map((c) => ({
    id: c.id,
    clientId: c.client_id,
    location: c.location,
    note: c.note || '',
    status: c.status,
    operatorName: c.operator_name,
    shiftGroup: c.shift_group,
    shiftTime: c.shift_time,
    beforePhoto: c.before_photo || '',
    beforePhotoAt: toIso(c.before_photo_at),
    afterPhoto: c.after_photo || '',
    afterPhotoAt: toIso(c.after_photo_at),
    receivedAt: toIso(c.received_at),
  }));

  const taskLogs = db.prepare(`
    SELECT * FROM maintenance_task_logs
     WHERE shift_group = ? AND received_at >= ?
     ORDER BY received_at DESC, id DESC LIMIT ?
  `).all(shiftGroup, cutoff, RECENT_LIMIT).map((l) => ({
    id: l.id,
    clientId: l.client_id,
    taskId: l.task_id,
    oldStatus: l.old_status,
    newStatus: l.new_status,
    progressPct: l.progress_pct,
    note: l.note || '',
    photoPath: l.photo_path || '',
    operatorName: l.operator_name || '',
    shiftGroup: l.shift_group,
    shiftTime: l.shift_time,
    logTime: toIso(l.log_time),
    receivedAt: toIso(l.received_at),
  }));

  // Scoped to the caller's shift like everything else in `recent`: this is the
  // offline window being refilled, not plant-wide history. The current reason
  // for any equipment, whoever wrote it, arrives on the master row above.
  const equipmentStatus = db.prepare(`
    SELECT * FROM equipment_status_log
     WHERE shift_group = ? AND received_at >= ?
     ORDER BY received_at DESC, id DESC LIMIT ?
  `).all(shiftGroup, cutoff, RECENT_LIMIT).map((s) => ({
    id: s.id,
    clientId: s.client_id,
    equipmentId: s.equipment_id,
    oldStatus: s.old_status,
    newStatus: s.new_status,
    description: s.description,
    operatorName: s.changed_by_name || '',
    shiftGroup: s.shift_group || '',
    shiftTime: s.shift_time || '',
    changedAt: toIso(s.changed_at),
    receivedAt: toIso(s.received_at),
  }));

  return { readings, activities, cleaning, taskLogs, equipmentStatus };
}

/**
 * Builds the pull response for an authenticated device.
 *
 * `dataVersion` is read once, before the queries, so the cursor the phone
 * stores can never be ahead of the rows it just received.
 */
export function buildPull(db, account, since) {
  const dataVersion = currentDataVersion(db);
  const masterData = master(db, since, account.id);

  return {
    dataVersion,
    master: masterData,
    recent: recent(db, account.displayName),
    // Sent in full every time, not as a delta, and not scoped to the caller's
    // shift. Doc 07 §5 calls this a permanent cache rather than a window: drift
    // belongs to the tank, not to whoever measured it. The phone used to rebuild
    // it from `recent`, which is one shift's last 7 days, so any tank this shift
    // had not measured lately dropped to zero samples and its tape suggestion
    // silently degraded to raw DCS. It is 5 rows per tank -- two tanks today.
    tankDeviation: tankDeviation(db, allTanks(db)),
    serverTime: nowIso(),
  };
}
