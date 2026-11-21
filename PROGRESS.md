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
| 5 | `GET /api/robots/:id` | `[x]` | typecheck 0 · 80/80 tests (15 new) · lint 0 · build 0 (`ƒ /api/robots/[id]`) · 25-check curl matrix passed |
| 6 | SSE `/api/stream` | `[x]` | typecheck 0 · 96/96 tests (16 new) · lint 0 · build 0 (`ƒ /api/stream`) · wire matrix: moving → delayed → offline with no writes |
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

## Task 5 plan — one robot in detail

Goal: the read behind the detail screen. Only one of its four statements is a lookup; the rest scan
someone's last N minutes of history, so the work is bounding that window, fixing its resolution, and
deriving events and stats without pulling raw rows into JavaScript. Visual plan:
`.lavish/task-5-plan.html`.

| File | Contents |
|---|---|
| `app/api/robots/[id]/route.ts` | Adapter: `await ctx.params`, `getDb()`, `config.thresholds`, `Date.now()` → `handleRobot`, typed `RouteContext<"/api/robots/[id]">`. No `runtime`/`dynamic` export. |
| `lib/http/robot.ts` | `handleRobot(request, id, { db, thresholds, now })`: resolve the window, read state, bucket, collect events, compute stats, assemble; 404 and 400 branches. |
| `lib/db/telemetry.ts` | `getRobot`, `listBuckets`, `listEvents`, `windowStats` — four prepared statements, all riding `telemetry_robot_received`. |
| `tests/robot.test.ts` | 15 handler cases on a temp database with a pinned `now`; every one runs the real SQL. |

**Response:** `{ generatedAt, window: {requested, ms, bucketMs, from, to}, thresholds, robot,
state, history[], trail[], events[], stats }`. `robot` is metadata with the same `COALESCE` fallbacks
as a fleet row; `state` is the read model plus `status` and clamped `ageMs`; `history` is
`{t, battery, charging, speed}`; `trail` is `{t, x, y}`; `events` are
`{t, kind, detail}` for `fault`, `charge_start`, `comms_gap`.

**Downsampling:** buckets come from the ladder `{0.5s, 1s, 2s, 5s, 10s, 15s, 30s, 1m, 2m, 5m, 10m}`,
taking the smallest that keeps the window at or under 180 points — which lands on exactly the 5 s
PLAN §5 documents for the default 15 m. Buckets are epoch-aligned on `received_at`, so a point keeps
its `t` between polls; each holds `avg(battery)`, `max(speed)`, any-charging, and the mean position.
Empty buckets are omitted rather than zero-filled.

**Events:** edges only, found with `LAG` inside the same range scan — a new or changed `error_code`,
`charging` going false→true, and a gap above `OFFLINE_AFTER_MS` (the same threshold the status ladder
uses). Newest first, capped at 200. A transition with no predecessor row in the window is not
reported; a live fault is still visible in `state.errorCode`.

**Stats:** one statement over raw rows — `count(*)`, `round(avg(battery))`, `distanceM` from `sqrt`
with gap-spanning segments excluded, and `gapCount`. Checked against the installed driver before
planning: SQLite 3.54.1, `sqrt(16)` = 4, `lag()` works.

**Gate:** `npm run typecheck` · `npm test` (80 expected: 65 + 15) · `npm run lint` · `npm run build`
(`ƒ /api/robots/[id]`) · then 7 curl calls on a backdated temp DB: default window, `1h`, `7m` → 400,
blank window, unknown id → 404, `POST` → 405, and two calls a second apart showing `generatedAt` move
while bucket `t` values do not.

**Open decisions (Lavish):** window input (allowlist of six — recommended — vs free-form capped at
24h vs fixed 15m) · bucket rule (ladder ≤180 points — recommended — vs fixed 5 s vs raw rows capped)
· event source (SQL `LAG` — recommended — vs JS reduce vs an events table written at ingest) · window
clock (`received_at` — recommended — vs `device_ts`).

**Built (2026-11-21):** approved as planned and shipped. One fix came out of the gate: SQLite bound
the epoch-millisecond parameters as REAL, so `(received_at / bucketMs) * bucketMs` returned
ungrouped rows — 900 samples became 900 points. Bucket starts are now
`received_at - (received_at % bucketMs)`, which is exact and independent of how a number is bound.
The 15 m worst case is 181 aligned buckets, not 180: the cap bounds intervals, and an inclusive
range on an exact multiple adds the edge bucket.

