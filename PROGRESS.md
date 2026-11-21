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
| 7 | Robot simulator CLI | `[x]` | typecheck 0 · 111/111 tests (15 new) · lint 0 · build 0 · live run: 473/473 accepted, SIGINT exit 0, wrong key exit 1, offline 20 after stop |
| 8 | Fleet overview UI | `[x]` | typecheck 0 · 125/125 tests (14 new) · lint 0 · build 0 (`○ /`) · browser pass: 5 live cards, chip filter, reconnecting badge |
| 9 | Robot detail UI | `[x]` | typecheck 0 · 138/138 tests (13 new) · lint 0 · build 0 (`◐`) · browser: charge band, gap split, window switch, 404 |
| 10 | Resilience pass (retention, seeds, README) | `[x]` | typecheck 0 · 149/149 (11 new) · lint 0 · build 0 · e2e: seeded, 5 live, stale page offline at 12 s, sweep deleted exactly the expired row |
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

## Task 7 plan — the simulator

Goal: the only writer. A separate Node process models N robots at 1 Hz and posts one batch a
second through the real ingest door, so every derived status — `low_battery`, `charging`, `fault`,
`delayed`, `offline` — becomes reachable. Visual plan: `.lavish/task-7-plan.html`.

| File | Contents |
|---|---|
| `simulator/robot.ts` | `createRandom(seed)` (mulberry32), `createFleet`, `advanceRobot(robot, dtSeconds)`, `toReport(robot, ts)`, constants. Imports only the type and `normaliseHeading` from the schema — never the database. |
| `simulator/args.ts` | `parseArgs(argv, env)` → `SimConfig` and `usage()`; flags over `SIM_*` over defaults; returns errors instead of exiting, so the gate can assert them. |
| `simulator/cli.ts` | The only I/O: fixed-grid tick loop, one `fetch` per tick with a 5 s timeout, the per-tick log line, SIGINT summary, exit codes. |
| `tests/simulator.test.ts` | 15 cases: 12 model (determinism, seq, drain, dock, bounds, faults, drops) + 3 args. |

**Model:** waypoint cruising inside ±40 m; battery drains 0.03 %/m travelled (proportional to speed);
below 18 % it returns to the dock at (0,0) and charges at 0.5 %/s to 95 %; random fault episodes
(`E_STUCK`/`E_LIDAR`/`E_WHEEL_SLIP`, 3–8 s) overlay movement; `--drop-rate` omits a report but still
advances `seq`, so loss looks like a seq gap rather than a duplicate.

**Wire mapping:** cruising/returning → `moving`, idle → `idle`, charging → `motion: "charging"` with
`charging: true`, fault → `motion: "error"` with the code. `charging` is never `false` on a charging
report and never `true` while returning.

**Loop:** a grid anchored at start (`sleep until start + n·interval`, not `sleep(interval)`), one
request in flight, a request that overruns its slot skips the next instead of firing back to back.
Logs `t= reports= accepted= dup= rejected= skipped= rtt=`, counts taken from the ingest response.
401/403 → message naming `x-ingest-key` and `exit(1)`; 400/5xx/network → warn and keep ticking;
SIGINT → finish the in-flight request, print the summary, `exit(0)`.

**Config:** `--robots --interval --url --key --seed --drop-rate` with `SIM_ROBOTS`, `SIM_INTERVAL_MS`,
`SIM_URL`, `SIM_SEED`, `SIM_DROP_RATE` and `INGEST_API_KEY` as fallbacks; defaults 20 robots, 1000 ms,
`http://localhost:3000/api/ingest`, seed 42, drop 0.02. New `npm run sim` script.

**Gate:** `npm run typecheck` · `npm test` (111 expected: 96 + 15) · `npm run lint` · `npm run build`
· then the PLAN §9 row 7 matrix: 30 s of 20 robots advancing in the DB with one tick line per second,
`exit=0` on SIGINT, and a wrong key exiting 1 naming the header; finally stopping the simulator and
watching the fleet read `offline` after 11 s.

