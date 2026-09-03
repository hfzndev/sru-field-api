# sru-field-api

Backend API and admin web for the **SRU Field App** — offline-first field data
capture for the sulfur IPAL at Cilacap.

Built against the specification in `../sru-field-docs` (v1.1). That document set
is the source of truth; where this code and those docs disagree, the docs win
and the code is wrong.

Runs entirely separately from SRU APP: own repository, own container, own port,
own database. Nothing here reads or writes `sru.db`.

## Requirements

Node 22+ (developed on 24), and git — `scripts/version.js` reads the tag history
to produce `public/version.json`.

## Setup

```bash
npm install
```

Create `.env.local` from `.env.example`. Only `SESSION_SECRET` is needed to run;
generate one with `openssl rand -hex 32`.

## Seed a local database

Neither script writes a password anywhere — both read the environment, and both
are safe to re-run (the shift seed doubles as a password reset).

```bash
SHIFT_PASSWORD=rahasia123 npm run seed:initial
```

Creates tanks **93T-401** (7953 mm) and **93T-402** (7974 mm), plus shift
accounts `shift_a` … `shift_d`.

```bash
ADMIN_PASSWORD=admin12345 npm run seed:admin
```

## Run

```bash
npm run dev
```

Serves on <http://localhost:3000>. The database appears at `data/field.db` on
first request.

## Manual walkthrough

Every command below has been run against a fresh database; the responses are the
real ones.

### 1. Is it alive

```bash
curl -s localhost:3000/api/health
curl -s localhost:3000/api/version
```

```json
{"status":"healthy","database":"connected"}
{"version":"0.1.5","buildDate":"...","commit":"d63bc59"}
```

### 2. Log in as a shift

One request returns the token **and** everything a phone needs for a whole
offline shift — login is the only moment an operator reliably has signal.

```bash
curl -s -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"shift_a","password":"rahasia123","deviceName":"HP-1","appVersion":"1.0.0"}'
```

Look for: both tank codes in full, `dataVersion`, and `tankDeviation` (empty
until readings exist). Save the token:

```bash
TOKEN=<paste the token value>
```

### 3. Sync a tank reading

The worked example from doc 02 §2.1 — tape 2901 mm into a 7953 mm tank with
35 mm of sulfur on the bob:

```bash
curl -s -X POST localhost:3000/api/sync \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"readings":[{"clientId":"11111111-1111-4111-8111-111111111111","tankId":1,
       "dcsLevelMm":5000,"tapeLengthMm":2901,"bandulSulfurMm":35,"attempts":2,
       "operatorName":"Budi","shiftGroup":"Shift A","shiftTime":"pagi",
       "readingAt":"2026-09-02T01:10:00.000Z"}]}'
```

```json
{"acked":[{"clientId":"1111...","serverId":1,"levelMm":5087,"deviationMm":87}],
 "duplicates":[],"errors":[],"serverTime":"..."}
```

`levelMm` is computed by the server, not the client — `7953 − 2901 + 35`.

### 4. Send the identical payload again

This is the guarantee that lets an operator mash the Sync button on a bad
connection without fear:

```json
{"acked":[],"duplicates":[{"clientId":"1111...","serverId":1}],"errors":[]}
```

Still one row in the database.

### 5. One bad record must not sink the batch

Send two readings where the second has `"bandulSulfurMm":100` — beyond what the
bob gauge can physically read:

```json
{"acked":[{"...":"...","levelMm":5108,"deviationMm":108}],
 "errors":[{"clientId":"3333...","error":{"code":"BANDUL_OUT_OF_RANGE",
            "message":"Tinggi sulfur bandul 0–99 mm (terbaca 100 mm)"}}]}
```

HTTP is still **200**. The good reading landed; only the bad one is held back
for the operator to fix.

> On Windows, `–` may render as `â€"` in the terminal. That is the console
> using cp1252; the response bytes are correct UTF-8.

### 6. Wrong password

```bash
curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"shift_a","password":"salah"}'
```

`401 {"error":{"code":"INVALID_CREDENTIALS","message":"Username atau password salah"}}`

An unknown username returns a byte-identical response — nothing here reveals
whether an account exists. Try six wrong passwords in a row and the sixth
returns **429**.

### 7. Pull

```bash
curl -s "localhost:3000/api/pull?since=0" -H "Authorization: Bearer $TOKEN"
```

Returns all active master rows plus your shift's records from the last 7 days.
Now repeat with the `dataVersion` the response reported:

```bash
curl -s "localhost:3000/api/pull?since=6" -H "Authorization: Bearer $TOKEN"
```

`master` comes back **empty**. That is the delta working: nothing changed, so
nothing is sent. If every pull returns the full master, the delta filter is
broken (see doc 05 §2).

### 8. Upload a photo

Any real JPEG will do:

```bash
curl -s -X POST localhost:3000/api/upload \
  -H "Authorization: Bearer $TOKEN" -F "file=@/path/to/photo.jpg"
```

```json
{"path":"uploads/6f1c…-….jpg"}
```

The filename you sent is discarded — the stored name is a fresh UUID. Fetch it
back in a browser tab (the query needs your token, so use curl and open the
file, or use the admin cookie once task 8 lands):

```bash
curl -s "localhost:3000/api/photo?path=uploads/<uuid>.jpg" \
  -H "Authorization: Bearer $TOKEN" -o out.jpg && start out.jpg
```

Now try to abuse it. Rename an HTML file to `.jpg` and upload it:

```bash
printf '<html><script>alert(1)</script></html>' > evil.jpg
curl -s -X POST localhost:3000/api/upload \
  -H "Authorization: Bearer $TOKEN" -F "file=@evil.jpg"
```

`415` — the type is decided by the file's leading bytes, not its name or its
declared Content-Type. Nothing is written to disk.

And traversal:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "localhost:3000/api/photo?path=uploads/../../etc/passwd" -H "Authorization: Bearer $TOKEN"
```

`404` — the same answer given for a file that simply is not there, so probing
reveals nothing about the filesystem.

## Looking at the data directly

```bash
sqlite3 data/field.db "SELECT id, level_mm, deviation_mm, operator_name, reading_at FROM tank_readings;"
sqlite3 data/field.db "SELECT key, value FROM meta;"
```

For a GUI, open `data/field.db` in [DB Browser for SQLite](https://sqlitebrowser.org/).
Close it before writing through the API — two writers on one SQLite file will
block each other.

There is no web interface yet; the admin UI is task 8 of Phase 1.

## Tests

```bash
npm test
```

## Build

```bash
npm run build
```

Regenerates `public/version.json` first. If that file comes out empty, the cause
is almost always one of: `actions/checkout` without `fetch-depth: 0`,
`.dockerignore` excluding `.git`, a builder image without git, or
`SKIP_GIT_TAG=1`. Never set the last one.

## Regenerating the schema

`lib/schema.sql` and `lib/schema.generated.js` are generated from
`../sru-field-docs/05-Database-Schema.md` so the DDL cannot drift from the spec.
Edit the document, then re-run the extractor rather than editing either file.