## Task 6 plan — the live fleet stream

Goal: one SSE connection per screen and a complete fleet snapshot every tick, so the manager never
refreshes and a stopped simulator still turns robots `offline`. Visual plan with the frame protocol,
the lifecycle and four decisions: `.lavish/task-6-plan.html`.

| File | Contents |
|---|---|
| `app/api/stream/route.ts` | Adapter: `getDb()`, `config.thresholds`, `() => Date.now()`, `getFleetHub()`, then `handleStream`. No `runtime`/`dynamic` export; the build must print `ƒ /api/stream`. |
| `lib/http/stream.ts` | `handleStream(request, deps)`: `hello` plus an immediate `fleet`, then one frame per `TICK_MS` (1000); `: ping` every `HEARTBEAT_MS` (15 s); abort clears the timer; a throwing tick emits `event: error` and closes. |
| `lib/stream/hub.ts` | `createFleetHub({ build, tickMs })` — one cached body plus `builtAt`, `invalidate()` — and `getFleetHub()` cached on `globalThis` like `getDb()`. |
| `lib/stream/client.ts` | Framework-free `FleetStream` with injected `EventSource`/`fetch`: `connecting → live → reconnecting → polling`, the same `FleetResponseBody` from both transports. |
| `tests/stream.test.ts` | 16 cases (11 server, 5 client) with an injected clock, timer and temp database. |

**Frame contract:** `retry: 2000` and `event: hello` (`tickMs`, `heartbeatMs`, `thresholds`,
`generatedAt`), then `event: fleet` whose `data` is exactly the `FleetResponseBody` that
`GET /api/fleet` returns for the same clock, with `id:` set to that snapshot's `generatedAt`.
`: ping` when idle; `event: error` then close if a tick throws. Every frame is a full snapshot, so a
lost frame is harmless and the polling fallback is the same body over `fetch`.

**Why the tick cannot be write-driven:** status is `now - receivedAt`, so with no writes only the
clock changes. A publish-on-write stream would never report `offline`, which is PLAN §1's success
criterion.

**Sharing:** one cached snapshot per tick serves every connection; each connection owns one timer and
clears it on abort (no module-level `setInterval`). An accepted ingest calls `hub.invalidate()`
through a new optional `onAccepted` dep on `handleIngest`, wired in the ingest adapter, so a report
shows up in the next frame rather than the one after.

**Gate:** `npm run typecheck` · `npm test` (96 expected: 80 + 16) · `npm run lint` · `npm run build`
(`ƒ /api/stream` in the route table) · then a manual matrix on a backdated seed: `curl -sN` shows
`hello` then `fleet`; 12 s with no writes flips a robot `moving → delayed → offline` across frames; a
POST is visible within one tick; two tabs share a `generatedAt`; `POST /api/stream` → 405.

**Open decisions (Lavish):** frame scope (full unfiltered snapshot — recommended — vs filtered per
connection vs deltas) · hub shape (TTL cache + per-connection timer — recommended — vs shared
`setInterval` vs no hub) · ingest invalidation (`onAccepted` → `invalidate()` — recommended — vs
rely on the TTL) · client scope (plain `FleetStream` now, hook in task 8 — recommended — vs React
hook now vs server only).

**Built (2026-11-21):** approved as planned and shipped with the recommended defaults. New modules:
`app/api/stream/route.ts`, `lib/http/stream.ts`, `lib/stream/hub.ts`, `lib/stream/client.ts` and
`tests/stream.test.ts`; `collectFleet`/`summariseFleet`/`buildFleetSnapshot` extracted from the fleet
handler so the stream and `GET /api/fleet` cannot drift; `onAccepted` added to `handleIngest` and
wired to `getFleetHub().invalidate()` in the ingest adapter. Two notes from the build: the heartbeat
is the guard for a tick configured slower than 15 s, not a normal path — at the default 1 s tick a
frame is always written, and a 13 s capture contained zero `: ping` comments; and the client state
union gained `idle` and `stopped` beyond the four planned states, because “never started” and “torn
down” are both worth reporting to a screen.

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

- **2026-11-21 — task 5 planned.** Robot detail designed in `.lavish/task-5-plan.html`: one state
  read plus three window queries, a six-value window allowlist, ladder buckets that reproduce PLAN's
  5 s at the default 15 m, edge events via `LAG`, and stats computed entirely in SQL. Verified before
  writing: SQLite 3.54.1 has window functions and `sqrt`, and Next 16 route handlers take params as a
  Promise through `RouteContext<\"/api/robots/[id]\">`. Four decisions left open.

