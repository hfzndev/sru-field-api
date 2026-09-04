import {
  DEVIATION_SAMPLE_SIZE, equipmentSelect, serializeEquipmentRow, tankDeviation,
} from './master-queries.js';
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
export { DEVIATION_SAMPLE_SIZE };

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

/**
 * The same query delta pull uses, so login and pull build the same cache.
 *
 * They did not, and the consequence outlived the login: unit_key and location
 * were missing here, and login stores the server's dataVersion as the pull
 * cursor, so the next delta carried only rows that changed afterwards. The gaps
 * stayed until an admin happened to edit that equipment.
 */
function activeEquipment(db) {
  return db.prepare(`${equipmentSelect('e.is_active = 1')} ORDER BY e.tag_number`)
    .all()
    .map(serializeEquipmentRow);
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