**Open decisions (Lavish):** home (standalone `simulator/` CLI — recommended — vs in-app route vs
seed script) · model (waypoints + dock + faults — recommended — vs random walk vs scripted scenario)
· loop (fixed grid, skip-not-queue — recommended — vs fire-and-forget interval vs await-then-sleep)
· config (flags over `SIM_*` over defaults — recommended — vs env only vs flags only).

**Built (2026-11-21):** approved as planned and shipped with the recommended defaults. Three
modules under `simulator/`, `tests/simulator.test.ts` and the `npm run sim` script. Two notes from
the build: `advanceRobot` takes an optional `faultRate` so the dock and fault cases pin fault
injection to zero instead of being one-in-five-hundred flaky, while the default keeps PLAN's 0.2 %
per tick; and `speed` is forced to 0 whenever `motion` is not `moving`, so a docked or faulted robot
cannot contradict its own status with a non-zero speed.

## Task 8 plan — the fleet screen

Goal: the first screen. `/` renders every robot from the live stream, worst first, with health chips,
search, a status filter and a sort — plus honest loading, empty and reconnecting states. Visual plan:
`.lavish/task-8-plan.html`.

| File | Contents |
|---|---|
| `app/page.tsx` | Server shell: heading plus `<FleetScreen />`; still a static `○ /` route. |
| `components/fleet/fleet-screen.tsx` | `"use client"`. Filter/sort state, summary, controls, grid, and the three non-data states. |
| `components/fleet/use-fleet-stream.ts` | One `FleetStream`, started on mount and stopped on unmount, exposing `{ snapshot, state, error }`. |
| `components/fleet/fleet-view.ts` | Pure `filterRobots`, `sortRobots`, `statusSeverity`, `formatAge`, `batteryTone` — no React import. |
| `components/fleet/status-pill.tsx` | One status → one pill (colour plus text), shared with task 9. |
| `components/fleet/robot-card.tsx` | Pill, name/id, site/model, battery bar, motion/speed or fault, position, age, seq; the card is one link. |
| `tests/fleet-view.test.ts` | 12 cases over the pure module. |
| `app/globals.css` | Status colour tokens (`ok`, `warn`, `bad`, `violet`) beside the existing palette. |

**Boundary:** the frame is the single source. `status`, `summary` and `thresholds` are read, never
recomputed in the browser; filtering and sorting are pure functions over the snapshot already in
memory, so a chip click costs no request and the chips cannot disagree with the cards. The chips show
the server's unfiltered counts (the stream is unfiltered, unlike `GET /api/fleet?status=`, which
recounts after `site`/`q`).

**Severity order** (default sort): `offline → fault → low_battery → delayed → charging → moving →
idle`, ties by battery ascending then id, so the order is total and stable. Other sorts: battery
ascending, id ascending. No mutation of the snapshot.

**Age** is computed locally from `receivedAt` against a 1 s clock rather than the payload's frozen
`ageMs`, so a stalled socket shows ageing cards and the badge says `reconnecting` instead of a screen
that looks alive.

**States:** no frame yet → skeleton cards; `total 0` → empty panel naming `npm run sim`; robots but
no matches → “No robots match” plus clear; `reconnecting`/`polling` → amber badge, cards retained.

**Gate:** `npm run typecheck` · `npm test` (123 expected: 111 + 12) · `npm run lint` · `npm run build`
(`○ /` still static) · then a manual pass: cards within a second of the simulator starting, filters
instant, badge on server stop/restart, offline cards after 11 s, empty fleet, keyboard toggling of
chips.

**Open decisions (Lavish):** data path (hook over `FleetStream` — recommended — vs inline
`EventSource` vs polling only) · filtering (client-side over the snapshot — recommended — vs refetch
with query params vs filtering in the stream) · filter state (local component state — recommended —
vs URL search params vs shared store) · test scope (pure logic + manual pass — recommended — vs
jsdom + Testing Library vs manual only).

## Task 9 plan — the robot detail screen

