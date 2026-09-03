#!/usr/bin/env bash
#
# Daily backup (doc 09 §5). Cron at 02:00 WIB = 19:00 UTC:
#
#   0 19 * * * bash /opt/sru-field/ops/field-backup.sh >> /opt/sru-field/logs/backup.log 2>&1
#
# Field data only exists here. The handsets keep a rolling 7-day window and
# purge everything older, so a lost field.db is data that no longer exists
# anywhere — this is not a convenience backup.

set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/sru-field/data}"
BACKUP_DIR="${BACKUP_DIR:-/opt/sru-field/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

stamp=$(date -u +%Y%m%d_%H%M%S)
work="$BACKUP_DIR/tmp_$stamp"
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

mkdir -p "$BACKUP_DIR" "$work"
trap 'rm -rf "$work"' EXIT

# sqlite3 .backup, never `cp`. The database runs in WAL mode, so copying the
# file alone can capture a torn state with its -wal left behind; .backup takes a
# consistent snapshot while the server keeps writing.
sqlite3 "$DATA_DIR/field.db" ".backup '$work/field.db'"

if ! sqlite3 "$work/field.db" "PRAGMA integrity_check;" | grep -q '^ok$'; then
  log "ERROR integrity_check failed on the snapshot — keeping nothing"
  exit 1
fi

# Photos are referenced by path from the database; a backup of one without the
# other restores to broken thumbnails.
cp -r "$DATA_DIR/uploads" "$work/uploads" 2>/dev/null || mkdir -p "$work/uploads"

archive="$BACKUP_DIR/field_backup_$stamp.tar.gz"
tar -czf "$archive" -C "$work" field.db uploads

size=$(du -h "$archive" | cut -f1)
rows=$(sqlite3 "$work/field.db" "SELECT (SELECT COUNT(*) FROM tank_readings) + (SELECT COUNT(*) FROM activity_logs) + (SELECT COUNT(*) FROM cleaning_sessions);")
log "OK $archive ($size, $rows field records)"

deleted=$(find "$BACKUP_DIR" -name 'field_backup_*.tar.gz' -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
[ "$deleted" -gt 0 ] && log "pruned $deleted backup(s) older than $RETENTION_DAYS days"

exit 0
