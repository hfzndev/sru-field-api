#!/usr/bin/env bash
#
# Removes unreferenced photos (doc 09 §5). Weekly, Sunday 03:00 WIB:
#
#   0 20 * * 0 bash /opt/sru-field/ops/field-orphan-sweep.sh --apply >> /opt/sru-field/logs/orphan-sweep.log 2>&1
#
# Photos upload before the record that references them, so the path can be
# embedded in the sync payload (doc 06 §5). If the upload succeeds and the
# record push then fails, the file is left with no owner. Harmless individually;
# unbounded over years.
#
# DRY RUN BY DEFAULT. Pass --apply to actually delete. Run it without --apply
# for a week first and read the log — this deletes operator photographs, and the
# only thing standing between a bug here and losing them is that default.

set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/sru-field/data}"
UPLOADS_DIR="$DATA_DIR/uploads"
MIN_AGE_DAYS="${MIN_AGE_DAYS:-7}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

referenced=$(mktemp)
trap 'rm -f "$referenced"' EXIT

# Every column that can hold a photo path. Missing one here would delete photos
# that are still in use.
sqlite3 "$DATA_DIR/field.db" <<'SQL' | sed 's#^uploads/##' | sort -u > "$referenced"
SELECT photo_path   FROM tank_readings         WHERE photo_path   <> '';
SELECT before_photo FROM cleaning_sessions     WHERE before_photo <> '';
SELECT after_photo  FROM cleaning_sessions     WHERE after_photo  <> '';
SELECT photo_path   FROM maintenance_task_logs WHERE photo_path   <> '';
SQL

log "referenced photos: $(wc -l < "$referenced")"

# The age floor protects records still queued on a handset that has not synced.
# A phone offline for six days must not have its photos swept out from under it.
orphans=0
freed=0
while IFS= read -r file; do
  name=$(basename "$file")
  if grep -qxF "$name" "$referenced"; then continue; fi

  orphans=$((orphans + 1))
  freed=$((freed + $(stat -c %s "$file" 2>/dev/null || echo 0)))

  if [ "$APPLY" -eq 1 ]; then
    rm -f "$file"
    log "deleted $name"
  else
    log "would delete $name"
  fi
done < <(find "$UPLOADS_DIR" -type f -mtime "+$MIN_AGE_DAYS" 2>/dev/null)

mode=$([ "$APPLY" -eq 1 ] && echo "deleted" || echo "would delete (dry run)")
log "OK $mode $orphans orphan(s), $((freed / 1024)) KB"