Goal: `/robots/[id]` answers “what has this robot been doing, and is anything about it a problem” —
header + pill, KPI row, hand-rolled battery chart with a window switch, trail map, window stats and
the event log. The payload from task 5 already contains all of it. Visual plan:
`.lavish/task-9-plan.html`.

| File | Contents |
|---|---|
| `app/robots/[id]/page.tsx` | Server shell: `await params` (`PageProps<"/robots/[id]">`), render the client screen. Route becomes `ƒ`. |
| `components/detail/robot-detail-screen.tsx` | `"use client"`: window state, layout, KPI row, charts, events, loading / 404 / stale states. |
| `components/detail/use-robot-detail.ts` | Fetch `/api/robots/{id}?window=`, poll every 5 s, abort on window change and unmount, keep the last payload on failure. |
| `components/detail/detail-view.ts` | Pure: `linearScale`, `batterySegments`, `chargeSpans`, `trailProjection`, `formatDistance`, `formatClock`, `eventLabel`, `WINDOW_CHOICES`. |
| `components/detail/battery-chart.tsx` | Area + line, `lowBatteryPct` threshold, charge bands, gap-split segments, from/to labels, empty-window placeholder. |
| `components/detail/trail-map.tsx` | Site grid, trail split at gaps, current dot and heading arrow, metre scale. |
| `components/detail/event-log.tsx` | Newest-first fault / charge_start / comms_gap rows with detail, plus empty state. |
| `tests/detail-view.test.ts` | 13 cases over the pure module. |
| `data/seed-task9.ts` | Gitignored gate fixture: 15 min of backdated history with a charge window, a fault burst and a 20 s gap. |

**Data path:** poll the detail endpoint every 5 s (one payload: state, history, trail, events, stats,
applied window). The stream has no history, so a hybrid would put two clocks on one screen. Abort in
flight requests on window change and unmount, and ignore a response whose `window.requested` no
longer matches the selection.

**Charts:** hand-rolled SVG over the echoed window. Segments break where the gap exceeds
`thresholds.offlineAfterMs` — the same rule stats use — so a 20 s silence is a hole, not a straight
line; the trail splits the same way. Charge bands come from contiguous `charging` buckets. Bounds for
the trail are padded and enforced to at least 20 m so a stationary robot does not fill the map. One
point is a dot, zero points a dashed placeholder; every scale guards a zero-span domain.

**Windows:** `5m`, `15m`, `1h` as local state, default `15m`; ages computed locally from
`state.receivedAt`; poll skipped while the tab is hidden; a failed refresh keeps the last payload and
shows its age; 404 renders an in-screen “Robot not found” with the id and a link back.

**Gate:** `npm run typecheck` · `npm test` (138 expected: 125 + 13) · `npm run lint` · `npm run build`
(`ƒ /robots/[id]`) · then the manual pass on `data/seed-task9.ts`: chart climbing inside the charge
band, a visible break across the gap, threshold line at `LOW_BATTERY_PCT`, window switching, a live
detail tab against the simulator, and the 404 and empty-window states.

**Open decisions (Lavish):** data path (5 s poll — recommended — vs fetch once vs stream + slow
history) · windows (three PLAN names as local state — recommended — vs all six vs three in the URL)
· fixture (seeded `data/seed-task9.ts` — recommended — vs real time vs simulator at 10×) · 404
(in-screen state — recommended — vs server `notFound()` vs redirect).

**Built (2026-11-21):** approved and shipped with the recommended defaults, one structural change.
Reading `params` on the server put the route behind a Cache Components Suspense hole that reflushed
the document on every request in development, so the id is read with `useParams` on the client and
the page is a static shell (`◐ /robots/[id]`) whose fallback is the screen's own skeleton. The same
rule then required a Suspense boundary around the screen, which the page provides. Two fixes the
build found: `stats.avgBattery` is nullable when a window has no reports, and the charts split into
two columns at `lg` rather than `xl`, where the trail map was taller than the viewport.

