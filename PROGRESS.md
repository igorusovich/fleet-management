# Progress Tracker

Living log for the fleet telemetry build. One task at a time; each task is only marked done once
its verification gate from `PLAN.md` §9 has actually been run.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done & verified · `[!]` blocked

## Tasks

| # | Task | Status | Verification evidence |
|---|------|--------|-----------------------|
| 0 | Scaffold Next.js app + layout + config env | `[x]` | `typecheck` 0 · `lint` 0 · `build` 0 (static `/`) · dev `GET / 200` |
| 1 | Domain types, zod schemas, status derivation, config | `[x]` | `typecheck` 0 · `npm test` 26/26 pass (5 suites, 0 fail) |
| 2 | DB layer (schema, repository, latest read model) | `[x]` | 12 db tests pass; typecheck, lint, build green |
| 3 | `POST /api/ingest` | `[x]` | typecheck 0 · 52/52 tests (14 new) · lint 0 · build 0 (`ƒ /api/ingest`) · 8-case curl matrix correct |
| 4 | `GET /api/fleet` | `[x]` | typecheck 0 · 65/65 tests (13 new) · lint 0 · build 0 (`ƒ /api/fleet`) · 7-case curl matrix correct |
| 5 | `GET /api/robots/:id` | `[ ]` | — |
| 6 | SSE `/api/stream` | `[ ]` | — |
| 7 | Robot simulator CLI | `[ ]` | — |
| 8 | Fleet overview UI | `[ ]` | — |
| 9 | Robot detail UI | `[ ]` | — |
| 10 | Resilience pass (retention, seeds, README) | `[ ]` | — |
| 11 | Final verification suite | `[ ]` | — |

## Task 1 plan — pure domain core (`lib/`)

Goal: the I/O-free core every later layer sits on. No network, no DB, no React, no Next imports.
Built and tested in isolation so tasks 3–5 are wiring, not debugging.

| File | Contents |
|---|---|
| `lib/config.ts` | Read `process.env` once, apply defaults, validate, export a frozen `config`: `ingestApiKey`, `databasePath`, `thresholds {offlineAfterMs, delayedAfterMs, lowBatteryPct}`, `retentionHours`. Bad values throw at startup naming the variable and the received value — no silent fallback after a typo. |
| `lib/telemetry/schema.ts` | `MOTION_STATES`, `reportSchema`, `ingestBodySchema`, types `TelemetryReport`, `IngestBody`, `MotionState`. No I/O. |
| `lib/telemetry/status.ts` | `RobotStatus` union, `deriveStatus(latest, now, thresholds)`. No I/O. |
| `tests/telemetry.test.ts`, `tests/config.test.ts` | `node:test` cases listed under the gate. |

**Report schema** — unknown keys stripped (never rejected), so a chatty device can't break ingest:

| Field | Rule |
|---|---|
| `robotId` | string 1–64, `/^[A-Za-z0-9._:-]+$/` |
| `seq` | integer ≥ 0 |
| `ts` | integer > 0 (epoch ms) |
| `battery` | number 0–100 |
| `charging` | boolean |
| `motion` | `idle` \| `moving` \| `charging` \| `error` |
| `x`, `y` | number −1e6…1e6 (bounds catch NaN/Infinity for free) |
| `heading` | number 0–360 (degrees) |
| `speed` | number 0–10 (m/s) |
| `errorCode` | string ≤ 64, nullable, defaults to `null` |

Batch shape `{ reports: Report[] }`, array capped at 500. A bare single report is accepted by the
parser added in task 3, not by the schema.

**Status precedence**, first match wins: `offline` → `delayed` → `fault` → `charging` →
`low_battery` → `moving` → `idle`, with `now - receivedAt` compared against config thresholds.

**Tooling:** `zod` as the only runtime dependency, `tsx` as a dev dependency (it is needed for the
simulator in task 7 anyway) to run `node:test` against TypeScript: `node --import tsx --test`.
No test framework, no path-alias config to maintain.

