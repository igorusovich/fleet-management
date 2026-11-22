# Fleet Ops

Fleet visibility for warehouse robots: a simulator posts telemetry, a Next.js
server validates, stores and derives operational status, and a live React UI
shows the fleet and any single robot in detail.

```
simulator (Node CLI, ~1 Hz)  ──POST /api/ingest──▶  SQLite (telemetry + read model)
                                                        │
browser ◀── SSE /api/stream, fetch /api/robots/:id ──────┘
```

- **Simulator** — 20 robots by default, waypoint movement, distance-based battery
  drain, dock charging, fault episodes and a configurable drop rate.
- **Server** — zod validation, API-key auth, idempotent batches, a seq-guarded
  read model, derived status, bucketed history and a 1 Hz SSE stream.
- **UI** — fleet overview at `/`, robot detail at `/robots/[id]`, both responsive
  and dark.

## Quick start

Requires Node 22+.

```bash
npm install
cp .env.example .env.local     # optional: defaults work as-is
npm run seed                   # curate names, sites and models for RBT-001…020
npm run dev                    # http://localhost:3000
```

In a second terminal:

```bash
npm run sim -- --robots 5
```

Robots appear in the fleet within a second; open one for battery history, trail,
events and window stats. Stop the simulator and the fleet flips to `offline`
within 11 s without a refresh.

Seeding is metadata only. A curated robot has no telemetry until the simulator
posts, and the fleet list is built from the read model, so `/` on a fresh
database stays empty until then — that is expected, not a broken seed.