## Task 10 plan — resilience pass

Goal: PLAN §9 row 10. Four gaps found in the code: `RETENTION_HOURS` is parsed but nothing deletes
(`.env.example` already promises a sweep), the fleet screen's clock only ages labels while statuses
stay frozen at the last frame, demo metadata lives only in gitignored `data/seed-*.ts` files, and the
README is create-next-app boilerplate. Visual plan with both flow diagrams and four decisions:
`.lavish/task-10-plan.html`.

| File | Change |
|---|---|
| `lib/db/schema.ts` | Migration 3: `telemetry_received` index for a global `received_at` cutoff delete. |
| `lib/db/retention.ts` | `sweepTelemetry`, a 60 s-throttled `createRetentionSweeper`, and `getRetentionSweeper()` on `globalThis`. |
| `app/api/ingest/route.ts` | `onAccepted` invalidates the hub, then runs the sweeper. |
| `lib/db/telemetry.ts` | `upsertRobotMetadata` for the seed (updates name/site/model, preserves `created_at`). |
| `scripts/seed.ts` | `npm run seed`: 20 curated robots matching the simulator ids; `--robots`, `--help`. |
| `components/fleet/fleet-view.ts` | `refreshStatuses` / `summariseStatuses` reusing `deriveStatus`; chips recount locally. |
| `components/fleet/fleet-screen.tsx` | Cards, chips, filter and sort read the refreshed robots. |
| `components/detail/robot-detail-screen.tsx` | Pill re-derived from the payload's receive time and the local clock. |
| `tests/retention.test.ts`, `tests/seed.test.ts`, `tests/fleet-view.test.ts` | 5 + 2 + 3 cases. |
| `README.md` | Real quick start, scripts, env, API map, retention semantics, limitations. |

**Sweep rules:** `cutoff = now − retentionHours·3 600 000`; delete `received_at < cutoff` (strict),
leave `robot_latest` and `robots` untouched, return the count and log it when non-zero. Throttled to
one run per 60 s, triggered only by an accepted batch. History ages out; the fleet's last-known
state does not.

**Staleness rule:** the browser runs the server's own `deriveStatus` over each robot with the local
clock and the frame's thresholds, so a dead socket walks `moving → delayed → offline` on schedule
and chip counts stay honest. Detail does the same for its pill.

**Gate:** typecheck 0 · test 148/148 (10 new) · lint 0 · build 0 (routes unchanged) · e2e on a fresh
DB: `npm run seed` → 20 curated robots, simulator 5 robots visible in fleet and detail, stop the
simulator (and then the server) → cards reach `offline` within 11 s from the stale frame + local
clock, retention probe with `RETENTION_HOURS=0.001` deletes only the backdated row, README followed
verbatim.

**Open decisions (Lavish):** sweep trigger (on ingest throttled 60 s — recommended — vs interval
timer vs read path) · stale status (re-derive all locally and recount chips — recommended — vs
escalate to offline on cards only vs leave frozen) · seed scope (metadata only, idempotent —
recommended — vs + backdated history vs destructive `--reset`) · retention vs the 24 h window (keep
24 h and document partial windows — recommended — vs clamp the window list vs raise to 7 days).

**Built (2026-11-21):** approved and shipped with the recommended defaults. Migration 3 adds
`telemetry_received`; `lib/db/retention.ts` owns the strict cutoff delete and the 60 s throttle and
is called from the ingest adapter's `onAccepted`; `upsertRobotMetadata` plus `scripts/seed.ts` give
`npm run seed`; both screens re-derive `status` with `deriveStatus` on their own clock and the fleet
chips are recounted from the refreshed list. Two notes from the build: the seed suite covers
metadata, idempotency and argument parsing in three cases, so the real count is 149 (138 + 11), not
the planned 148; and the first retention probe posted a bare JSON array, which the ingest contract
correctly rejected with 400 `invalid_body` — the endpoint takes one report object or
`{ reports: [...] }`, never an array.

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

