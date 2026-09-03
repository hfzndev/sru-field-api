# VPS setup runbook — sru-field-api

The executable companion to doc 09 §3, which lists *what* must be true. This is
the order to do it in, with a check after each step so a mistake surfaces on the
step that caused it rather than three steps later.

Target: `https://ops.sruipal.com` → nginx → `127.0.0.1:3003` → container.

> **The host already runs SRU APP.** Nothing here touches it: different
> container, port, volume, database and nginx server block. Two steps can still
> break it if done carelessly — the firewall (step 6) and the nginx reload
> (step 5) — and both are called out where they occur. Verify `app.sruipal.com`
> still answers at the end of this runbook.

---

## Before you start

Have these in hand:

- SSH access to the VPS with a user in the `docker` group.
- Cloudflare access to the `sruipal.com` zone.
- A Cloudflare **API token** scoped to `Zone:DNS:Edit` for that zone (certbot
  DNS-01 needs it; see step 4).
- A GitHub **classic** PAT with `read:packages` (GHCR requires auth even for
  public images).
- Two passwords you have chosen for the admin account and the shift accounts.
  Do not reuse anything.

---

## Step 1 — DNS

In Cloudflare, zone `sruipal.com`:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `ops` | *VPS IPv4* | **Proxied** (orange) |

Verify — the answer must be Cloudflare's IPs, not the VPS's, which is what
tells you the proxy is on:

```bash
dig +short ops.sruipal.com
```

## Step 2 — Host directory

```bash
sudo mkdir -p /opt/sru-field
sudo chown "$USER":"$USER" /opt/sru-field
cd /opt/sru-field
git clone https://<YOUR_PAT>@github.com/hfzndev/sru-field-api.git .
mkdir -p data/uploads data/apk logs backups
```

Cloning (rather than copying three files) means `git pull` later updates the
ops scripts along with everything else.

**The container runs as uid 1001 and the bind mount overrides the image's
ownership.** If the host directory is root-owned, the container starts, then
fails on its first write with `SQLITE_CANTOPEN` — which reads like a corrupt
database rather than a permissions problem:

```bash
sudo chown -R 1001:1001 /opt/sru-field/data
```

Verify:

```bash
stat -c '%u:%g %n' /opt/sru-field/data     # must print 1001:1001
```

## Step 3 — Secrets

```bash
cd /opt/sru-field
cp .env.example .env.field
chmod 600 .env.field
openssl rand -hex 32          # paste as SESSION_SECRET
nano .env.field
```

Fill in `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SHIFT_PASSWORD`.
Leave `DATABASE_PATH` commented — compose sets it to `/app/data/field.db`.

Verify:

```bash
stat -c '%a %n' .env.field    # must print 600
```

> `SHIFT_PASSWORD` is shared by one whole shift and gets typed on a handset in
> a plant. Make it strong but typeable — an operator who cannot enter it at
> 03:00 will write it on the phone case.

## Step 4 — TLS certificate

**HTTP-01 does not work behind the Cloudflare proxy.** Use DNS-01:

```bash
sudo mkdir -p /etc/letsencrypt
sudo nano /etc/letsencrypt/cloudflare.ini     # dns_cloudflare_api_token = <token>
sudo chmod 600 /etc/letsencrypt/cloudflare.ini

sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d ops.sruipal.com
```

Verify:

```bash
sudo certbot certificates | grep -A2 ops.sruipal.com
```

## Step 5 — nginx

New server block only. **Do not edit the SRU APP block.**

```nginx
server {
    listen 443 ssl http2;
    server_name ops.sruipal.com;

    ssl_certificate     /etc/letsencrypt/live/ops.sruipal.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ops.sruipal.com/privkey.pem;

    # Photo uploads are up to 5MB. nginx defaults to 1MB and rejects them
    # before the app ever sees the request, so the app-side limit never fires
    # and the error says nothing useful. Must be set in this server block.
    client_max_body_size 10M;

    # Nothing under these ever belongs on the public internet.
    location ~ /\.(db|env|git) { deny all; return 404; }
    location ~ \.db$          { deny all; return 404; }

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    server_name ops.sruipal.com;
    return 301 https://$host$request_uri;
}
```

