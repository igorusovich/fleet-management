# Fleet Telemetry — Implementation Plan

Fleet management software for warehouse robots. Robots report state (battery, position) roughly
once per second. The data must be ingested, stored, and presented to a fleet manager who needs to
know what the fleet is doing *right now*, plus inspect a single robot in detail.

Three parts, per the brief:

1. **Robot simulator** — data producer that sends telemetry into the system.
2. **Server** — ingestion, storage, business logic, exposed through an interface for the UI.
3. **User interface** — fleet state, and one robot in detail.

Stack: Next.js (App Router) + React + TypeScript.

---

## 1. Scope

### In scope
- HTTP ingestion endpoint with validation, API-key auth, batching and idempotency.
- Append-only telemetry storage + a fast "latest state per robot" read model.
- Derived operational status computed server-side (online/offline/delayed, low battery, charging, fault).
- Fleet snapshot API and single-robot detail API with a time window of history.
- Live push of fleet updates to the browser (SSE).
- Fleet overview screen (all robots, sortable/filterable, live).
- Robot detail screen (current state, battery history, position trail, event log).
- Simulator CLI: N robots, ~1 Hz ticks, realistic movement, battery drain, charge cycles, faults, connectivity drops.

### Out of scope (deliberately)
- Real robot integration, MQTT/broker infrastructure, horizontal scaling, auth for the *manager* UI
  (single-tenant demo; ingestion is key-protected).
- Task assignment / dispatch to robots (fleet management proper). This exercise is fleet *visibility*.
- Long-term analytics, alerting integrations, multi-site administration screens beyond a site filter.

### Success criteria
- Simulator running for 60 s produces ~1 report/robot/s visible in the UI without manual refresh.
- Killing the simulator flips robots to **offline** within the staleness threshold, with no manual action.
- A malformed, duplicated or out-of-order report never corrupts or duplicates stored state.
- Detail screen answers "what is this robot doing / where has it been / is its battery a problem" without SQL.

---

## 2. Architecture

```
                     ┌──────────────────────────────────────────┐
  simulator/         │  Next.js server                          │
  ┌────────────┐     │                                          │
  │ 20 robots  │     │  POST /api/ingest  ──┐                   │
  │ 1 Hz each  │────▶│  (zod validate,      │                   │
  │ move/drain │     │   dedupe, upsert)    ▼                   │
  └────────────┘     │            ┌──────────────────────┐      │
                     │            │  db.ts (SQLite/WAL)  │      │
                     │            │  telemetry (append)  │      │
                     │            │  robot_latest (1/row)│      │
                     │            └─────────┬────────────┘      │
                     │                      │                   │
                     │  GET /api/fleet ◀────┤                   │
                     │  GET /api/robots/:id │                   │
                     │  GET /api/stream  ───┘ (SSE, 1 Hz push)  │
                     └───────────────┬──────────────────────────┘
                                     │  fetch + EventSource
                     ┌───────────────▼──────────────────────────┐
                     │  React UI                                │
                     │  /            fleet overview (live)      │
                     │  /robots/:id  detail + history + trail   │
                     └──────────────────────────────────────────┘
```

Layer boundaries (so the transport/storage can be swapped later):

- `lib/telemetry/schema.ts` — payload types + zod parsers. No I/O.
- `lib/telemetry/status.ts` — pure derivation of operational status from latest state + `now`.
- `lib/db/*` — schema/migration + repository functions (`ingestReports`, `getFleet`, `getRobotDetail`).
- `app/api/*` — thin handlers: parse → call repository → shape response.
- `app/**` — presentational components, consume the APIs only.
- `simulator/` — standalone Node process; knows nothing about the DB, only the HTTP contract.

---

## 3. Data model

SQLite, WAL mode, `busy_timeout` set. Epoch-millisecond integers for timestamps.

