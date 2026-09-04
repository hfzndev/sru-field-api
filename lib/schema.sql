-- GENERATED from sru-field-docs/05-Database-Schema.md (v1.1) -- do not hand-edit.
-- Regenerate: python scratchpad/extract_schema.py
-- Additive-only migrations (CREATE TABLE IF NOT EXISTS) so image rollback is safe (dok 09 7).

-- ============ MASTER (diedit admin, is_active = soft delete) ============

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,              -- bcryptjs
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tanks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                -- '93T-401' / '93T-402' (WAJIB penuh)
  name TEXT NOT NULL,
  height_mm REAL NOT NULL,                  -- 7953 / 7974
  dcs_tag TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  data_version INTEGER NOT NULL DEFAULT 0,  -- stamp meta.dataVersion tiap mutasi (delta pull)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit_key TEXT DEFAULT '',
  location TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'NORMAL',    -- NORMAL/STANDBY/ON_REPAIR/NEED_REPAIR
  status_changed_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  data_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT,                           -- UUIDv4 bila asalnya HP; NULL bila dari admin
  equipment_id INTEGER NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  description TEXT NOT NULL,                -- alasan WAJIB
  changed_by_name TEXT,                     -- 'Budi' atau 'admin'
  shift_group TEXT DEFAULT '',              -- 'Shift A'..'Shift D' (kosong bila admin)
  shift_time TEXT DEFAULT '',               -- pagi/sore/malam (kosong bila admin)
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),  -- jam operator/admin mengubah
  received_at TEXT DEFAULT (datetime('now'))           -- jam server menerima (jendela 7 hari)
);

CREATE TABLE IF NOT EXISTS contractors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,                -- 'PT Tejo Lomanis'
  is_active INTEGER NOT NULL DEFAULT 1,
  data_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shift_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                -- SHIFT_A..SHIFT_D
  display_name TEXT NOT NULL,               -- 'Shift A'
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  data_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shift_crew (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_account_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  data_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN',      -- OPEN/IN_PROGRESS/DONE/CANCELLED
  progress_pct INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  created_by INTEGER,                       -- admin_users.id
  data_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ============ DATA LAPANGAN (offline origin; client_id = idempotency) ============

CREATE TABLE IF NOT EXISTS tank_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  tank_id INTEGER NOT NULL,
  dcs_level_mm REAL,                        -- estimasi awal dari DCS (nullable)
  tape_length_mm REAL NOT NULL,             -- meteran yang masuk (terbaca)
  bandul_sulfur_mm REAL NOT NULL,           -- 0..99
  level_mm REAL NOT NULL,                   -- HASIL SERVER: height − tape + bandul
  deviation_mm REAL,                        -- level − dcs
  attempts INTEGER DEFAULT 1,               -- percobaan sampai dapat tempelan
  operator_name TEXT NOT NULL,
  shift_group TEXT DEFAULT '',              -- 'Shift A'..'Shift D'
  shift_time TEXT DEFAULT '',               -- pagi/sore/malam
  photo_path TEXT DEFAULT '',               -- relatif thd data/uploads/
  note TEXT DEFAULT '',
  reading_at TEXT NOT NULL,                 -- waktu operator ukur (UTC ISO)
  received_at TEXT DEFAULT (datetime('now')),  -- waktu server terima (penentu konflik)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cleaning_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,                   -- deskripsi lokasi kotoran
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS',  -- IN_PROGRESS/DONE (DONE saat foto after)
  operator_name TEXT NOT NULL,
  shift_group TEXT DEFAULT '',
  shift_time TEXT DEFAULT '',
  before_photo TEXT DEFAULT '',
  before_photo_at TEXT,
  after_photo TEXT DEFAULT '',
  after_photo_at TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,                       -- OPERATOR / KONTRAKTOR
  description TEXT NOT NULL,
  contractor_name TEXT DEFAULT '',          -- WAJIB bila type=KONTRAKTOR
  unit_area TEXT DEFAULT '',
  activity_at TEXT NOT NULL,                -- waktu aktivitas (default = catat; bisa digeser)
  operator_name TEXT NOT NULL,
  shift_group TEXT DEFAULT '',
  shift_time TEXT DEFAULT '',
  received_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  task_id INTEGER NOT NULL,
  old_status TEXT,
  new_status TEXT,
  progress_pct INTEGER,
  note TEXT DEFAULT '',
  photo_path TEXT DEFAULT '',
  operator_name TEXT,
  shift_group TEXT DEFAULT '',
  shift_time TEXT DEFAULT '',
  log_time TEXT,
  received_at TEXT DEFAULT (datetime('now'))
);

-- ============ AUTH & META ============

CREATE TABLE IF NOT EXISTS device_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_account_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,                 -- sha256(token) — token mentah tidak disimpan
  device_name TEXT DEFAULT '',
  app_version TEXT DEFAULT '',              -- versi APK saat login (tracking update)
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- meta: dataVersion (int, naik tiap mutasi master) — untuk delta pull

-- ============ AUDIT ADMIN ============

CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_username TEXT NOT NULL,
  action TEXT NOT NULL,                     -- CREATE/UPDATE/DELETE/LOGIN...
  entity TEXT NOT NULL,                     -- tank/equipment/contractor/shift_crew/...
  entity_id INTEGER,
  detail TEXT DEFAULT '',
  at TEXT DEFAULT (datetime('now'))
);

-- ============ INDEX ============

CREATE INDEX IF NOT EXISTS idx_readings_tank_time ON tank_readings(tank_id, reading_at DESC);
CREATE INDEX IF NOT EXISTS idx_readings_shift ON tank_readings(shift_group, reading_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_shift_time ON activity_logs(shift_group, activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_cleaning_shift ON cleaning_sessions(shift_group, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasklog_task ON maintenance_task_logs(task_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_eq_status_log ON equipment_status_log(equipment_id, changed_at DESC);
-- UNIQUE tapi nullable: NULL di SQLite tidak saling bentrok, jadi baris admin
-- (client_id NULL) bebas berulang sementara retry dari HP tetap idempoten.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eq_status_log_client ON equipment_status_log(client_id);
CREATE INDEX IF NOT EXISTS idx_devicetoken_account ON device_tokens(shift_account_id);

-- Delta pull master (GET /api/pull?since=) — filter data_version > since
CREATE INDEX IF NOT EXISTS idx_tanks_dataversion ON tanks(data_version);
CREATE INDEX IF NOT EXISTS idx_equipment_dataversion ON equipment(data_version);
CREATE INDEX IF NOT EXISTS idx_contractors_dataversion ON contractors(data_version);
CREATE INDEX IF NOT EXISTS idx_shiftaccounts_dataversion ON shift_accounts(data_version);
CREATE INDEX IF NOT EXISTS idx_shiftcrew_dataversion ON shift_crew(data_version);
CREATE INDEX IF NOT EXISTS idx_tasks_dataversion ON maintenance_tasks(data_version);
