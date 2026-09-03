#!/usr/bin/env bash
#
# Pull-based deploy watcher (doc 09 §2). Runs on the VPS from cron, every 3 min:
#
#   */3 * * * * bash /opt/sru-field/ops/field-deploy-watch.sh >> /opt/sru-field/logs/deploy.log 2>&1
#
# CI cannot push a deploy to this host — Cloudflare challenges the GitHub runner
# and the firewall drops anything not from Cloudflare. So the host polls instead:
# every request here is outbound, which nothing blocks.
#
# Compares the GHCR digest for :latest against the digest the running container
# was created from, and redeploys only when they differ.

set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/sru-field}"
IMAGE="${IMAGE:-ghcr.io/hfzndev/sru-field-api:latest}"
CONTAINER="${CONTAINER:-sru-field-api}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

cd "$COMPOSE_DIR"

# Requires a prior `docker login ghcr.io` on this host — GHCR needs auth even
# for public images (doc 09 §2).
if ! remote_digest=$(docker manifest inspect "$IMAGE" 2>/dev/null | sha256sum | cut -d' ' -f1); then
  log "WARN could not reach GHCR; leaving the running container alone"
  exit 0
fi

running_image=$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || echo "none")
local_digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$running_image" 2>/dev/null | sha256sum | cut -d' ' -f1 || echo "none")

state_file="$COMPOSE_DIR/.last-deployed-digest"
last_seen=$(cat "$state_file" 2>/dev/null || echo "none")

if [ "$remote_digest" = "$last_seen" ] && [ "$running_image" != "none" ]; then
  exit 0
fi

log "new image detected, deploying"
docker compose pull
docker compose up -d

# Give it a moment, then confirm it actually came up. A container that pulls
# cleanly and then crash-loops is the failure worth catching here.
sleep 12
if curl -fsS --max-time 5 http://127.0.0.1:3003/api/health >/dev/null; then
  version=$(curl -fsS --max-time 5 http://127.0.0.1:3003/api/version | tr -d '\n')
  log "OK deployed and healthy: $version"
  echo "$remote_digest" > "$state_file"
else
  log "ERROR deployed but /api/health is failing — check: docker logs $CONTAINER"
  exit 1
fi