```sql
CREATE TABLE robots (
  id          TEXT PRIMARY KEY,          -- "RBT-001"
  name        TEXT NOT NULL,
  site_id     TEXT NOT NULL,             -- "site-berlin"
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE telemetry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  robot_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,          -- per-robot monotonic counter from the device
  device_ts   INTEGER NOT NULL,          -- when the robot sampled its state
  received_at INTEGER NOT NULL,          -- when the server accepted it
  battery     REAL NOT NULL,             -- 0..100
  charging    INTEGER NOT NULL,          -- 0/1
  motion      TEXT NOT NULL,             -- idle | moving | charging | error
  x           REAL NOT NULL,             -- site-local metres
  y           REAL NOT NULL,
  heading     REAL NOT NULL,             -- degrees 0..360
  speed       REAL NOT NULL,             -- m/s
  error_code  TEXT,                      -- non-null => fault
  UNIQUE (robot_id, seq)                 -- idempotency key
);
CREATE INDEX telemetry_robot_ts ON telemetry (robot_id, device_ts DESC);
CREATE INDEX telemetry_ts       ON telemetry (device_ts);

CREATE TABLE robot_latest (              -- read model, upserted on ingest
  robot_id    TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,
  device_ts   INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  battery     REAL NOT NULL,
  charging    INTEGER NOT NULL,
  motion      TEXT NOT NULL,
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  heading     REAL NOT NULL,
  speed       REAL NOT NULL,
  error_code  TEXT
);
```

Why two tables: the append-only table is the audit/history source; `robot_latest` makes the
fleet view a single indexed scan instead of a `MAX(device_ts)` group-by over millions of rows.
The upsert is guarded by `WHERE excluded.seq > robot_latest.seq`, so a late-arriving old report
lands in history but never rewinds the current state.

**Retention:** a `DELETE ... WHERE device_ts < now - RETENTION_HOURS` sweep runs on ingest every
N writes (cheap, bounded). History shown in the UI is downsampled by query, not by deletion.

---

## 4. Business logic — derived status

Raw telemetry says what the robot *said*; the manager needs what is *true now*. Computed at read
time from `received_at` and `now` (no background sweeper needed, so a stopped simulator is
detected correctly even if nothing is writing):

| Condition (evaluated in order) | Status | Meaning |
|---|---|---|
| `now - received_at > OFFLINE_AFTER_MS` (10 s) | `offline` | comms lost / robot down |
| `now - received_at > DELAYED_AFTER_MS` (3 s) | `delayed` | missing ticks, still reachable |
| `error_code != null` | `fault` | robot reports a fault |
| `charging` | `charging` | docked on charger |
| `battery < LOW_BATTERY_PCT` (20) | `low_battery` | actionable soon |
| `motion === 'moving'` | `moving` | normal operation |
| otherwise | `idle` | powered, no task |

Fleet summary counts these buckets plus `total`. Thresholds live in one config module and are
exposed to the UI so threshold text ("offline after 10 s") matches behaviour.

---

## 5. API contract

All JSON. Errors: `{ error: { code, message, details? } }`.

### `POST /api/ingest`
Header `x-ingest-key: <INGEST_API_KEY>`. Body: one report or `{ reports: Report[] }` (max 500).

```jsonc
// Report
{ "robotId": "RBT-001", "seq": 412, "ts": 1732700000000, "battery": 73.4,
  "charging": false, "motion": "moving", "x": 12.5, "y": -3.02,
  "heading": 91.2, "speed": 0.7, "errorCode": null }
```
`200` → `{ accepted, duplicates, rejected: [{ index, reason }] }` — partial success is normal
(one bad report must not drop the batch). `401` bad key, `400` unparseable body.