**Gate:** `npm run typecheck` + `npm test` green, covering:

1. Valid report parses; an extra unknown key is stripped, not rejected.
2. Each invalid field rejected with the failing path (battery 101, seq −1, `motion: "flying"`, non-finite `x`, empty `robotId`).
3. Batch over 500 rejected; empty batch accepted (nothing to do, not an error).
4. Status precedence: `fault` beats `charging`, `charging` beats `low_battery`, `moving`, `idle`.
5. Threshold boundaries: 10 000 ms is still `delayed`, 10 001 ms is `offline`; 3 000 vs 3 001 ms.
6. Config: defaults used when env is absent, invalid `OFFLINE_AFTER_MS="soon"` throws naming the variable.

**Decisions taken** (confirmed in the Lavish review, 2026-11-21): heading **wraps at 360** — the
schema accepts 0–360 inclusive and `normaliseHeading()` folds into `[0, 360)`; tests live in
**`tests/`** at the root.

**Boundary decision:** `lib/config.ts` holds the ingest secret, so it stays server-only. The UI
never imports it; threshold values reach the browser through the fleet API response (task 4), which
keeps `INGEST_API_KEY` out of the client bundle.

## Task 2 plan — SQLite storage layer

Goal: give the task-1 types a home. Three tables behind one repository, so tasks 3–5 are
parse → call → shape. Visual plan with diagrams and open decisions: `.lavish/task-2-plan.html`.

