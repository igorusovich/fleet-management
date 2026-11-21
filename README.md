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

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next dev server (don't run `npm run build` while it runs) |
| `npm run build` / `start` | Production build and server |
| `npm run seed` | Insert/update display metadata for 20 robots; idempotent |
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

## Status ladder

First match wins, so freshness outranks whatever the last report claimed:

```
offline → delayed → fault → charging → low_battery → moving → idle
```

A faulting robot that has been silent for 11 s reads `offline`, not `fault`.
Thresholds travel in every fleet and detail payload, and the browser re-derives
status each tick with the same pure function, so a stalled stream ages honestly
instead of freezing cards at their last status.

## API

| Endpoint | Notes |
|---|---|
| `POST /api/ingest` | `x-ingest-key`; one report or `{ "reports": [...] }`, max 500. Returns `{ accepted, duplicates, rejected }`. Batches are idempotent on `(robotId, seq)`. |
| `GET /api/fleet` | Full snapshot: `generatedAt`, `thresholds`, `summary`, `robots`. Filters: `?site=`, `?status=`, `?q=`. |
| `GET /api/robots/:id` | State, bucketed `history`, `trail`, `events`, `stats`. `?window=` one of `1m,5m,15m,1h,6h,24h` (default `15m`). Unknown id → 404. |
| `GET /api/stream` | SSE: `retry: 2000`, a `hello` frame, then one full fleet snapshot per second, `: ping` when idle. |

```bash
curl -s localhost:3000/api/fleet | jq '.summary'
curl -sN localhost:3000/api/stream
curl -s -X POST localhost:3000/api/ingest \
  -H 'content-type: application/json' -H 'x-ingest-key: dev-ingest-key' \
  -d '{"robotId":"RBT-900","seq":1,"ts":1700000000000,"battery":72,"charging":false,"motion":"moving","x":4,"y":-2,"heading":90,"speed":1.2}'
```

## Simulator

```bash
npm run sim -- --robots 20 --interval 1000 --drop-rate 0.02
```

Flags: `--robots`, `--interval` (ms), `--url`, `--key`, `--seed`, `--drop-rate`.
Env fallbacks are `SIM_*` plus `INGEST_API_KEY`; see `.env.example`. The loop is a
fixed grid with one request in flight, `SIGINT` prints a summary and exits 0, and
a wrong key exits 1 naming the header.

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
- Read APIs are unauthenticated (single-tenant demo); ingestion is key-protected.
- Charts are hand-rolled SVG with no chart dependency.
- Detail windows are capped at 24 h; retention may be shorter.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `EADDRINUSE` | Another dev/build server owns the port: `lsof -ti tcp:3000` |
| Robots named `RBT-00x` in `unassigned` | Run `npm run seed`, or telemetry arrived before metadata |
| Fleet shows old robots after a reset | `rm data/fleet.db*` and restart; the read model is not swept |
| Dev page reloads in a loop | Don't run `npm run build` while `next dev` is serving |
| Detail charts empty | Retention is shorter than the selected window, or no reports in it |