- **2026-11-21 — task 7 planned.** The simulator is designed in `.lavish/task-7-plan.html` as a
  standalone `simulator/` CLI (`robot.ts` pure model, `args.ts`, `cli.ts`) that posts one batch per
  second through the real ingest endpoint. Every derived status becomes reachable: waypoint cruising,
  distance-proportional drain, a dock cycle at 18 %/95 %, fault episodes, and a drop rate that leaves
  seq gaps. The tick loop is a fixed grid anchored at start with one request in flight, skipping a
  slot rather than bursting after a slow response; 401 exits 1. Four decisions left open.

- **2026-11-21 — task 7 done.** The simulator ships as `simulator/robot.ts` (pure seeded model),
  `simulator/args.ts` and `simulator/cli.ts`, with `npm run sim`. Gate: typecheck 0, 111/111 tests
  (15 new), lint 0, build 0. Live run of 20 robots at 1 Hz against `next start`: 24 ticks, 473
  reports, 473 accepted, 7 dropped by the 2 % drop rate, 0 duplicates, 0 rejected; `SIGINT` printed
  the summary and exited 0; a wrong key exited 1 naming `x-ingest-key`; and stopping the writer left
  the fleet reading `offline 20` after 11 s. Port 3100 closed afterwards.

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

- **2026-11-21 — task 8 planned.** The fleet screen is designed in `.lavish/task-8-plan.html`: `/`
  becomes a client screen fed by one `FleetStream` connection, with health chips, search, status
  filter and severity sort computed client-side over the unfiltered snapshot. Status, summary and
  thresholds stay server-derived; age is computed locally so a stalled socket ages instead of
  freezing.

- **2026-11-21 — task 8 done.** The fleet screen ships at `/`: one `FleetStream` connection, health
  chips that double as the status filter, search, severity/battery/id sort, cards with battery bars
  and locally computed ages, plus skeleton, empty, no-match and reconnecting states. Gate: typecheck
  0, 125/125 tests (14 new), lint 0, build 0 with `/` still `○`, and a browser pass that filtered to
  the zero-count fault chip, cleared it from the empty state, and watched the badge turn
  `reconnecting` when the server stopped. That pass also found a task 7 bug — a restarted simulator
  replayed `seq` from 0, so every report was a duplicate against an existing database — now fixed
  with a startup `seqBase` and a regression test. Four decisions left open.

**Built (2026-11-21):** approved as planned and shipped with the recommended defaults. Six modules
under `components/fleet/` plus `tests/fleet-view.test.ts`; `/` stays a static shell. Two notes from
the build: Next 16 blocks `Date.now()` while prerendering a client component
(`blocking-prerender-current-time-client`), so the screen's clock starts `null`, dates the first
paint from the frame's `generatedAt`, and only reads the wall clock on the interval; and the manual
pass caught a task 7 defect — a restarted simulator replayed `seq` from 0, so every report was a
duplicate and the fleet went stale while the CLI looked healthy. `createFleet` now takes a `seqBase`
and the CLI passes its start time, with a regression test.

## Gate output (task 7, 2026-11-21)

```
typecheck  0
test       111/111 pass (13 suites) — 15 new: 12 model + 3 argument cases
lint       0
build      0   →   ƒ /api/fleet · ƒ /api/ingest · ƒ /api/robots/[id] · ƒ /api/stream
```

`npm run sim -- --help` exits 0 with the usage block; `--robots 0` and `--nope` exit 1 naming the
flag. Live matrix against `next start -p 3100` on a fresh database, 20 robots at 1 Hz:

```
fleet at 8 s             total 20, moving 20; RBT-001 battery 69, name RBT-001,
                         site unassigned, seq 7, samplesLastMinute 7
stream, 3 s              3 fleet frames; RBT-001 69 % @3.01,4.2 → 68.9 % @1.86,4.44 → 68.9 % @0.83,4.65
tick log                 t=23 reports=19 accepted=19 dup=0 rejected=0 skipped=0 rtt=11ms
SIGINT                   exit 0 · stopped after 24 ticks · 473 reports · 473 accepted ·
                         0 duplicates · 0 rejected · 7 dropped · 0 failed · 0 skipped · 23.0 s
wrong key                401 naming x-ingest-key, exit 1 after one tick
writer stopped, +11 s    total 20, offline 20, moving 0   ← PLAN §1 success criterion
```