| File | Contents |
|---|---|
| `lib/db/schema.ts` | DDL for `telemetry`, `robot_latest`, `robots`; two indexes; `PRAGMA user_version` migration step. |
| `lib/db/client.ts` | Create the directory, open the file, apply pragmas (WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`), migrate, cache the handle on `globalThis` so dev HMR does not leak connections. |
| `lib/db/telemetry.ts` | `ingestReports(db, reports, receivedAt) → {accepted, duplicates}`, `listLatest(db)`, `getLatest(db, robotId)`. Prepared statements; one transaction per batch. |
| `tests/db.test.ts` | The nine gate cases, on a temp directory per suite. |

**Invariant:** `robot_latest.seq` is the highest seq ever ingested and `received_at` is when that
report arrived. History accepts late reports; the guarded upsert
(`WHERE excluded.seq > robot_latest.seq`) never lets one rewind the read model — including its
`received_at`, so a retried batch cannot make a robot look freshly alive.

**Gate — run 2026-11-21, all green:**

```
npm run typecheck   # 0
npm test            # 38 tests, 38 pass, 0 fail (26 from task 1 + 12 new)
npm run lint        # 0
npm run build       # 0 — compiled in 437 ms; routes: / and /_not-found
```

Cases: fresh open (three tables, `journal_mode=wal`, `synchronous=1`, `busy_timeout=5000`,
`foreign_keys=1`, `user_version=1`, missing parent directories created); first ingest with
promotion; replayed batch (`duplicates=2`, `received_at` unchanged); late older seq (history grows,
read model does not move); same seq with a different payload (first write wins); independent
per-robot seq; `listLatest` ordering and fields; unknown id returns `null`; reopen persistence with
no re-migration; a second connection reads a committed batch; auto-registration that preserves a
curated name; empty batch.

**Decisions approved (Lavish, as recommended):** auto-register unknown robots on ingest
(`name = id`, `site_id = 'unassigned'`, `model = 'unknown'`, `created_at = receivedAt`);
`PRAGMA user_version` stepwise migrations; temp-file databases in tests.

**Notes from implementation**

- `better-sqlite3` 13.2.0 + `@types/better-sqlite3` 9.6.0 installed; SQLite 3.54.1, prebuilt binary,
  no compiler needed. `next.config.ts` untouched — Next 16 already externalises the package, and the
  build confirms it stays server-side.
- Headings are normalised at ingest (360 → 0) via task 1's `normaliseHeading`, so the stored value is
  canonical and the UI never has to decide which of two equal bearings to draw.
- Prepared statements are cached per connection in a `WeakMap` (compiled once, not per tick), and
  `robot_latest` is only promoted when a report is written to history too — same transaction, so the
  two tables cannot disagree.

**Verified facts before planning:** `better-sqlite3` 13.2.0, engines `node >=22`, ships no types →
`@types/better-sqlite3` 9.6.0 (v9 types against a v13 runtime; tracked as risk R4); Next 16 lists
`better-sqlite3` among automatically externalised server packages, so `next.config.ts` needs no
change; `node:sqlite` works on Node 22.23 but requires `--experimental-sqlite` and prints an
`ExperimentalWarning`, which a Next route worker does not get.

## Task 3 plan — the ingest endpoint

Goal: the one door into the store. Authentication, request size and partial failure are the whole
problem; the happy path is eight lines. Visual plan: `.lavish/task-3-plan.html`.

| File | Contents |
|---|---|
| `app/api/ingest/route.ts` | Adapter only: resolve `db`, `config.ingestApiKey` and `Date.now()`, then delegate. No `runtime` export — `cacheComponents` rejects one, including `runtime = 'nodejs'`. |
| `lib/http/ingest.ts` | `handleIngest(request, { db, expectedKey, now })`. Five gates: key → size/JSON → body shape → per-report validation → store. Plain Web `Response`, no `next/*` import, so tests call it directly. |
| `lib/http/auth.ts` | `hasValidIngestKey(provided, expected)`: SHA-256 both sides, then `timingSafeEqual`, so neither a missing header nor a length difference leaks anything. |
| `tests/ingest.test.ts` | 14 cases against a temp database with a pinned `now`. |

**Outcome table (first match wins):** 401 `unauthorized` (before the body is read) · 413
`payload_too_large` · 400 `invalid_json` · 400 `invalid_body` · 400 `empty_batch` · 400
`batch_too_large` (>500) · 400 `invalid_reports` (only when every report fails) · 200
`{ accepted, duplicates, rejected: [{ index, reason }] }` including all-duplicate batches.

**Partial success is the core requirement.** Task 1's `ingestBodySchema` validates the envelope
as a whole, so one bad robot would drop the batch; the route checks the envelope's shape lightly
and runs `reportSchema.safeParse` per report. `index` is the request position and `reason` comes
from `describeIssues`, so task 7's simulator can log exactly which robot to fix.

**Gate:** `npm run typecheck` · `npm test` (52 expected: 38 + 14) · `npm run lint` · `npm run build`
(`ƒ /api/ingest` must appear in the route table) · then the 8-command curl matrix against
`npm run dev`: single report, replay, no key, wrong key, malformed JSON, mixed batch, older `seq`,
501 reports.

**Decisions (confirmed 2026-11-21):** thin route + `lib/http/ingest.ts`; an all-invalid batch is
400 `invalid_reports`; an empty `reports: []` is 400 `empty_batch`.

**Verified in the bundled Next 16 docs before planning:** route handlers are uncached by default;
unsupported methods get an automatic 405; the Web `Request`/`Response` APIs with
`Response.json(...)` are the documented idiom; and with `cacheComponents` enabled any `runtime`
route segment config must be removed, including `runtime = 'nodejs'`.

### Gate output (task 3, 2026-11-21)

`npm run typecheck` 0 · `npm test` **52/52 pass** (14 new, 7 suites) · `npm run lint` 0 ·
`npm run build` 0 with the route table `○ /`, `○ /_not-found`, `ƒ /api/ingest`.

Live matrix against `npm run dev` on port 3100, temp DB / temp key (`INGEST_API_KEY=matrix-key`):

```text
1 valid single report         200  {"accepted":1,"duplicates":0,"rejected":[]}
2 replay same report          200  {"accepted":0,"duplicates":1,"rejected":[]}
3 missing key                 401  unauthorized
4 wrong key                   401  unauthorized
5 malformed JSON              400  invalid_json
6 mixed batch, 1 bad battery  200  {"accepted":2,"duplicates":0,"rejected":[{"index":1,"reason":"battery: Too big: expected number to be <=100"}]}
7 out-of-order older seq      200  {"accepted":1,...} — robot_latest stayed seq=2/battery=90, telemetry kept seq=0
8 501 reports                 400  batch_too_large {received:501,limit:500}
```

Stored state after the matrix: `robot_latest` = RBT-001 seq 2 (battery 90) and RBT-003 seq 1;
`telemetry` = 4 rows with RBT-001 spanning seq 0–2. One log line per accepted request:
`ingest received=3 accepted=2 duplicates=0 rejected=1 ms=0`. Dev server stopped, port 3100 closed.

## Task 4 plan — the fleet snapshot

Goal: the read the fleet screen lives on. Nothing is written here; the work is joining display
metadata to the read model, deriving status against a single `now`, and deciding what the health
counts mean under a filter. Visual plan: `.lavish/task-4-plan.html`.

| File | Contents |
|---|---|
| `app/api/fleet/route.ts` | Adapter only: `getDb()`, `config.thresholds`, `Date.now()` → `handleFleet`. No `runtime` or `dynamic` export. |
| `lib/http/fleet.ts` | `handleFleet(request, { db, thresholds, now })`: parse `site`/`status`/`q`, call the repository, derive status + `ageMs`, filter, count, respond. Plain `Response`, no `next/*` import. |
| `lib/db/telemetry.ts` | `listFleet(db, { now, windowMs })` — `robots LEFT JOIN robot_latest`, plus a correlated count of telemetry rows with `received_at >= now - 60s`. |
| `lib/db/schema.ts` | Migration 2: `CREATE INDEX telemetry_robot_received ON telemetry (robot_id, received_at DESC)`; `SCHEMA_VERSION` becomes 2. |
| `tests/fleet.test.ts` | 12 handler cases on a temp database with a pinned `now`. |
| `tests/db.test.ts` | 1 new case: a version-1 file migrates to 2 with rows and read model intact. |

**Response:** `{ generatedAt, thresholds, summary, robots[] }`; summary has `total` plus the seven
status buckets; each robot adds `status`, `ageMs` (clamped at 0) and `samplesLastMinute`. Robots
ordered by id. Empty fleet is `200` with zeroes, not an error.

**Filters:** `site` exact on `siteId`; `q` case-insensitive substring of id or name; `status` one of
`ROBOT_STATUSES`, anything else `400 invalid_query` naming the parameter and allowed values. Blank
values behave like absent ones. Filtering happens in JS because `status` is derived at request time
and is not a column.

**Gate:** `npm run typecheck` · `npm test` (65 expected: 52 + 13) · `npm run lint` · `npm run build`
(`ƒ /api/fleet` in the route table) · then 7 curl calls against a temp DB backdated with
`ingestReports(..., receivedAt)` so every bucket is reachable without a simulator: unfiltered, site,
q, status, invalid status, unknown site, and `GET /api/ingest` → 405.

**Decisions (confirmed):** the summary counts after `site`/`q` and before `status`, so a status chip
never zeroes its neighbours; `thresholds` travel in the payload so the UI and the server cannot
disagree about what `offline` means; `samplesLastMinute` counts by `received_at` and rides the
migration 2 index. The repository joins from `robot_latest` (not `robots`) so the read model decides
which robots exist, with `COALESCE` fallbacks for missing metadata.

**Verified in the bundled Next 16 docs:** with `cacheComponents`, `GET` route handlers run at
request time by default and can be prerendered only when they touch no uncached data — and
prerendering stops on `req.url`, database queries and `Date.now()`, all of which this handler uses.
So the route stays dynamic with no `dynamic` or `runtime` export, and unsupported methods still get
Next's automatic 405.

## Log

- **2026-11-21 — planning.** Repo was empty (single initial commit). Environment: Node 22.23,
  npm 10.9, Next 16.4 available, Docker present (unused). Plan and task list written to
  `PLAN.md`.
- **2026-11-21 — decisions confirmed** with the user: SQLite (`better-sqlite3`), batched HTTP
  POST ingestion, SSE with polling fallback.
- **2026-11-21 — task 1 planned.** Pure domain core split across `lib/config.ts`,
  `lib/telemetry/schema.ts` and `lib/telemetry/status.ts`, tested with `node:test` via `tsx`.
  Toolchain check: Node 22.23, zod 4, tsx 4 available. Full plan in “Task 1 plan” above.
- **2026-11-21 — task 0 done.** Scaffolded Next.js 16.4.6 (App Router, TS, Tailwind v4,
  Turbopack) into a temp dir and moved it to the root, because `create-next-app` refuses a
  non-empty directory. App shell: sticky header (brand mark + Fleet nav), footer, dark ops
  palette in `globals.css` (`canvas/surface/raised/line/ink/muted/accent`, plus `.tnum` so
  once-per-second digits don't jitter), placeholder Fleet page. Added `typecheck` script,
  `.env.example`, and gitignore rules for `/data/` and `!.env.example`.
  Verified: `tsc --noEmit` 0, `eslint` 0, `next build` 0 (routes `/`, `/_not-found`), dev server
  `GET / 200` with brand, nav and empty state present in the HTML.

- **2026-11-21 — task 1 done.** Shipped the pure core: `lib/config.ts` (env parsed once into a
  frozen config, cross-checked `DELAYED_AFTER_MS < OFFLINE_AFTER_MS`, errors name the variable
  and the received value, secret never echoed), `lib/telemetry/schema.ts` (`MOTION_STATES`,
  `reportSchema`, `ingestBodySchema` capped at 500, `normaliseHeading`, `describeIssues`) and
  `lib/telemetry/status.ts` (`ROBOT_STATUSES`, `deriveStatus` with the documented precedence and
  an injected `now`). Added `zod` (runtime) and `tsx` (dev), plus the `test` script
  `node --import tsx --test tests/*.test.ts`.
  Verified: `npm run typecheck` 0, `npm test` **26/26 passing** across 5 suites — schema
  accept/reject per field with paths, unknown-key stripping, batch limits, heading wrapping,
  status precedence, strict threshold boundaries (3 000 vs 3 001 ms, 10 000 vs 10 001 ms),
  clock skew, and config defaults/overrides/failures.
  The gate caught one real bug: the modulo round-trip turned `91.2` into `91.19999999999999`;
  fixed by returning in-range bearings unchanged.

- **2026-11-21 — task 2 planned.** Storage layer designed in `.lavish/task-2-plan.html`: three
  tables, one transaction per batch, a seq-guarded read model, four pragmas and nine gate cases.
  Dependency facts checked before planning: `better-sqlite3` 13.2.0 (Node ≥22, no bundled types,
  `@types` at 9.6.0), Next 16 auto-externalises it, `node:sqlite` still experimental on 22.23.
  Three decisions left open for review (robot metadata, migrations, test database).

- **2026-11-21 — task 2 shipped.** `lib/db/schema.ts`, `lib/db/client.ts`, `lib/db/telemetry.ts` and
  `tests/db.test.ts`. Three tables, stepwise `user_version` migrations, WAL + `synchronous=NORMAL` +
  `busy_timeout=5000` + `foreign_keys=ON`, one transaction per batch, `ON CONFLICT DO NOTHING` for
  duplicates and a `WHERE excluded.seq > robot_latest.seq` guard so a late report cannot rewind the
  read model. Gate: typecheck 0, test 38/38 (12 new), lint 0, build 0.

- **2026-11-21 — task 3 planned.** Ingest endpoint designed in `.lavish/task-3-plan.html`: five
  gates, eight outcomes, timing-safe key comparison, per-report validation for partial success, and
  a 14-case gate that calls the handler directly with a temp DB. Read the bundled route-handler and
  `cacheComponents` docs first (no `runtime` export allowed). Three decisions left open: handler
  placement, all-invalid batch status, empty batch status.

- **2026-11-21 — task 3 done.** `POST /api/ingest` as `app/api/ingest/route.ts` (adapter) +
  `lib/http/ingest.ts` (five gates) + `lib/http/auth.ts` (hashed `timingSafeEqual`), with 14 cases in
  `tests/ingest.test.ts`. Gate: typecheck, 52/52 tests, lint and build green; all eight curl cases
  matched the contract, including a 401 that never parsed the body and a late report that landed in
  history without rewinding `robot_latest`. Decisions: thin route, 400 for all-invalid and empty
  batches.

- **2026-11-21 — task 4 done.** `GET /api/fleet` shipped as `app/api/fleet/route.ts` (adapter) +
  `lib/http/fleet.ts` (derive once, filter, count) + `listFleet` in `lib/db/telemetry.ts`, with
  migration 2 adding `telemetry_robot_received`. Gate: typecheck, 65/65 tests (13 new: 12 fleet +
  1 version-1 upgrade), lint, build (`ƒ /api/fleet`). The 7-call matrix matched, including a
  `status=fault` request that narrowed the list to one robot while the summary stayed at 7, and a
  400 that named the parameter and every allowed status. Decisions: summary after site/q and before
  status, thresholds echoed, sample count by `received_at` on the new index.

- **2026-11-21 — task 4 planned.** Fleet snapshot designed in `.lavish/task-4-plan.html`: one
  query (`robots LEFT JOIN robot_latest` + a 60 s sample count), status derived once per request
  with a single `now`, JS-side filters because status is not a column, and a summary that counts
  after site/q but before status. Adds migration 2 for the `(robot_id, received_at)` index and 13
  gate cases. Three decisions left open: summary scope, echoing thresholds, sample-count clock.

## Gate output (task 4, 2026-11-21)

```
typecheck  0
test       65/65 pass (8 suites) — 12 new fleet cases + 1 migration case
lint       0
build      0   →   ○ /   ○ /_not-found   ƒ /api/fleet   ƒ /api/ingest
```

Seven calls against `next start` on a temp database seeded by `data/seed-task4.ts` — one report per
robot, each backdated to its intended age, then curated metadata:

```
GET /api/fleet                  200  total 7, exactly one robot in each of the seven buckets
GET /api/fleet?site=site-berlin 200  total 3 (moving 1, low_battery 1, delayed 1)
GET /api/fleet?q=TOP            200  RBT-001 only — case-insensitive on the curated name
GET /api/fleet?status=fault     200  robots = [RBT-003], summary still total 7 — the decision holds
GET /api/fleet?status=nope      400  invalid_query {parameter:"status", allowed:[7 statuses]}
GET /api/fleet?site=nowhere     200  total 0, robots [] — an empty result is not an error
GET /api/ingest                 405  automatic method rejection
```

Ages read back as 542 ms / 4 042 ms / 11 042 ms against thresholds of 3 000 / 10 000, so `moving`,
`delayed` and `offline` came from the real clock path rather than pinned fixtures; every robot
reported `samplesLastMinute: 1`. Server stopped, port 3100 closed.

## Known limitations / open questions

- Single-instance SSE hub (in-process); multi-instance would need Redis pub/sub or a DB tail.
- SQLite writer is serialized; fine for tens of robots at 1 Hz, not for 1000s.
- Manager UI has no authentication (ingestion is key-protected).
- Next 16 has `cacheComponents: true` and `partialPrefetching: true` enabled by the scaffold.
  Dynamic pages/route handlers must be written against Next 16 conventions; `AGENTS.md` (shipped
  by the scaffold) says to read `node_modules/next/dist/docs/` before writing app code.