- **2026-11-21 — task 5 done.** `GET /api/robots/:id` ships with a six-value window allowlist, a
  bucket ladder (15 m → 5 s, 24 h → 10 m), edge-only events via `LAG`, and window stats in one
  statement. Gate: typecheck 0, 80/80 tests (15 new), lint 0, build 0 with `ƒ /api/robots/[id]`, and
  a 25-check matrix against `next start` — default, 1 h and blank windows, 400 on `7m`, 404 on an
  unknown id, 405 on POST, and bucket starts stable across two polls a second apart.

- **2026-11-21 — task 6 done.** `GET /api/stream` ships: `retry: 2000`, a `hello` frame, then a full
  `FleetResponseBody` per 1 s tick tagged with its `generatedAt` as the event id, plus `event: error`
  and close if a tick throws. The hub caches one snapshot per tick on `globalThis` and ingest
  invalidates it through `onAccepted`, so a report lands on the next frame instead of the one after.
  Gate: typecheck 0, 96/96 tests (16 new: 11 server incl. an abort and the ingest hook, 5 client),
  lint 0, build 0 with `ƒ /api/stream`. Wire matrix on `next start`: hello and fleet frames exactly
  as designed, a POST visible on the following frame, two connections sharing one id sequence, and
  the headline check — a robot seed-posted once then left alone walked moving → delayed → offline
  across 13 frames. Port 3100 closed afterwards.

- **2026-11-21 — task 6 planned.** The live stream is designed in `.lavish/task-6-plan.html`: `hello`
  plus a full `FleetResponseBody` per 1 s tick, a TTL snapshot hub on `globalThis`, one timer per
  connection cleared on abort, `: ping` heartbeats, and a framework-free `FleetStream` client with a
  polling fallback. Checked in the bundled Next 16 docs that a route handler may return a raw
  `ReadableStream` (the streaming guide's own SSE example), that the status code is committed once
  streaming starts, that `X-Accel-Buffering: no` is the documented proxy mitigation, and that
  `connection()` exists for synchronous drivers like `better-sqlite3` if the route is ever prerendered.
  Four decisions left open.

## Gate output (task 6, 2026-11-21)

```
typecheck  0
test       96/96 pass (11 suites) — 16 new: 11 server (frames, hub, abort, ingest invalidation) + 5 client
lint       0
build      0   →   ○ /   ○ /_not-found   ƒ /api/fleet   ƒ /api/ingest   ƒ /api/robots/[id]   ƒ /api/stream
```

Wire matrix against `next start` on port 3100, temp database seeded by `data/seed-task4.ts`:

```
GET /api/stream (headers)       200  content-type: text/event-stream; charset=utf-8
                                    cache-control: no-cache, no-transform
                                    x-accel-buffering: no, connection: keep-alive
first bytes on the wire         retry: 2000 → event: hello (tickMs, heartbeatMs, retryMs,
                                thresholds, generatedAt) → id: <generatedAt> → event: fleet
POST /api/ingest (2 robots)     200  accepted 2 — RBT-LIVE first seen on fleet frame 2
RBT-001 over 13 s, one POST then no further writes:
                                moving (frame 0) → delayed (frame 3) → offline (frame 10)
13 s capture                    13 fleet frames, ids monotonic, no skipped tick, 0 ping comments
two connections opened together identical id sequences — one build per tick serves both
POST /api/stream                405   GET /api/fleet 200 · GET /api/robots/RBT-001 200
                                POST /api/ingest without key 401
```

Server stopped, port 3100 closed.

## Known limitations / open questions

- Single-instance SSE hub (in-process); multi-instance would need Redis pub/sub or a DB tail. Each
  frame is the whole fleet, so bandwidth grows linearly with fleet size — fine at this scale,
  worth revisiting if the fleet reaches the hundreds.
- SQLite writer is serialized; fine for tens of robots at 1 Hz, not for 1000s.
- Manager UI has no authentication (ingestion is key-protected).
- Next 16 has `cacheComponents: true` and `partialPrefetching: true` enabled by the scaffold.
  Dynamic pages/route handlers must be written against Next 16 conventions; `AGENTS.md` (shipped
  by the scaffold) says to read `node_modules/next/dist/docs/` before writing app code.
