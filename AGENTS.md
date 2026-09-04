# Operating this system on the VPS

You are working on `sru-field-api` on the production VPS. This file is the
whole briefing: what the system is, what you may do, what you must not do, and
how to tell whether it is actually working.

Read all of it before running anything. The order of the sections is the order
you need them in.

---

## 1. What this is, and what is at stake

Four Android handsets belong to sulfur tank operators at an IPAL plant in
Cilacap. Operators walk out to tanks `93T-401` and `93T-402`, measure the level
with a dip tape, and record it. Signal in the plant is bad to absent, so the app
records everything into local SQLite first and syncs when it can.

Two consequences drive every rule below:

**Field data exists only on this host.** Handsets keep a rolling 7-day window
and purge older records. A record older than seven days lives in
`data/field.db` and nowhere else on earth. There is no other copy, no upstream
system, no export. Losing that file is losing the plant's compliance record.

**A broken edge is indistinguishable from bad signal.** If Cloudflare starts
challenging `/api/*`, every handset fails to sync and the app tells the operator
"no signal" — which is what it says in a dead zone, so nobody reports a bug.
Records pile up locally until the 7-day window starts dropping the synced ones
and operators lose trust in the app. This is why a running container is *not*
evidence the system works, and why the external check exists.

---

## 2. What you must not do

These are not style preferences. Each one has a specific bad outcome.

| Never | Because |
|---|---|
| `docker compose down -v` | `-v` deletes the volume. That is every field record. There is no undo. |
| Delete or move `data/field.db`, `field.db-wal`, `field.db-shm` | Same. The `-wal` file holds committed transactions not yet in the main file; removing it alone corrupts the database. |
| `cp` the database as a backup | It is in WAL mode. A plain copy can capture a torn state. Use `sqlite3 .backup`, which `ops/field-backup.sh` already does. |
| Set the firewall or panel to allow-all | Exposes the origin and causes Cloudflare 522s. If something is unreachable the cause is upstream — DNS, WAF, nginx — never this. |
| Touch anything belonging to **SRU APP** | A separate production app on this same host: its own container, port, volume, database and nginx block. It is unrelated to this project and must keep working. `app.sruipal.com`. |
| Edit the nginx config for SRU APP, or reload nginx without `nginx -t` first | A syntax error takes SRU APP down with this one. |
| `git push --force` | The remote history is shared. |
| Run `scripts/seed-*.js` on a database that already has data | See §6. It resets the admin password and forces every handset into a full master re-pull. |
| Commit or echo `.env.field` | It holds the session secret and both passwords. Never print it, never paste it into a report. |

### Things only a human can do

You have a shell. You do not have the Cloudflare dashboard, the domain
registrar, or the passwords. These steps are **not yours**:

- Creating the DNS record.
- Creating or changing Cloudflare WAF rules.
- Choosing the admin and shift passwords, and writing `.env.field`.
- Creating the GitHub PAT.
- Generating the Android release keystore.

You can and must **verify** each of them from the shell. If a verification
fails, stop and report exactly which check failed and what it returned. Do not
invent a workaround — every plausible workaround for a WAF or firewall problem
makes the system less safe, not more.

---

## 3. The shape of the system

```
handset ──HTTPS──► Cloudflare ──► nginx :443 ──► 127.0.0.1:3003 ──► container :3000
                    (proxy+WAF)   ops.sruipal.com                    sru-field-api
```

| Thing | Value |
|---|---|
| Install path | `/opt/sru-field` (a clone of this repo) |
| Container | `sru-field-api`, host `127.0.0.1:3003` → container `3000` |
| Image | `ghcr.io/hfzndev/sru-field-api:latest` (also tagged `:<sha>`) |
| Volume | `./data:/app/data` — `field.db`, `uploads/`, `apk/` |
| Runs as | uid **1001** inside the container |
| Env | `.env.field`, mode 0600, never in git |
| Logs | `/opt/sru-field/logs/` |
| Backups | `/opt/sru-field/backups/`, daily 19:00 UTC = 02:00 WIB |

