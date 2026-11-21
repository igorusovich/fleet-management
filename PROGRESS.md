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
| 3 | `POST /api/ingest` | `[ ]` | — |
| 4 | `GET /api/fleet` | `[ ]` | — |
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

## Known limitations / open questions

- Single-instance SSE hub (in-process); multi-instance would need Redis pub/sub or a DB tail.
- SQLite writer is serialized; fine for tens of robots at 1 Hz, not for 1000s.
- Manager UI has no authentication (ingestion is key-protected).
- Next 16 has `cacheComponents: true` and `partialPrefetching: true` enabled by the scaffold.
  Dynamic pages/route handlers must be written against Next 16 conventions; `AGENTS.md` (shipped
  by the scaffold) says to read `node_modules/next/dist/docs/` before writing app code.
