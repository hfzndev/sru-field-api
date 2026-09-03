import { withAdmin } from '@/lib/admin';
import { isoToSqlite } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/dashboard — the summary behind doc 03 §4's Dashboard tab.
 *
 * NOTE: doc 06 §6 does not list this route. The dashboard it serves is
 * specified in doc 03, and the alternative was three full data queries pulled
 * to the browser purely to count rows. Flagged as an addition beyond the API
 * table rather than a silent one.
 */

/**
 * The UTC window covering "today" in WIB.
 *
 * WIB is UTC+7 with no daylight saving, so a WIB day runs from 17:00 UTC the
 * previous day to 16:59:59 UTC. Counting a UTC day instead would put the whole
 * night shift — which starts at 00:00 WIB — on the wrong date.
 */
function wibDayWindow(now = new Date()) {
  const wibNow = new Date(now.getTime() + 7 * 3600_000);
  const y = wibNow.getUTCFullYear();
  const m = wibNow.getUTCMonth();
  const d = wibNow.getUTCDate();

  const startUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - 7 * 3600_000);
  const endUtc = new Date(startUtc.getTime() + 86400_000);
  return { startIso: startUtc.toISOString(), endIso: endUtc.toISOString() };
}

export async function GET(request) {
  return withAdmin(request, (db) => {
    const { startIso, endIso } = wibDayWindow();
    const startSql = isoToSqlite(startIso);
    const endSql = isoToSqlite(endIso);

    const readings = db.prepare(`
      SELECT COUNT(*) n FROM tank_readings WHERE reading_at >= ? AND reading_at < ?
    `).get(startIso, endIso).n;

    const activities = db.prepare(`
      SELECT type, COUNT(*) n FROM activity_logs
       WHERE activity_at >= ? AND activity_at < ? GROUP BY type
    `).all(startIso, endIso);

    const cleaning = db.prepare(`
      SELECT status, COUNT(*) n FROM cleaning_sessions
       WHERE created_at >= ? AND created_at < ? GROUP BY status
    `).all(startSql, endSql);

    const byShift = db.prepare(`
      SELECT shift_group AS g, 'reading' AS kind, COUNT(*) n FROM tank_readings
       WHERE reading_at >= ? AND reading_at < ? GROUP BY shift_group
      UNION ALL
      SELECT shift_group, 'activity', COUNT(*) FROM activity_logs
       WHERE activity_at >= ? AND activity_at < ? GROUP BY shift_group
      UNION ALL
      SELECT shift_group, 'cleaning', COUNT(*) FROM cleaning_sessions
       WHERE created_at >= ? AND created_at < ? GROUP BY shift_group
    `).all(startIso, endIso, startIso, endIso, startSql, endSql);

    const shifts = {};
    for (const row of byShift) {
      const key = row.g || '(tanpa shift)';
      shifts[key] = shifts[key] || { shiftGroup: key, readings: 0, activities: 0, cleaning: 0 };
      if (row.kind === 'reading') shifts[key].readings += row.n;
      if (row.kind === 'activity') shifts[key].activities += row.n;
      if (row.kind === 'cleaning') shifts[key].cleaning += row.n;
    }

    const countOf = (rows, key) => rows.find((r) => (r.type ?? r.status) === key)?.n ?? 0;

    return Response.json({
      today: {
        readings,
        activitiesOperator: countOf(activities, 'OPERATOR'),
        activitiesContractor: countOf(activities, 'KONTRAKTOR'),
        cleaningDone: countOf(cleaning, 'DONE'),
        cleaningInProgress: countOf(cleaning, 'IN_PROGRESS'),
      },
      byShift: Object.values(shifts).sort((a, b) => a.shiftGroup.localeCompare(b.shiftGroup)),
      equipment: db.prepare(`
        SELECT status, COUNT(*) n FROM equipment WHERE is_active = 1 GROUP BY status
      `).all().reduce((acc, row) => ({ ...acc, [row.status]: row.n }), {}),
      openTasks: db.prepare(`
        SELECT COUNT(*) n FROM maintenance_tasks WHERE status IN ('OPEN', 'IN_PROGRESS')
      `).get().n,
      pendingCleaning: db.prepare(`
        SELECT COUNT(*) n FROM cleaning_sessions WHERE status = 'IN_PROGRESS'
      `).get().n,
      windowStart: startIso,
    });
  });
}