For forced states, direct API checks and a cold start, see
[How to test manually](#how-to-test-manually).

## What I chose to build, and why

The brief asks for three things: a producer, a server, and a UI for the fleet
plus one robot in detail. I built the smallest complete vertical slice of all
three — something that can be run, stopped, broken and inspected end to end —
rather than a broad mock of a fleet product.

| Decision | What I built | Why |
|---|---|---|
| Storage | SQLite via `better-sqlite3`, WAL, `telemetry` + `robot_latest` | A demo should not need a database server, but it should survive a restart. The repository keeps Postgres a swap rather than a rewrite. |
| Ingest | Batched HTTP `POST`, one request per tick | Matches how a site gateway would report; 20 robots cost one request per second, not 20. `curl` becomes the whole test harness. |
| Truth | Status derived at read time from `received_at` and an injected clock | No background job can fall behind, and stopping the simulator flips robots offline with zero writes — the success criterion. Stored status would freeze. |
| Read model | `robot_latest` upserted beside append-only `telemetry` | The fleet view is the hot read; one indexed row per robot beats a `MAX(ts)` group-by, while history stays intact for charts. |
| Live updates | SSE with a full snapshot every second, plus a 5 s polling fallback | Updates are one-way, so a WebSocket buys nothing. A full frame makes a lost frame harmless, and the fallback reuses the identical payload. |
| History | Downsampled in SQL to at most ~180 buckets per window | Response size stays flat whether the window holds 60 rows or 86,400, and chart points do not jitter between polls. |
| UI | Static server shells, client screens, hand-rolled SVG | `/` and `/robots/[id]` are static shells (the detail route partially prerendered); data arrives from the APIs. Hand-rolled SVG keeps a chart dependency out of the bundle. |
| Simulator | Separate Node process, deterministic per-robot RNG | It exercises the real network and auth boundary and can point at any deployment. A seed replays the same fleet. |
| Contract | One zod schema in `lib/telemetry/schema.ts` | Simulator, API and tests cannot drift, and validation errors carry field paths. |
| Tests | `node:test` with `tsx`, no test framework | The runtime runner covers pure functions and request handlers; temp SQLite files make the database cases real. |

The layering is what makes that testable: `lib/telemetry` is I/O-free, `lib/db`
owns every SQL statement, `lib/http` is a set of plain `Request → Response`
functions with no `next/*` import, the route handlers are thin adapters, and the
simulator imports only the wire contract. The unit gates run without a browser, a
dev server or a real clock.

## What's faked or left out, and why that was the right trade

These are deliberate omissions, not oversights. In each case the missing piece
would have added surface without changing the decisions the brief actually asks
about.

- **The robots are fiction.** Waypoint cruising inside ±40 m, drain of
  0.03 %/m, dock at 18 %, charge at 0.5 %/s to 95 %, random 3–8 s fault
  episodes. The model is tuned to make every status reachable — `moving`,
  `idle`, `charging`, `low_battery`, `fault`, `delayed`, `offline` — not to be
  physically accurate. A real fleet adds device identity, a message broker and
  clock skew, but none of that changes how the server stores a report or how a
  manager reads it. The simulator sits behind the real HTTP and auth contract,
  so replacing it is a producer change, not a server change.
- **No dispatch, alerting or analytics.** The brief is fleet *visibility*:
  what is the fleet doing now, and what has one robot been doing. Task
  assignment needs a work queue and conflict handling; alerting needs
  ownership, escalation and a delivery channel; analytics needs a warehouse.
  Adding any of them would have doubled the scope without making the fleet view
  truer.
- **One shared ingest key; reads are open.** This is a single-tenant demo, so
  per-device credentials and manager SSO would be ceremony. The key still
  exercises a real auth boundary — constant-time comparison, a 401 before the
  body is parsed — and the read APIs stay simple enough to `curl`.
- **One process, one SQLite file.** The SSE hub and the database handle are
  process-local; there is no Redis, NATS or Postgres. At tens of robots and
  1 Hz, fanout is a cache lookup and writes are a few rows a second. A broker
  would be production-shaped but would not change a read, a payload or a screen.
- **Retention is shallow, and the read model is permanent.** Only `telemetry`
  is swept. `robot_latest` and `robots` are the fleet's memory of what exists
  and where it was last seen, so a robot silent for a week still appears —
  offline, with no history to chart. Deleting that row would make a quiet robot
  vanish instead of reading as offline, which is the opposite of what a manager
  needs.
- **The fleet streams; the detail screen polls.** The stream has no history. A
  detail screen fed by both would show a live pill over a chart fetched at a
  different instant — two clocks on one screen. One 5 s request carries state,
  history, trail, events, stats and the applied window, so they cannot disagree.
- **Device time is stored but not trusted.** `ts` is validated and kept for
  history, but status and windowing use the server's `received_at`. A robot with
  a fast clock cannot look alive forever, and a slow one still appears where the
  server saw it. Clock-skew detection is a production concern.
- **The charts and tests stop at the logic.** The SVG charts do not justify a
  chart library, and the pure geometry plus the HTTP handlers are covered by
  `node:test`. React rendering and the live socket are checked by hand; a
  browser test is the next test to add, not the first one.
- **No CI, Docker or deploy config.** The gate is four commands that are
  documented and were run at the end. Running them in CI is a workflow file,
  not architecture, and leaving it out keeps the repo runnable with
  `npm install` alone.

## What I'd do differently with more time, or in production

### With more time

- **Put the gate in CI from task 0.** `lint`, `typecheck`, `build` and `test`
  are a convention right now; a GitHub Actions workflow would make "verified"
  automatic and stop a regression from reaching `main`.
- **Add one Playwright smoke test.** Load `/`, start a two-robot simulator,
  assert a card and a chart, kill the stream and assert the badge reconnects. It
  would have caught the task-9 Suspense reflush and the task-6 stale-frame cases
  without manual clicking.
- **Put filter and window state in the URL.** A manager should be able to send
  "look at RBT-004 on the 1 h window" as a link, and a reload should preserve
  the view.
- **Load-test the documented ceiling.** 200 robots at 1 Hz is the configured
  maximum; measuring ingest latency and SSE fanout there would replace "tens of
  robots" with a number.
- **Test clock skew explicitly.** A device an hour ahead is the case most likely
  to break freshness logic, and it is cheap to simulate with a forged `ts`.

### In production

- **Move to Postgres (or a time-series store) behind the same repository.**
  Partition `telemetry` by day and drop partitions instead of issuing `DELETE`,
  and leave SQLite's lingering high-water mark behind with the move.
- **Replace the shared key with device identity.** Per-device credentials,
  rotation, revocation, and replay protection beyond `(robotId, seq)` — a
  reflashed robot can reuse a sequence, so a boot id belongs in the key.
- **Add manager authentication and tenant scoping.** Every read API is open
  today; production needs SSO, site-level authorisation and an audit trail for
  who looked at what.
- **Fan out SSE through shared pub/sub.** One server instance cannot serve every
  screen indefinitely, and a restart drops them all. Add per-instance
  subscriptions and a graceful shutdown that drains connections.
- **Make writes asynchronous and observable.** `better-sqlite3` is synchronous
  and blocks the event loop; a worker or queue plus `503` with `Retry-After`
  under saturation is the production shape. Add structured logs with request
  ids, ingest latency, accepted/duplicate/rejected counts, SSE client count and
  a `/api/health` endpoint.
- **Treat time as a first-class problem.** Keep server time for freshness, use
  device time for charts with skew correction, and alert when a device clock
  drifts.
- **Give retention a lifecycle.** Raw rows, rolled-up history, then deletion,
  with compaction and a documented window longer than the UI's 24 h cap.

## How to test manually

There is no separate harness: the system is designed to be driven by hand with a
dev server, the simulator and `curl`. These are the same paths the final gate
exercised.

### 1. Run the loop

```bash
npm run seed        # once, or after removing data/fleet.db*
npm run dev         # http://localhost:3000
```

In a second terminal:

```bash
npm run sim -- --robots 5
```

Then check:

- **`/`** — cards appear within a second, the badge reads `live · 1 s`, and the
  status chips, search and sort all work over the live snapshot.
- **Click a card** — detail shows battery chart, trail, events and stats. Switch
  `5m / 15m / 1h`; the header and chart rescale and the payload's window changes.
- **Ctrl-C the simulator** — after ~3 s cards read `delayed`, after ~10 s
  `offline`, with no refresh. Restart it and they return as `moving`, with
  sequence numbers continuing rather than replaying.

### 2. Force a state with two reports

A single report creates a robot, but events are edges: a fault or charge event
needs a previous report in the window to transition from.

```bash
post() {
  curl -s -X POST localhost:3000/api/ingest \
    -H 'content-type: application/json' \
    -H 'x-ingest-key: dev-ingest-key' \
    -d "$1"; echo
}

now=$(date +%s000)

# RBT-900: healthy, then a fault with a low battery.
post "{\"robotId\":\"RBT-900\",\"seq\":1,\"ts\":$now,\"battery\":60,\"charging\":false,\"motion\":\"idle\",\"x\":-12,\"y\":6,\"heading\":91,\"speed\":0,\"errorCode\":null}"
post "{\"robotId\":\"RBT-900\",\"seq\":2,\"ts\":$now,\"battery\":15,\"charging\":false,\"motion\":\"error\",\"x\":-12.4,\"y\":6.2,\"heading\":95,\"speed\":0,\"errorCode\":\"E_STUCK\"}"

# RBT-901: healthy, then docked and charging.
post "{\"robotId\":\"RBT-901\",\"seq\":1,\"ts\":$now,\"battery\":60,\"charging\":false,\"motion\":\"idle\",\"x\":0,\"y\":0,\"heading\":0,\"speed\":0,\"errorCode\":null}"
post "{\"robotId\":\"RBT-901\",\"seq\":2,\"ts\":$now,\"battery\":19,\"charging\":true,\"motion\":\"charging\",\"x\":0,\"y\":0,\"heading\":0,\"speed\":0,\"errorCode\":null}"
```

Open `/robots/RBT-900` and `/robots/RBT-901`. The first shows `fault` with the
error code (fault outranks low battery); the second shows `charging`, a shaded
charge band and a `Charging started` event. Drop `errorCode` and use
`motion: "moving"` on RBT-900 to see `low_battery` instead.

These are one-shot reports: after 10 s they read `offline`. For a static UI
session, raise the thresholds when starting the server:

```bash
DELAYED_AFTER_MS=300000 OFFLINE_AFTER_MS=600000 npm run dev
```

If your `.env.local` sets a different `INGEST_API_KEY`, use that value in the
header or pass the same `INGEST_API_KEY` to both the server and the simulator.

### 3. Exercise a comms gap

Stop the simulator for about 15 s, then restart it. Open a robot: the event log
shows a `comms_gap`, and the battery chart and trail break across the silence
instead of drawing a straight line through it. `--drop-rate` creates the same
kind of loss, but a gap needs several consecutive drops, so stopping is the
reliable recipe.

### 4. Check the API directly

```bash
curl -s localhost:3000/api/fleet | jq '.summary, (.robots[0] | {id,status,ageMs,samplesLastMinute})'
curl -s 'localhost:3000/api/fleet?site=site-berlin&status=moving' | jq '.summary, [.robots[].id]'
curl -s 'localhost:3000/api/robots/RBT-001?window=5m' | jq '{window, status: .state.status, points: (.history|length), events: (.events|length), stats}'
curl -sN localhost:3000/api/stream        # retry: 2000, hello, then a fleet frame per second
```

`jq` is optional; the raw JSON is readable enough. `-N` stops `curl` buffering
the stream.

| Request | Expected |
|---|---|
| ingest with no key or a wrong key | `401` `unauthorized` |
| `{"reports":"nope"}` | `400` `invalid_body` |
| `{"reports":[]}` | `400` `empty_batch` |
| a batch where every report is invalid | `400` `invalid_reports`, with per-index reasons |
| the same `robotId` + `seq` twice | `200`, `duplicates` increments, fleet unchanged |
| `GET /api/robots/RBT-999` | `404` `robot_not_found` |
| `GET /api/robots/RBT-001?window=2m` | `400` `invalid_query` |
| `GET /api/ingest` | `405` |
| more than 512 KiB of JSON | `413` `payload_too_large` |

The 500-report cap is covered by `tests/ingest.test.ts`; building 501 reports
with `curl` is not worth it.

### 5. Cold start and production build

Use a separate database so a demo does not inherit old rows:

```bash
rm -f data/manual.db*
DATABASE_PATH=./data/manual.db npm run seed
DATABASE_PATH=./data/manual.db npm run dev
```

Then point the simulator at the same key (the default is `dev-ingest-key`; add
`--key` if `.env.local` overrides it), and at port 3100 for a production build:

```bash
npm run build                 # stop the dev server first
npm run start -- -p 3100
npm run sim -- --robots 3 --url http://localhost:3100/api/ingest
```

Explicit `DATABASE_PATH` matters because Next loads `.env.local`; a bare
`npm run dev` would otherwise use the tree's database.

### 6. Automated checks

The full gate, in the order the tasks used:

```bash
npm run lint && npm run typecheck && npm run build && npm test
```

For a change to one layer, the focused suite is faster:

```bash
node --import tsx --test tests/ingest.test.ts     # or telemetry, robot, db, stream…
```

## UI behaviour

- **`/`** is a static shell that opens one SSE connection. Cards re-derive
  status from `receivedAt` every second with the server's own rule, so a stalled
  socket ages cards and chip counts honestly. Search, status filter and sort are
  client-side over the current snapshot; chip counts describe the whole fleet.
- **`/robots/[id]`** is a static shell with a skeleton fallback. It polls
  `/api/robots/:id` every 5 s, pauses while the tab is hidden, and keeps the
  last payload (with its age) if a refresh fails. An unknown id gets an
  in-screen "Robot not found" rather than an error page.
- **Charts** break lines where the gap exceeds `max(offline threshold, 1.5
  buckets)`, shade contiguous charging buckets, and guard zero-span domains so
  one point or a parked robot draws a dot instead of dividing by zero.
- **Both screens** are responsive and dark; there is no chart library and no
  client-side state library.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next dev server (don't run `npm run build` while it runs) |
| `npm run build` / `start` | Production build and server |
| `npm run seed` | Insert/update display metadata; idempotent. `-- --robots 5` curates fewer |
| `npm run sim` | Robot simulator; see `npm run sim -- --help` |
| `npm test` | `node:test` suites via `tsx` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

## Configuration

All variables are optional; defaults live in `lib/config.ts`. An invalid value
fails at startup naming the variable rather than silently falling back.

| Variable | Default | Meaning |
|---|---|---|
| `INGEST_API_KEY` | `dev-ingest-key` | `x-ingest-key` the simulator must send |
| `DATABASE_PATH` | `./data/fleet.db` | SQLite file; parent directory is created |
| `OFFLINE_AFTER_MS` | `10000` | Age after which a robot is `offline` |
| `DELAYED_AFTER_MS` | `3000` | Age after which a robot is `delayed` |
| `LOW_BATTERY_PCT` | `20` | Battery under which a robot is `low_battery` |
| `RETENTION_HOURS` | `24` | Raw telemetry kept; older rows are swept on ingest |

The threshold values are positive whole milliseconds, and `DELAYED_AFTER_MS`
must be smaller than `OFFLINE_AFTER_MS`; `LOW_BATTERY_PCT` accepts 0–100.
`RETENTION_HOURS` accepts any positive number, including fractions — `0.001`
sets a 3.6 s cutoff for the sweep, which is a quick way to exercise it (the
sweep itself runs at most once a minute, on an accepted ingest).

## Status ladder

First match wins, so freshness outranks whatever the last report claimed:

```
offline → delayed → fault → charging → low_battery → moving → idle
```

A faulting robot that has been silent for 11 s reads `offline`, not `fault`.
The comparison is strict: at exactly 10 000 ms a robot is still `delayed`, and
10 001 ms is `offline`. Thresholds travel in every fleet and detail payload, and
the browser re-derives status each tick with the same pure function, so a
stalled stream ages honestly instead of freezing cards at their last status.

## API

| Endpoint | Notes |
|---|---|
| `POST /api/ingest` | `x-ingest-key`; one report or `{ "reports": [...] }`, max 500 and 512 KiB. Returns `{ accepted, duplicates, rejected }`. |
| `GET /api/fleet` | Full snapshot: `generatedAt`, `thresholds`, `summary`, `robots`. Filters: `?site=`, `?status=`, `?q=`. |
| `GET /api/robots/:id` | State, bucketed `history`, `trail`, `events`, `stats`. `?window=` one of `1m,5m,15m,1h,6h,24h` (default `15m`). Unknown id → 404. |
| `GET /api/stream` | SSE: `retry: 2000`, a `hello` frame, then one fleet snapshot per second, `: ping` when idle. |

Notes that are easy to miss:

- **Unknown robots are registered on first ingest** with `name = id`,
  `site_id = unassigned`, `model = unknown`; `npm run seed` later overwrites
  those fields without touching telemetry. A robot with no telemetry is absent
  from `/api/fleet` and 404s on detail, because the read model decides what
  exists.
- **Idempotency is `(robotId, seq)`.** A duplicate is counted, not stored. An
  older seq is stored in history but never rewinds `robot_latest`, including its
  `received_at` — a replayed batch cannot make a dead robot look fresh.
- **Unknown fields are stripped, not rejected.** Only an entirely invalid batch
  is `400`; one bad report never drops its neighbours.
- **Fleet summary semantics:** counts are computed after `site` and `q` but
  before `status`, so choosing a status narrows the cards without zeroing the
  other chips. `thresholds` travel with the payload so the UI cannot drift.
- **Detail downsampling:** the smallest bucket on a fixed ladder that keeps the
  window at or under ~180 points; 15 m lands on 5 s, the worst case is 181
  aligned buckets. Events are edges only (a new fault code, a charge start, a
  gap over the offline threshold), newest first and capped.
- **The stream is unfiltered.** Every frame is the same body `GET /api/fleet`
  returns with no parameters; filtering is the screen's job.

Errors are `{ "error": { "code", "message", "details"? } }`:

| Status | `code` | When |
|---|---|---|
| 401 | `unauthorized` | missing or wrong key; checked before the body |
| 413 | `payload_too_large` | body over 512 KiB |
| 400 | `invalid_json` | unparseable JSON |
| 400 | `invalid_body` | not a report object or `{ "reports": [...] }` |
| 400 | `empty_batch` | `reports: []` |
| 400 | `batch_too_large` | more than 500 reports |
| 400 | `invalid_reports` | every report failed validation |
| 400 | `invalid_query` | unknown fleet `status` or detail `window` |
| 404 | `robot_not_found` | id has never reported |

Unsupported methods get Next's automatic `405`.

## Simulator

```bash
npm run sim -- --robots 20 --interval 1000 --drop-rate 0.02
```

Flags: `--robots`, `--interval` (ms), `--url`, `--key`, `--seed`, `--drop-rate`.
Env fallbacks are `SIM_*` plus `INGEST_API_KEY`; see `.env.example`. The loop is a
fixed grid with one request in flight, one batch per tick, `SIGINT` prints a
summary and exits 0, and a wrong key exits 1 naming the header. A dropped report
still advances `seq`, so loss shows up as a gap rather than a duplicate. Faults
appear roughly once every eight minutes per robot at 1 Hz; use `--drop-rate 0`
for a lossless run.

## Retention

Only `telemetry` is swept: rows with `received_at` older than `RETENTION_HOURS`
are deleted by a 60 s-throttled sweep that runs after an accepted ingest.
`robot_latest` and `robots` are never swept, so a robot that has been gone for
longer than retention still appears — offline, with no history to chart. A
window longer than retention simply starts where the data starts.

SQLite keeps the file's high-water mark after a delete; the database is not
vacuumed automatically. Remove `data/fleet.db*` for a clean slate.

## Limits

- Single-instance only: the SSE hub and the database handle are process-local.
- SQLite is comfortable at tens of robots at 1 Hz; a Postgres repository is the
  intended swap past that.
- Ingestion is capped at 500 reports and 512 KiB per request.
- Read APIs are unauthenticated (single-tenant demo); ingestion is key-protected.
- Charts are hand-rolled SVG with no chart dependency.
- Detail windows are capped at 24 h; retention may be shorter.
- No dispatch, alerting, manager accounts, CI or deployment configuration.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `EADDRINUSE` | Another dev/build server owns the port: `lsof -ti tcp:3000` |
| Fleet empty after `npm run seed` | Seed writes metadata only; start `npm run sim` |
| Robots named `RBT-00x` in `unassigned` | Run `npm run seed`, or telemetry arrived before metadata |
| A synthetic report goes `delayed` then `offline` | Expected: freshness wins after 3 s / 10 s. Keep posting, or raise the thresholds for the session |
| No fault or charge event for a one-off report | Events are edges; send a healthy report first, then the state change |
| SSE output appears only when stopped | `curl` is buffering; use `curl -sN` |
| Fleet shows old robots after a reset | `rm data/fleet.db*` and restart; the read model is not swept |
| Dev page reloads in a loop | Don't run `npm run build` while `next dev` is serving |
| Detail charts empty | Retention is shorter than the selected window, or no reports in it |