### `GET /api/fleet?site=&status=&q=`
```jsonc
{ "generatedAt": 1732700001234,
  "summary": { "total": 20, "moving": 11, "idle": 4, "charging": 2,
               "low_battery": 1, "fault": 0, "delayed": 1, "offline": 1 },
  "robots": [ { "id", "name", "siteId", "model",
                "status",                       // derived
                "battery", "charging", "motion", "x", "y", "heading", "speed",
                "errorCode", "seq", "deviceTs", "receivedAt",
                "ageMs", "samplesLastMinute" } ] }
```

### `GET /api/robots/:id?window=15m`
```jsonc
{ "robot": {...}, "state": { ...latest + derived status... },
  "history": [ { "t", "battery", "charging", "speed" } ],   // bucketed by window
  "trail":   [ { "t", "x", "y" } ],
  "events":  [ { "t", "kind": "fault|charge_start|comms_gap", "detail" } ],
  "stats":   { "reports": 900, "avgBattery": 61, "distanceM": 412, "gapCount": 2 } }
```
Downsampling: `window=15m` → ~5 s buckets with `avg(battery)`, `max(speed)`, so a 900-row
history becomes ~180 chart points. The trail is decimated the same way.

### `GET /api/stream` (SSE)
Pushes `event: fleet` ~every 1 s with the same `summary` + robots array, and `event: hello` on
connect. Uses an in-process hub with a 1 s coalescing tick; falls back to polling in the client if
the connection drops. Single-instance only (documented limitation).

---

## 6. Simulator design

Standalone TypeScript CLI in `simulator/`, run with `tsx`, separate from the Next server:

- `--robots 20 --url http://localhost:3000 --interval 1000 --key dev-ingest-key`
  (also `SIM_ROBOTS`, `SIM_URL`, `SIM_INTERVAL_MS`, `INGEST_API_KEY`).
- Each robot owns: position, heading, battery, mode, per-robot `seq`. Deterministic seeded RNG
  per robot so runs are reproducible (`--seed`).
- Behaviour per tick: waypoint cruising inside the site bounds; battery drain proportional to
  speed; below 18% → seek dock → `charging` until 95%; random `error_code` episodes (stuck,
  lidar, wheel slip) that clear after a few seconds; `--drop-rate` chance to skip a tick
  (simulates comms loss so `delayed`/`offline` paths are exercisable).
- Batches all robots' reports into one POST per tick (`{ reports: [...] }`) — matches the
  realistic "one fleet gateway" pattern and keeps timers aligned.
- Logs one line per tick: `t=42 accepted=20 dup=0 rejected=0 rtt=6ms`; exits non-zero on 401
  so a misconfigured key fails loudly instead of simulating silently.

---

## 7. UI design

**Fleet overview `/`**
- Header: fleet totals + health chips (moving / idle / charging / low battery / fault / offline),
  connection indicator (live / reconnecting / polling), last update time.
- Controls: search by id/name, site filter, status filter, sort (status severity, battery, name),
  density toggle maybe. Keep it to search + status + sort.
- Robot cards: status pill, big battery bar with % , id + site, current motion/speed, position,
  "last update Xs ago". Color by status; offline cards dimmed. Click → detail.
- Empty state (no robots yet, simulator not running) and loading skeletons.

**Robot detail `/robots/[id]`**
- Breadcrumb back to fleet; header with id, name, site, model, live status pill.
- KPI row: battery (+ charging state), speed, heading, last update, seq, error code.
- Battery history chart (SVG area/line, hand-rolled — no chart dependency) over selectable window
  (5m / 15m / 1h), with low-battery threshold line and charge periods shaded.
- Movement: site-plan view (SVG, site grid + waypoint trail + current heading arrow) and a
  distance-travelled stat; speed sparkline.
- Event log: faults, charge start/stop, comms gaps derived from history.

Charts hand-rolled as SVG to avoid a dependency in the critical path.

---

## 8. Cross-cutting concerns

- **Validation** — zod schemas; unknown fields stripped; ranges enforced (battery 0-100, seq ≥ 0,
  finite coordinates). Rejected reports never abort a batch.