Server stopped, port 3100 closed. Twenty-four ticks is deliberately too short to reach the dock
cycle (drain is ~0.03 %/m from a 55–95 % start) or a fault episode (0.2 %/tick); those paths are
covered by the deterministic gate cases rather than by this run.

- **2026-11-21 — task 9 done.** `/robots/[id]` is live: KPI row, battery chart with charge bands and
  gap-split segments, trail map with a heading arrow, window stats and the event log, polled every
  5 s from `GET /api/robots/:id`. Gate: typecheck 0, 138/138 tests (13 new), lint 0, build 0 with
  `◐ /robots/[id]`, and a browser pass on the seeded fixture that showed two chart segments at the
  20 s gap, one charge band crossing the 20 % line, two trail runs, the 1h switch fetching a new
  window, and a 404 rendering “Robot not found” with the id and a way back.

- **2026-11-21 — task 9 planned.** The detail screen is designed in `.lavish/task-9-plan.html`:
  `/robots/[id]` polls `GET /api/robots/:id` every 5 s and draws the one payload it gets — KPI row,
  battery chart with charge bands and gap-split segments, trail map with a heading arrow, window
  stats and the event log. Only 5m/15m/1h are offered, ages are computed locally, and a 404 renders
  an in-screen not-found state. A gitignored `data/seed-task9.ts` makes charge periods and comms gaps
  demonstrable without waiting 15 minutes. Four decisions left open.

- **2026-11-21 — task 10 planned.** The resilience pass is designed in `.lavish/task-10-plan.html`:
  a 60 s-throttled retention sweep on accepted ingest (with migration 3 for a global `received_at`
  index), local re-derivation of statuses so a dead socket still reaches `offline`, an idempotent
  `npm run seed` for 20 curated robots, and a real README. Gate: 148 tests and an end-to-end run on
  a fresh database. Four decisions left open.

- **2026-11-21 — task 10 done.** Retention is real (migration 3, strict-cutoff delete, 60 s throttle
  on accepted ingest), `robot_latest` and `robots` survive it, both screens re-derive status from the
  local clock so a dead socket reaches `offline`, `npm run seed` curates 20 robots idempotently, and
  the README documents the actual system. Gate: typecheck 0, 149/149 tests (11 new), lint 0, build 0,
  and an end-to-end run on a fresh DB where killing the server under an open page still flipped all
  five cards to `offline` at 12 s.

## Gate output (task 8, 2026-11-21)

```
typecheck  0
test       125/125 pass (16 suites) — 14 new: 13 view-logic cases + 1 simulator seq-base regression
lint       0
build      0   →   ○ /   ○ /_not-found   ƒ /api/fleet   ƒ /api/ingest   ƒ /api/robots/[id]   ƒ /api/stream
```

Browser pass (Chrome via `chrome-devtools-axi`) against `npm run dev` and `npm run sim -- --robots 5`:

```
page                     5 cards, “5 robots · updated just now”, badge “live · 1 s”
chips                    5 all (pressed) · 0 offline · 0 fault · 0 low battery · 0 delayed ·
                         0 charging · 4 moving · 1 idle
battery bar              RBT-002 fill 344 px of a 536 px track at 64.1 % — the width is data-driven
chip “fault” (count 0)   “No robots match” + “Clear filters”, 0 cards
clear filters            5 cards, “5 all” pressed again
stop server + simulator  badge “reconnecting”, 5 cards retained
```

After the seq fix, a simulator restart on the same database logged `reports=5 accepted=5 dup=0` on
every tick with `seq` 1795291789440. Server, simulator and browser stopped; port 3000 closed.

## Gate output (task 9, 2026-11-21)

