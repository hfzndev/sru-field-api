#!/usr/bin/env bash
#
# Health monitor (doc 09 §6). Cron every 6 hours, silent unless something is wrong:
#
#   0 */6 * * * bash /opt/sru-field/ops/field-health-check.sh >> /opt/sru-field/logs/health.log 2>&1
#
# Checks the two paths separately on purpose. The local check says the container
# is alive; the external one goes through Cloudflare and nginx, and is the only
# thing that catches a WAF rule someone edited months after setup — the failure
# that reaches every handset at once and reports itself, on the phone, as "no
# signal" (doc 09 §3).
#
# Alerts only on failure. A monitor that speaks every six hours is a monitor
# nobody reads by the time it matters.

set -uo pipefail

LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:3003/api/health}"
EXTERNAL_URL="${EXTERNAL_URL:-https://ops.sruipal.com/api/health}"
CONTAINER="${CONTAINER:-sru-field-api}"
DOMAIN="${DOMAIN:-ops.sruipal.com}"
DATA_DIR="${DATA_DIR:-/opt/sru-field/data}"
BACKUP_DIR="${BACKUP_DIR:-/opt/sru-field/backups}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
SSL_WARN_DAYS="${SSL_WARN_DAYS:-14}"
# The daily backup runs at 02:00 WIB. Two days allows for one missed run and a
# clock that is off, without letting a dead cron sit unnoticed for a week.
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-48}"

# Optional. Without them the script still logs; it just cannot page anyone.
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

problems=()
note() { problems+=("$1"); log "FAIL $1"; }

# --- container ---------------------------------------------------------------
state=$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null | tr -d '[:space:]')
[ -z "$state" ] && state="missing"
[ "$state" = "running" ] || note "container $CONTAINER is '$state'"

# --- local API ---------------------------------------------------------------
if ! curl -fsS --max-time 10 "$LOCAL_URL" >/dev/null 2>&1; then
  note "local health check failed ($LOCAL_URL)"
fi

# --- external API through Cloudflare -----------------------------------------
# A challenge page is a 200 full of HTML, so checking the status code alone
# would pass while every device in the field is locked out. Check the body.
#
# Matched with the key: "unhealthy" contains "healthy", so a bare substring
# search would report the failing server as fine.
external=$(curl -fsS --max-time 15 -H 'User-Agent: sru-field-health/1.0' "$EXTERNAL_URL" 2>/dev/null)
if [ -z "$external" ]; then
  note "external health check unreachable ($EXTERNAL_URL)"
elif printf '%s' "$external" | grep -q '"status"[[:space:]]*:[[:space:]]*"unhealthy"'; then
  note "external health check reports unhealthy: $external"
elif ! printf '%s' "$external" | grep -q '"status"[[:space:]]*:[[:space:]]*"healthy"'; then
  note "external health check returned no health JSON — Cloudflare is challenging /api/* (doc 09 §3, step 7)"
fi

# --- TLS expiry --------------------------------------------------------------
if expiry=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null \
            | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2); then
  if expiry_epoch=$(date -d "$expiry" +%s 2>/dev/null); then
    days_left=$(( (expiry_epoch - $(date +%s)) / 86400 ))
    [ "$days_left" -lt "$SSL_WARN_DAYS" ] && note "TLS certificate expires in ${days_left}d"
  fi
fi

# --- backup freshness --------------------------------------------------------
# A backup cron that dies is invisible until the day it is needed, and field
# data older than the handsets' 7-day window exists nowhere else (doc 09 §5).
# The check is on the newest archive's age, not on the cron entry: a cron that
# runs and fails every night still looks scheduled.
newest_backup=$(find "$BACKUP_DIR" -name 'field_backup_*.tar.gz' -printf '%T@
' 2>/dev/null | sort -n | tail -1)
if [ -z "$newest_backup" ]; then
  note "no backup archive found in $BACKUP_DIR"
else
  age_hours=$(( ( $(date +%s) - ${newest_backup%.*} ) / 3600 ))
  if [ "$age_hours" -ge "$BACKUP_MAX_AGE_HOURS" ]; then
    note "newest backup is ${age_hours}h old (expected under ${BACKUP_MAX_AGE_HOURS}h)"
  fi
fi

# --- disk --------------------------------------------------------------------
used_pct=$(df --output=pcent "$DATA_DIR" 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$used_pct" ] && [ "$used_pct" -ge "$DISK_WARN_PCT" ]; then
  note "disk at ${used_pct}% on $DATA_DIR"
fi

# --- report ------------------------------------------------------------------
if [ ${#problems[@]} -eq 0 ]; then
  log "OK container running, local + external health fine, backup ${age_hours:-?}h old, disk ${used_pct:-?}%"
  exit 0
fi

message="SRU Field API — ${#problems[@]} problem(s) on $(hostname):"
for p in "${problems[@]}"; do message="$message"$'\n'"• $p"; done

if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
  curl -fsS --max-time 15 \
    -d "chat_id=$TELEGRAM_CHAT_ID" \
    --data-urlencode "text=$message" \
    "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" >/dev/null \
    || log "WARN could not send the Telegram alert"
fi

exit 1