- **Idempotency / ordering** — `UNIQUE(robot_id, seq)`; `INSERT OR IGNORE` counts duplicates;
  `robot_latest` only moves forward by `seq`.
- **Backpressure** — batch endpoint accepts up to 500 reports per request; SQLite writes wrapped in
  a single transaction per request.
- **Config** — one `lib/config.ts` reading env with defaults; `.env.example` committed.
- **Auth** — `x-ingest-key` compared with timing-safe equality against `INGEST_API_KEY`.
  Read APIs are open (local demo).
- **Observability** — structured `console` logs in the ingest handler: batch size, accepted,
  duplicates, rejected, insert duration.
- **Failure modes documented** — single-instance SSE hub, in-process only; SQLite fine to ~tens of
  robots at 1 Hz, Postgres repository swap needed past that.

---

## 9. Task list (each step ends with verification)

| # | Task | Verification gate |
|---|------|-------------------|
| 0 | Scaffold Next.js 16 + TS + Tailwind + ESLint; directory layout; `.env.example`; base layout/nav | `npm run build` passes; dev server serves `/` |
| 1 | Domain types, zod schemas, status derivation, config module | `npm run typecheck`; unit test: valid/invalid payloads, status precedence incl. offline |
| 2 | DB layer: schema init/migration, WAL pragmas, repository (`ingest`, `latest`, `fleet`, `detail`) | Node script writes reports, reads them back; duplicate + out-of-order cases asserted |
| 3 | `POST /api/ingest` — auth, batch, idempotency, partial reject, logging | curl matrix: valid single, valid batch, 401, malformed 400, duplicate replay, out-of-order |
| 4 | `GET /api/fleet` with derived status, summary, filters | curl against seeded DB: counts and statuses correct |
| 5 | `GET /api/robots/:id` with bucketed history, trail, stats, events | curl: window sizes, unknown id → 404 |
| 6 | SSE `/api/stream` hub + client hook with polling fallback | `curl -N` shows `hello` then `fleet` frames while posting |
| 7 | Simulator CLI (movement, drain, charging, faults, drops, batch POST, logging) | Run 30 s: 20 robots advancing in DB, exit code 0 on SIGINT, 401 path fails loudly |
| 8 | Fleet overview UI (cards, filters, live updates, empty/loading states) | `npm run build`; page renders live data from running simulator |
| 9 | Robot detail UI (KPIs, battery chart, site map/trail, event log, window switch) | `npm run build`; detail page renders for a live robot |
| 10 | Resilience pass: retention sweep, stale thresholds in UI, seed helper, README + run instructions | End-to-end: simulator → ingest → fleet → detail; stopping simulator flips offline |
| 11 | Final verification: full check suite, progress log closed out | `npm run lint && npm run typecheck && npm run build && npm test` all green |

Progress is tracked in [`PROGRESS.md`](./PROGRESS.md). Steps 0–11 are executed in order; a step
is only marked done once its gate above has been run and its output recorded in the tracker.

---

## 10. Decisions (confirmed with user, 2026-11-21)

1. **Persistence:** embedded **SQLite via `better-sqlite3`** (WAL). Zero setup, real durability,
   survives restarts, and the repository layer makes a Postgres swap mechanical. Alternative:
   Postgres in Docker (more production-shaped, more moving parts for a demo).
2. **Ingest transport:** **HTTP POST, batched** one request per tick carrying all robots.
   Alternatives: HTTP per report per robot (20× the requests) or a WebSocket/MQTT stream
   (closer to real fleets, heavier to demo).
3. **Server→UI updates:** **SSE** with polling fallback. Alternatives: 1 Hz polling (simplest,
   more traffic) or WebSocket (bidirectional, unnecessary here).
4. **Charts:** hand-rolled SVG, no chart library.
5. **Simulator:** separate Node process, not part of the Next app, so it can be pointed at any
   deployment and genuinely exercises the network boundary.
