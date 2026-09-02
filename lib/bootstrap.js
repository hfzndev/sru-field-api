import { toIso } from './time.js';

/**
 * The bootstrap bundle returned by POST /api/auth/login (doc 06 §4).
 *
 * Login is the one moment an operator is reliably in signal — usually the
 * control room at shift start — so everything the phone needs for a whole
 * offline shift ships in that single response rather than as follow-up
 * requests made in the field (doc 01 §8).
 */

/** How many past readings the phone averages for its tape suggestion (doc 02 §2.2). */
export const DEVIATION_SAMPLE_SIZE = 5;

export function currentDataVersion(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'dataVersion'").get();
  return Number(row?.value ?? 0);
}

function activeTanks(db) {
  return db.prepare(`
    SELECT id, code, height_mm, dcs_tag
      FROM tanks WHERE is_active = 1 ORDER BY code
  `).all().map((t) => ({
    id: t.id,
    code: t.code,          // always the full '93T-401' — never abbreviated (doc 02 §1.1)
    heightMm: t.height_mm,
    dcsTag: t.dcs_tag || '',
  }));
}

function activeEquipment(db) {
  return db.prepare(`
    SELECT id, tag_number, name, status
      FROM equipment WHERE is_active = 1 ORDER BY tag_number
  `).all().map((e) => ({
    id: e.id,
    tagNumber: e.tag_number,
    name: e.name,
    status: e.status,
  }));
}

function activeContractors(db) {
  return db.prepare('SELECT id, name FROM contractors WHERE is_active = 1 ORDER BY name')
    .all()
    .map((c) => ({ id: c.id, name: c.name }));
}

function crewFor(db, shiftAccountId) {
  return db.prepare(`
    SELECT name FROM shift_crew
     WHERE shift_account_id = ? AND is_active = 1
     ORDER BY sort_order, name
  `).all(shiftAccountId).map((c) => c.name);
}

/**
 * Open maintenance work.
 *
 * NOTE — spec gap: docs 03 §3.5 and §4 describe assigning a task to a shift,
 * but `maintenance_tasks` (doc 05) has no shift column, so "tasks assigned to
 * this shift" cannot be expressed. Every shift therefore sees all unfinished
 * tasks. Flagged rather than papered over with an invented column.
 */
function openTasks(db) {
  return db.prepare(`
    SELECT t.id, t.equipment_id, t.title, t.description, t.status, t.progress_pct, t.due_date,
           e.tag_number, e.name AS equipment_name
      FROM maintenance_tasks t
      JOIN equipment e ON e.id = t.equipment_id
     WHERE t.status IN ('OPEN', 'IN_PROGRESS')
     ORDER BY COALESCE(t.due_date, '9999'), t.id
  `).all().map((t) => ({
    id: t.id,
    equipmentId: t.equipment_id,
    equipmentTag: t.tag_number,
    equipmentName: t.equipment_name,
    title: t.title,
    description: t.description || '',
    status: t.status,
    progressPct: t.progress_pct,
    dueDate: toIso(t.due_date),
  }));
}

/**
 * Recent readings per tank, feeding the phone's tape-length suggestion.
 *
 * Only readings with a DCS value are returned: the phone averages
 * (level − dcs), so a reading whose DCS the operator could not read carries no
 * deviation and would just be dead weight in a payload sent over 2G.
 * Deviations are per-tank and never pooled — 93T-401 and 93T-402 drift
 * differently (doc 02 §2.2).
 */
function tankDeviation(db, tanks) {
  const statement = db.prepare(`
    SELECT level_mm, dcs_level_mm, reading_at
      FROM tank_readings
     WHERE tank_id = ? AND dcs_level_mm IS NOT NULL
     ORDER BY reading_at DESC
     LIMIT ?
  `);

  const result = {};
  for (const tank of tanks) {
    result[tank.id] = statement.all(tank.id, DEVIATION_SAMPLE_SIZE).map((r) => ({
      levelMm: r.level_mm,
      dcsLevelMm: r.dcs_level_mm,
      readingAt: toIso(r.reading_at),
    }));
  }
  return result;
}

/** Assembles the full payload for a signed-in shift account. */
export function buildBootstrap(db, account) {
  const tanks = activeTanks(db);
  return {
    shiftGroup: { code: account.code, displayName: account.display_name ?? account.displayName },
    crew: crewFor(db, account.id),
    tanks,
    equipment: activeEquipment(db),
    contractors: activeContractors(db),
    tasks: openTasks(db),
    tankDeviation: tankDeviation(db, tanks),
    dataVersion: currentDataVersion(db),
  };
}