There is a second repo, `sru-field-app` — the Android app. **It is not deployed
here.** Its APK is built on a workstation. Nothing about it runs on this host.

### How deploys reach this host

CI cannot push to this host: Cloudflare challenges the GitHub runner and the
firewall drops non-Cloudflare traffic. So the host **polls**. `ops/field-deploy-watch.sh`
runs from cron every 3 minutes, compares the GHCR digest for `:latest` against
the running container's, and redeploys when they differ. Every request is
outbound, which nothing blocks.

So: a push to `main` → CI builds and pushes the image → within ~3 minutes this
host pulls it. You do not deploy by hand unless you are debugging.

---

## 4. Before you start: preconditions

Check these first. If any fails, that is the task — not the thing you were
asked to do.

```bash
cd /opt/sru-field

# 1. Is there an image to run?
docker manifest inspect ghcr.io/hfzndev/sru-field-api:latest >/dev/null && echo "GHCR ok" || echo "GHCR UNREACHABLE — check docker login"

# 2. Does DNS resolve, and through Cloudflare?
dig +short ops.sruipal.com

# 3. Does the env file exist and is it locked down?
stat -c '%a %n' .env.field        # must be 600

# 4. Does the data directory belong to the container's user?
stat -c '%u:%g %n' data           # must be 1001:1001
```

`docker login ghcr.io` is required even for public images. If step 1 fails with
an auth error, a human must supply the PAT.

---

## 5. Bringing it up

For a first-time host, follow `docs/VPS-SETUP.md` — it covers DNS, TLS, nginx,
firewall and the WAF rules, which are mostly human steps you verify. This
section is the part you own: getting the container running and correct.

```bash
cd /opt/sru-field
docker compose pull
docker compose up -d
```

Then wait for health rather than assuming it:

```bash
for i in $(seq 1 20); do
  curl -fsS --max-time 5 http://127.0.0.1:3003/api/health && break
  sleep 3
done
```

Expected body, exactly:

```json
{"status":"healthy","database":"connected"}
```

Then confirm *which build* is running. The host's git log is not the answer —
the running image is:

```bash
docker exec sru-field-api cat /app/public/version.json
```

If `version` is empty or `commit` is `nogit`, the image was built without git
history and should not be trusted as a release. Report it; do not patch around
it here.

---

## 6. Seeding — decide before you run it

`docker exec sru-field-api node scripts/seed-admin.js`
`docker exec sru-field-api node scripts/seed-initial.js`

Run these **only on a first deploy**, or when a human has explicitly asked.

They are idempotent in the sense that they create no duplicates. They are not
side-effect free:

- `seed-admin` **resets the admin password** to whatever is in `.env.field`.
- `seed-initial` re-stamps every master row, so `dataVersion` jumps and every
  handset re-pulls the entire master set on its next sync — wasteful on a 2G
  link in the plant.

Check first. This handles a brand new database, where the tables do not exist
yet and a plain `COUNT(*)` throws a stack trace rather than returning zero:

```bash
docker exec sru-field-api node -e "
const db = require('better-sqlite3')('/app/data/field.db');
const has = n => !!db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name=?\").get(n);
if (!has('tanks')) { console.log('NOT SEEDED - fresh database'); process.exit(0); }
const n = t => db.prepare('SELECT COUNT(*) n FROM ' + t).get().n;
console.log('tanks', n('tanks'), 'shifts', n('shift_accounts'), 'admins', n('admin_users'));
"
```

- `NOT SEEDED - fresh database` → seed it.
- Any counts at all → it is already seeded. Do not re-run without being asked.

After seeding, this prints exactly `tanks 2 shifts 4 admins 1`, and the tanks
are `93T-401` and `93T-402`.

---

## 7. Is it actually live?

A running container proves almost nothing (§1). These five checks are what
"live" means. Run all of them.