```
typecheck  0
test       138/138 pass (21 suites) — 13 new view-logic cases
lint       0
build      0   →   ○ /   ○ /_not-found   ◐ /robots/[id]   ƒ /api/fleet   ƒ /api/ingest   ƒ /api/robots/[id]   ƒ /api/stream
```

Browser pass (Chrome via `chrome-devtools-axi`) on `data/seed-task9.ts` — 900 backdated reports,
one charge period, one fault burst, one 20 s silence:

```
15m window, 172 buckets   2 battery paths (gap split) · 1 charge band · “20 %” threshold line
trail                     2 polylines + heading arrow · “10 m grid · 90° E · 1 gap”
stats                     158 m · 52 % avg · 687 reports · 1 gap
events                    comms gap “no reports for 21.0s” · fault E_STUCK · charging started
KPIs                      69 %, 0.6 m/s, 90° E, sequence 881, error none
window switch             1h → pressed=1h, “Battery · last 1 hour”, 20:37–21:37
404                       /robots/NOPE → “Robot not found”, id shown, “Back to the fleet”
layout                    charts split 760 px / 380 px at 1216 px wide
```

A note for the next manual pass: `next build` must not run while `next dev` is serving. Rewriting
`.next` under a live dev server left the page reloading itself; production (`next start`) was fine
throughout.

## Gate output (task 10, 2026-11-21)

```
typecheck  0
test       149/149 pass (23 suites) — 11 new: 5 retention · 3 seed · 3 status freshness
lint       0
build      0   →   ○ /   ○ /_not-found   ◐ /robots/[id]   ƒ /api/fleet   ƒ /api/ingest   ƒ /api/robots/[id]   ƒ /api/stream
```

End-to-end on a fresh `data/task10.db`, 5 simulated robots at 1 Hz:

```
seed                        20 robots upserted, database=./data/task10.db
GET /api/fleet              total 5, moving 5; RBT-001 = Atlas 01 · site-berlin · TL-2
GET /api/robots/RBT-001     2 points, 2 trail rows, 0 events at 7 s; window 15m
browser                     5 cards; chips 5 all · 5 moving · badge “live · 1 s”
server killed, page open    +12 s → chips 5 offline / 0 moving, every card “offline”,
                            badge “reconnecting”, “updated 12s ago”
retention probe             RETENTION_HOURS=0.001 on a scratch DB:
  before                    telemetry has RBT-SWEEP seq 0, received 60 s ago
  POST one fresh report     200, accepted 1
  after                     telemetry holds only seq 1; robot_latest holds seq 1 —
                            expired history deleted, read model kept
```

Servers, simulator and browser stopped; ports 3100/3101 closed. The sweeper logs
`retention deleted=… cutoff=… ms=…` only when a run deletes something, so a quiet sweep leaves no
noise.

## Known limitations / open questions

- Single-instance SSE hub (in-process); multi-instance would need Redis pub/sub or a DB tail. Each
  frame is the whole fleet, so bandwidth grows linearly with fleet size — fine at this scale,
  worth revisiting if the fleet reaches the hundreds.
- The simulator reads flags and exported environment variables only; it does not load `.env.local`,
  so a non-default `INGEST_API_KEY` has to be exported or passed with `--key`.
- SQLite writer is serialized; fine for tens of robots at 1 Hz, not for 1000s.
- Manager UI has no authentication (ingestion is key-protected).
- Next 16 has `cacheComponents: true` and `partialPrefetching: true` enabled by the scaffold.
  Dynamic pages/route handlers must be written against Next 16 conventions; `AGENTS.md` (shipped
  by the scaffold) says to read `node_modules/next/dist/docs/` before writing app code.
- Retention deletes rows but does not shrink the SQLite file; no automatic VACUUM. Remove
  `data/fleet.db*` for a clean slate.
- The fleet and detail screens re-derive status against the **browser** clock. A badly skewed client
  clock will age robots faster or slower than the server's own view; the server payload's status is
  only used until the first tick.