Verify before reloading — a config error takes SRU APP down with it:

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -sS -o /dev/null -w '%{http_code}\n' https://app.sruipal.com   # SRU APP still fine
```

## Step 6 — Firewall

Leave the existing panel/UFW rules alone. 80/443 stay restricted to Cloudflare
IP ranges.

> Setting the panel firewall to allow-all to "make it work" produces a
> Cloudflare 522 and exposes the origin. If something is unreachable, the cause
> is upstream (DNS, WAF, nginx) — not this.

Verify `3003` is not reachable from outside; it must be bound to loopback only:

```bash
ss -lntp | grep 3003          # expect 127.0.0.1:3003, never 0.0.0.0:3003
```

## Step 7 — Cloudflare WAF rules

Zone → Security → WAF → Custom rules. Order matters; these go **first**.

| # | Expression | Action |
|---|---|---|
| 1 | `starts_with(http.request.uri.path, "/api/")` | **Skip** → Managed Challenge + Bot Fight Mode |
| 2 | `http.request.uri.path eq "/api/health"` | Skip (redundant with #1 — keep it, explicit is safer) |

Leave the full challenge in place for `/admin/*` and `/`.

The handsets are native apps, not browsers. **Any** challenge on `/api/*` blocks
every device in the field at once, and the app reports it as "no signal" — the
one failure that looks exactly like the condition the app is designed for.

Verify **from a network outside Cloudflare**, not from the VPS:

```bash
curl -sS https://ops.sruipal.com/api/health
```

JSON 200 is correct. **HTML is a failure** — that is a challenge page, and it
means the rule is inactive or not first.

## Step 8 — GHCR login and first start

```bash
cd /opt/sru-field
echo "<YOUR_PAT>" | docker login ghcr.io -u hfzndev --password-stdin
docker compose pull
docker compose up -d
```

Verify:

```bash
docker ps --filter name=sru-field-api
curl -sS http://127.0.0.1:3003/api/health
docker exec sru-field-api cat /app/public/version.json
```

That last one is the version **actually running**, which is not always what the
host's git log says.

## Step 9 — Seed

Reads credentials from the container's env, which compose loaded from
`.env.field` — so nothing is typed on the command line, where it would land in
shell history:

```bash
docker exec sru-field-api node scripts/seed-admin.js
docker exec sru-field-api node scripts/seed-initial.js
```

Both are idempotent and safe to re-run: no duplicate rows, and `seed-admin` resets
the admin password rather than failing.

Re-running is not quite free, though. `seed-initial` re-stamps every master row,
so `dataVersion` jumps and every handset pulls the whole master set again on its
next sync instead of nothing. Harmless on wifi, wasteful on a 2G link in the
plant — so re-seed deliberately, not as a reflex.

Verify:

```bash
docker exec sru-field-api node -e "
const db=require('better-sqlite3')('/app/data/field.db');
console.log('tanks   ', db.prepare('SELECT COUNT(*) n FROM tanks').get().n);
console.log('shifts  ', db.prepare('SELECT COUNT(*) n FROM shift_accounts').get().n);
console.log('admins  ', db.prepare('SELECT COUNT(*) n FROM admin_users').get().n);
"
```

Expect 2 tanks, 4 shift accounts, 1 admin.

Then log in to `https://ops.sruipal.com/admin` with the admin credentials.

## Step 10 — Deploy watcher

CI cannot push to this host — Cloudflare challenges the GitHub runner and the
firewall drops anything not from Cloudflare. The host polls instead; every
request is outbound, which nothing blocks.

```bash
crontab -e
```

```cron
*/3 * * * * bash /opt/sru-field/ops/field-deploy-watch.sh >> /opt/sru-field/logs/deploy.log 2>&1
```

Verify by running it by hand first:

```bash
bash /opt/sru-field/ops/field-deploy-watch.sh
```

## Step 11 — Backups

Field data exists **only** here. Handsets keep a rolling 7-day window and purge
older records, so a lost `field.db` is data that no longer exists anywhere.

```cron
0 19 * * * bash /opt/sru-field/ops/field-backup.sh >> /opt/sru-field/logs/backup.log 2>&1
```

(19:00 UTC = 02:00 WIB.)

Verify now, not on the first incident:

```bash
bash /opt/sru-field/ops/field-backup.sh
ls -la /opt/sru-field/backups/
```

### Test a restore before the pilot

Doc 09 §5 requires this once, and it is the only way to know the backups are
real:

```bash
mkdir -p /tmp/restore-test && cd /tmp/restore-test
tar xzf /opt/sru-field/backups/field_backup_<ts>.tar.gz
sqlite3 field.db "PRAGMA integrity_check;"     # must print: ok
```

## Step 12 — Health monitoring

```cron
0 */6 * * * bash /opt/sru-field/ops/field-health-check.sh >> /opt/sru-field/logs/health.log 2>&1
```

Checks local `:3003/api/health`, external `https://ops.sruipal.com/api/health`
(which also catches a WAF rule someone changed later), container state, SSL
expiry and disk. Alerts only on failure.

## Step 13 — Orphan photo sweeper (Phase 3)

Not needed until photos ship. When they do, run it in **dry-run for a full
week** and read the log before adding `--apply` — it deletes operator
photographs, and that default is the only thing between a bug and losing them.

```cron
0 20 * * 0 bash /opt/sru-field/ops/field-orphan-sweep.sh >> /opt/sru-field/logs/orphan-sweep.log 2>&1
```

---

## Final gate — before any handset goes out

- [ ] `curl https://ops.sruipal.com/api/health` from **outside** → JSON, not HTML
- [ ] A real login from the app against `ops.sruipal.com` succeeds
- [ ] One reading syncs and appears in the admin Data Lapangan tab
- [ ] `https://app.sruipal.com` (SRU APP) still normal
- [ ] `.env.field` is `600`; `data/` is `1001:1001`
- [ ] A backup file exists and `PRAGMA integrity_check` on it printed `ok`
- [ ] The APK keystore is backed up in two places (see the app repo's
      `docs/APK-BUILD.md` — losing it means uninstalling every handset, which
      discards unsent records)

## When something is wrong

| Symptom | Look here first |
|---|---|
| App says "no signal" everywhere, server is up | CF WAF challenging `/api/*` (step 7) — curl it from outside and check for HTML |
| 522 from Cloudflare | Origin unreachable: container down, nginx down, or firewall changed |
| Container up, every write fails | `data/` ownership (step 2) |
| Uploads fail around 1MB | `client_max_body_size` missing from **this** server block (step 5) |
| Admin footer shows no version | Image built without git history — `.dockerignore` must not exclude `.git` |
| Deploy did not land | `tail /opt/sru-field/logs/deploy.log`; confirm `docker login ghcr.io` still valid |