```bash
# 1. Container healthy
docker ps --filter name=sru-field-api --format '{{.Status}}'          # "Up ... (healthy)"

# 2. App answers locally
curl -fsS http://127.0.0.1:3003/api/health

# 3. App answers THROUGH Cloudflare — the check that matters
curl -sS https://ops.sruipal.com/api/health
```

Check 3 must return the health JSON. **If it returns HTML, the system is not
live**, however healthy checks 1 and 2 look: that is a Cloudflare challenge
page, and every handset in the plant is locked out while reporting "no signal".
The fix is a WAF rule a human must set (`docs/VPS-SETUP.md` step 7). Stop and
report.

```bash
# 4. SRU APP is undisturbed
curl -sS -o /dev/null -w '%{http_code}\n' https://app.sruipal.com

# 5. A backup exists and restores
bash ops/field-backup.sh
ls -la backups/
```

Only after all five: report the system live, and say which version
(`version.json`) is running.

---

## 8. The scheduled jobs

Installed via `crontab -e`. All of them log into `/opt/sru-field/logs/`.

```cron
*/3 * * * * bash /opt/sru-field/ops/field-deploy-watch.sh   >> /opt/sru-field/logs/deploy.log 2>&1
0 19 * * *  bash /opt/sru-field/ops/field-backup.sh         >> /opt/sru-field/logs/backup.log 2>&1
0 */6 * * * bash /opt/sru-field/ops/field-health-check.sh   >> /opt/sru-field/logs/health.log 2>&1
```

Run each once by hand before trusting cron with it.

`ops/field-orphan-sweep.sh` is for **Phase 3 only** — it deletes operator
photographs, and photos do not exist yet. It is dry-run unless given `--apply`.
Do not add `--apply` on your own initiative; a human runs it in dry-run for a
week first and reads the log.

The health check pages Telegram only if `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` are in its environment. Without them it still logs.

---

## 9. When something is wrong

| Symptom | Almost always | Confirm with |
|---|---|---|
| Handsets all say "no signal", server looks fine | Cloudflare challenging `/api/*` | `curl -sS https://ops.sruipal.com/api/health` from off-host — HTML means challenge |
| Cloudflare 522 | Origin unreachable — container down, nginx down, or firewall changed | `docker ps`, `systemctl status nginx` |
| Container up, every write fails, `SQLITE_CANTOPEN` | `data/` not owned by 1001 | `stat -c '%u:%g' data` |
| Uploads fail around 1MB | `client_max_body_size` missing from *this* server block | `nginx -T \| grep -A5 ops.sruipal.com` |
| Admin footer shows no version | Image built without git history | `docker exec sru-field-api cat /app/public/version.json` |
| Deploy did not land | Watcher failed or GHCR auth expired | `tail -50 logs/deploy.log` |
| `docker exec ... node scripts/...` says "Cannot find module" | Image predates the fix that copies `scripts/` and `lib/` into the runtime image | Check `version.json`; a newer image is needed |

Container logs: `docker logs --tail 200 sru-field-api`.

### Rollback

Images are tagged by commit sha and stay in GHCR. To go back, pin the sha in
`docker-compose.yml` and `docker compose up -d`.

Rollback is safe for data: migrations are additive only (`CREATE TABLE IF NOT
EXISTS`, added columns), and the server never deletes field records. You do not
need to migrate backwards.

---

## 10. If you are asked to change code

This repo is JavaScript ESM — **not TypeScript**. Next.js 16 App Router,
better-sqlite3, zod, vitest.

- `npm run lint && npm test && npm run acceptance` before proposing anything.
- `../sru-field-docs` is the source of truth. Where code and those documents
  disagree, the documents win.
- Never set `SKIP_GIT_TAG=1`, never exclude `.git` in `.dockerignore`, and keep
  `fetch-depth: 0` in CI — each of those silently produces an image that cannot
  report its own version.
- Deploy by pushing to `main` and letting CI and the watcher do their work.
  Building an image by hand on the VPS produces something no one can trace.

Do not commit with a `Co-Authored-By` line.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
