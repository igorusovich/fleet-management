/**
 * Telemetry repository: every SQL statement this app runs against the store.
 *
 * The functions take the database handle explicitly instead of calling `getDb()`
 * themselves. That is what lets the gate run against a temp file, and it keeps
 * the route handlers free of SQL.
 *
 * Two rules hold the store together:
 *   1. `telemetry` is append-only; `UNIQUE (robot_id, seq)` makes a replayed
 *      report a no-op rather than a duplicate.
 *   2. `robot_latest` only moves forward by `seq`, so a late report lands in
 *      history without rewinding what the fleet view shows.
 */

import type Database from "better-sqlite3";

import { normaliseHeading, type MotionState, type TelemetryReport } from "../telemetry/schema";

export interface IngestResult {
  /** Reports newly written to `telemetry`. */
  accepted: number;
  /** Reports whose `(robot_id, seq)` was already stored. */
  duplicates: number;
}

/** One robot's current state, as stored in `robot_latest`. */
export interface LatestRow {
  robotId: string;
  seq: number;
  deviceTs: number;
  receivedAt: number;
  battery: number;
  charging: boolean;
  motion: MotionState;
  x: number;
  y: number;
  heading: number;
  speed: number;
  errorCode: string | null;
}

interface LatestRowDb {
  robot_id: string;
  seq: number;
  device_ts: number;
  received_at: number;
  battery: number;
  charging: number;
  motion: MotionState;
  x: number;
  y: number;
  heading: number;
  speed: number;
  error_code: string | null;
}

interface ReportParams {
  robotId: string;
  seq: number;
  ts: number;
  receivedAt: number;
  battery: number;
  charging: number;
  motion: MotionState;
  x: number;
  y: number;
  heading: number;
  speed: number;
  errorCode: string | null;
}

interface RobotParams {
  id: string;
  name: string;
  now: number;
}

const COLUMNS =
  "robot_id, seq, device_ts, received_at, battery, charging, motion, x, y, heading, speed, error_code";

const VALUES =
  "@robotId, @seq, @ts, @receivedAt, @battery, @charging, @motion, @x, @y, @heading, @speed, @errorCode";

const INSERT_REPORT = `
  INSERT INTO telemetry (${COLUMNS}) VALUES (${VALUES})
  ON CONFLICT (robot_id, seq) DO NOTHING
`;

/**
 * Auto-registration (task 2 decision): an unknown robot becomes a row with its
 * id as the display name. `DO NOTHING` matters — a later seed or rename must
 * not be overwritten by the next telemetry tick.
 */
const TOUCH_ROBOT = `
  INSERT INTO robots (id, name, site_id, model, created_at)
  VALUES (@id, @name, 'unassigned', 'unknown', @now)
  ON CONFLICT (id) DO NOTHING
`;

/**
 * The guarded upsert. Without the `WHERE`, a replayed or late batch would
 * silently rewind the fleet view — including `received_at`, which would make a
 * retried old report look freshly alive.
 */
const PROMOTE_LATEST = `
  INSERT INTO robot_latest (${COLUMNS}) VALUES (${VALUES})
  ON CONFLICT (robot_id) DO UPDATE SET
    seq         = excluded.seq,
    device_ts   = excluded.device_ts,
    received_at = excluded.received_at,
    battery     = excluded.battery,
    charging    = excluded.charging,
    motion      = excluded.motion,
    x           = excluded.x,
    y           = excluded.y,
    heading     = excluded.heading,
    speed       = excluded.speed,
    error_code  = excluded.error_code
  WHERE excluded.seq > robot_latest.seq
`;

const SELECT_LATEST_ALL = `SELECT ${COLUMNS} FROM robot_latest ORDER BY robot_id`;
const SELECT_LATEST_ONE = `SELECT ${COLUMNS} FROM robot_latest WHERE robot_id = ?`;

/**
 * The fleet read: one row per robot that has ever reported.
 *
 * `robot_latest` drives the join rather than `robots`, because the read model is
 * what says a robot has state. A robot row with no telemetry yet (a future seed
 * step) is not in the fleet view; a telemetry row with no metadata is, with
 * fallbacks. The sample count is correlated so it stays one statement and one
 * pass over the receive-time index.
 */
const SELECT_FLEET = `
  SELECT
    l.robot_id                        AS robot_id,
    COALESCE(r.name, l.robot_id)      AS name,
    COALESCE(r.site_id, 'unassigned') AS site_id,
    COALESCE(r.model, 'unknown')      AS model,
    l.seq,
    l.device_ts,
    l.received_at,
    l.battery,
    l.charging,
    l.motion,
    l.x,
    l.y,
    l.heading,
    l.speed,
    l.error_code,
    (
      SELECT count(*) FROM telemetry t
      WHERE t.robot_id = l.robot_id AND t.received_at >= @windowStart
    ) AS samples_last_minute
  FROM robot_latest l
  LEFT JOIN robots r ON r.id = l.robot_id
  ORDER BY l.robot_id
`;

/** How far back `samplesLastMinute` counts. */
export const SAMPLE_WINDOW_MS = 60_000;

/**
 * One fleet row: the read model plus display metadata and a liveness count.
 *
 * Metadata comes through `COALESCE`, so a robot whose `robots` row is missing
 * (or whose name has not been curated yet) still appears with sane defaults.
 */
export interface FleetRow {
  robotId: string;
  name: string;
  siteId: string;
  model: string;
  seq: number;
  deviceTs: number;
  receivedAt: number;
  battery: number;
  charging: boolean;
  motion: MotionState;
  x: number;
  y: number;
  heading: number;
  speed: number;
  errorCode: string | null;
  samplesLastMinute: number;
}

interface FleetRowDb {
  robot_id: string;
  name: string;
  site_id: string;
  model: string;
  seq: number;
  device_ts: number;
  received_at: number;
  battery: number;
  charging: number;
  motion: MotionState;
  x: number;
  y: number;
  heading: number;
  speed: number;
  error_code: string | null;
  samples_last_minute: number;
}

interface FleetParams {
  windowStart: number;
}

interface Statements {
  insertReport: Database.Statement<ReportParams, unknown>;
  touchRobot: Database.Statement<RobotParams, unknown>;
  promoteLatest: Database.Statement<ReportParams, unknown>;
  selectAll: Database.Statement<[], LatestRowDb>;
  selectOne: Database.Statement<[string], LatestRowDb>;
  selectFleet: Database.Statement<FleetParams, FleetRowDb>;
  selectRobot: Database.Statement<RobotIdParams, RobotRowDb>;
  selectBuckets: Database.Statement<BucketParams, BucketRowDb>;
  selectEvents: Database.Statement<EventParams, EventRowDb>;
  selectStats: Database.Statement<StatsParams, StatsRowDb>;
}

/**
 * Prepared statements are bound to a connection, so they are cached per handle
 * and compiled once rather than on every tick.
 */
const statementCache = new WeakMap<Database.Database, Statements>();

function statements(db: Database.Database): Statements {
  let cached = statementCache.get(db);
  if (!cached) {
    cached = {
      insertReport: db.prepare<ReportParams, unknown>(INSERT_REPORT),
      touchRobot: db.prepare<RobotParams, unknown>(TOUCH_ROBOT),
      promoteLatest: db.prepare<ReportParams, unknown>(PROMOTE_LATEST),
      selectAll: db.prepare<[], LatestRowDb>(SELECT_LATEST_ALL),
      selectOne: db.prepare<[string], LatestRowDb>(SELECT_LATEST_ONE),
      selectFleet: db.prepare<FleetParams, FleetRowDb>(SELECT_FLEET),
      selectRobot: db.prepare<RobotIdParams, RobotRowDb>(SELECT_ROBOT),
      selectBuckets: db.prepare<BucketParams, BucketRowDb>(SELECT_BUCKETS),
      selectEvents: db.prepare<EventParams, EventRowDb>(SELECT_EVENTS),
      selectStats: db.prepare<StatsParams, StatsRowDb>(SELECT_WINDOW_STATS),
    };
    statementCache.set(db, cached);
  }
  return cached;
}

function toLatestRow(row: LatestRowDb): LatestRow {
  return {
    robotId: row.robot_id,
    seq: row.seq,
    deviceTs: row.device_ts,
    receivedAt: row.received_at,
    battery: row.battery,
    charging: row.charging === 1,
    motion: row.motion,
    x: row.x,
    y: row.y,
    heading: row.heading,
    speed: row.speed,
    errorCode: row.error_code,
  };
}

/**
 * Store one validated batch in a single transaction.
 *
 * `receivedAt` is a parameter rather than `Date.now()` inside the loop so a
 * batch has one coherent timestamp and the tests can pin it. The route handler
 * is the place that decides "now".
 *
 * One transaction per batch, not per report: 500 reports become one commit, and
 * the history row and the read model can never disagree.
 */
export function ingestReports(
  db: Database.Database,
  reports: readonly TelemetryReport[],
  receivedAt: number = Date.now(),
): IngestResult {
  if (reports.length === 0) return { accepted: 0, duplicates: 0 };

  const sql = statements(db);

  const write = db.transaction((batch: readonly TelemetryReport[]): IngestResult => {
    let accepted = 0;
    let duplicates = 0;
    // A gateway posts every robot in one batch: register each id once, not once
    // per report.
    const seenRobots = new Set<string>();

    for (const report of batch) {
      if (!seenRobots.has(report.robotId)) {
        seenRobots.add(report.robotId);
        sql.touchRobot.run({ id: report.robotId, name: report.robotId, now: receivedAt });
      }

      const params: ReportParams = {
        robotId: report.robotId,
        seq: report.seq,
        ts: report.ts,
        receivedAt,
        battery: report.battery,
        charging: report.charging ? 1 : 0,
        motion: report.motion,
        // 360 and 0 are the same bearing; store one canonical value.
        heading: normaliseHeading(report.heading),
        x: report.x,
        y: report.y,
        speed: report.speed,
        errorCode: report.errorCode,
      };

      const info = sql.insertReport.run(params);
      if (info.changes === 0) duplicates += 1;
      else accepted += 1;

      sql.promoteLatest.run(params);
    }

    return { accepted, duplicates };
  });

  return write(reports);
}

/** Every robot's current state, ordered by id so callers get a stable array. */
export function listLatest(db: Database.Database): LatestRow[] {
  return statements(db).selectAll.all().map(toLatestRow);
}

/** One robot's current state, or `null` if it has never reported. */
export function getLatest(db: Database.Database, robotId: string): LatestRow | null {
  const row = statements(db).selectOne.get(robotId);
  return row === undefined ? null : toLatestRow(row);
}

function toFleetRow(row: FleetRowDb): FleetRow {
  return {
    robotId: row.robot_id,
    name: row.name,
    siteId: row.site_id,
    model: row.model,
    seq: row.seq,
    deviceTs: row.device_ts,
    receivedAt: row.received_at,
    battery: row.battery,
    charging: row.charging === 1,
    motion: row.motion,
    x: row.x,
    y: row.y,
    heading: row.heading,
    speed: row.speed,
    errorCode: row.error_code,
    samplesLastMinute: row.samples_last_minute,
  };
}

/**
 * Every robot that has reported, with metadata and its sample count.
 *
 * `now` is passed in rather than read here for the same reason as in ingest:
 * one clock per request, and the caller owns it. Ordered by id so the response
 * order is deterministic without a sort in the handler.
 */
export function listFleet(
  db: Database.Database,
  options: { now: number; windowMs?: number },
): FleetRow[] {
  const windowMs = options.windowMs ?? SAMPLE_WINDOW_MS;
  return statements(db)
    .selectFleet.all({ windowStart: options.now - windowMs })
    .map(toFleetRow);
}

/* -------------------------------------------------------------------------- *
 * Robot detail (task 5): one state read plus three reads over a time window.
 *
 * All four ride `telemetry_robot_received` (migration 2), and each keeps its
 * work in SQLite: the bucket group-by, the `LAG` edge detection and the `sqrt`
 * travelled distance never move raw rows into JavaScript. That is what keeps a
 * 24 h window at four queries instead of 86 400 hydrated objects.
 * -------------------------------------------------------------------------- */

/** One robot's read model, with the same metadata fallbacks as a fleet row. */
export interface RobotRow {
  robotId: string;
  name: string;
  siteId: string;
  model: string;
  seq: number;
  deviceTs: number;
  receivedAt: number;
  battery: number;
  charging: boolean;
  motion: MotionState;
  x: number;
  y: number;
  heading: number;
  speed: number;
  errorCode: string | null;
}

interface RobotRowDb {
  robot_id: string;
  name: string;
  site_id: string;
  model: string;
  seq: number;
  device_ts: number;
  received_at: number;
  battery: number;
  charging: number;
  motion: MotionState;
  x: number;
  y: number;
  heading: number;
  speed: number;
  error_code: string | null;
}

/** What a chart point and a trail point have in common. */
export interface BucketRow {
  /** Bucket start, epoch-aligned to `bucketMs`. */
  t: number;
  battery: number;
  speed: number;
  charging: boolean;
  x: number;
  y: number;
}

interface BucketRowDb {
  t: number;
  battery: number;
  speed: number;
  charging: number;
  x: number;
  y: number;
}

export type RobotEventKind = "fault" | "charge_start" | "comms_gap";

/** An edge in the telemetry, not a sample: one entry per transition. */
export interface EventRow {
  t: number;
  kind: RobotEventKind;
  /** The new error code, or a readable gap length; `null` for a charge start. */
  detail: string | null;
}

interface EventRowDb {
  t: number;
  kind: RobotEventKind;
  detail: string | null;
}

/** Totals over the raw rows in the window. */
export interface WindowStats {
  reports: number;
  /** `null` when the window is empty, so the UI does not plot a fake 0 %. */
  avgBattery: number | null;
  distanceM: number;
  gapCount: number;
}

interface StatsRowDb {
  reports: number;
  avg_battery: number | null;
  distance_m: number;
  gap_count: number;
}

interface RobotIdParams {
  robotId: string;
}

interface BucketParams extends RobotIdParams {
  bucketMs: number;
  from: number;
  to: number;
}

interface EventParams extends BucketParams {
  offlineAfterMs: number;
  limit: number;
}

interface StatsParams extends BucketParams {
  offlineAfterMs: number;
}

/** The same join as `SELECT_FLEET`, narrowed to one id and without the count. */
const SELECT_ROBOT = `
  SELECT
    l.robot_id                        AS robot_id,
    COALESCE(r.name, l.robot_id)      AS name,
    COALESCE(r.site_id, 'unassigned') AS site_id,
    COALESCE(r.model, 'unknown')      AS model,
    l.seq,
    l.device_ts,
    l.received_at,
    l.battery,
    l.charging,
    l.motion,
    l.x,
    l.y,
    l.heading,
    l.speed,
    l.error_code
  FROM robot_latest l
  LEFT JOIN robots r ON r.id = l.robot_id
  WHERE l.robot_id = @robotId
`;

/**
 * One row per bucket. `t` is `received_at` minus its remainder, not a division:
 * the modulo is exact for positive epoch milliseconds, whereas a division whose
 * operands arrive as REAL (the driver binds large numbers as doubles) would
 * leave every row in a bucket of its own. Either way `t` is stable between
 * polls, so a point that already exists does not shift when a report lands.
 *
 * `max(charging)` reads as "this bucket contained charging time", and the mean
 * position is the segment's midpoint for the trail.
 */
const SELECT_BUCKETS = `
  SELECT
    received_at - (received_at % @bucketMs) AS t,
    round(avg(battery), 1)                AS battery,
    max(speed)                            AS speed,
    max(charging)                         AS charging,
    round(avg(x), 2)                      AS x,
    round(avg(y), 2)                      AS y
  FROM telemetry
  WHERE robot_id = @robotId AND received_at >= @from AND received_at <= @to
  GROUP BY t
  ORDER BY t
`;

/**
 * Edges only, in one pass: `lag()` gives every row its predecessor, and the
 * three branches turn the differences into rows. `IS NOT` rather than `<>` so a
 * cleared code (`E_STUCK` → `NULL`) is not lost to SQL's three-valued logic.
 *
 * A transition whose predecessor sits just outside the window is not reported;
 * `state` still shows what the robot is doing right now.
 */
const SELECT_EVENTS = `
  WITH ordered AS (
    SELECT
      received_at,
      error_code,
      charging,
      lag(error_code)  OVER (ORDER BY received_at, seq) AS prev_error_code,
      lag(charging)    OVER (ORDER BY received_at, seq) AS prev_charging,
      lag(received_at) OVER (ORDER BY received_at, seq) AS prev_received_at
    FROM telemetry
    WHERE robot_id = @robotId AND received_at >= @from AND received_at <= @to
  )
  SELECT received_at AS t, 'fault' AS kind, error_code AS detail
    FROM ordered
    WHERE error_code IS NOT NULL AND error_code IS NOT prev_error_code
  UNION ALL
  SELECT received_at, 'charge_start', NULL
    FROM ordered
    WHERE charging = 1 AND prev_charging = 0
  UNION ALL
  SELECT received_at, 'comms_gap', printf('no reports for %.1fs', (received_at - prev_received_at) / 1000.0)
    FROM ordered
    WHERE prev_received_at IS NOT NULL AND received_at - prev_received_at > @offlineAfterMs
  ORDER BY t DESC, kind
  LIMIT @limit
`;

/**
 * Window totals. The distance is the sum of segment lengths, and a segment that
 * spans a comms gap is skipped: the robot did not teleport, we just do not know
 * the path it took, and including the straight line would inflate the number.
 *
 * `coalesce(..., 0)` keeps an empty window from answering `null` for the two
 * values the UI reads as a number.
 */
const SELECT_WINDOW_STATS = `
  WITH ordered AS (
    SELECT
      received_at,
      battery,
      x,
      y,
      lag(x)           OVER (ORDER BY received_at, seq) AS prev_x,
      lag(y)           OVER (ORDER BY received_at, seq) AS prev_y,
      lag(received_at) OVER (ORDER BY received_at, seq) AS prev_received_at
    FROM telemetry
    WHERE robot_id = @robotId AND received_at >= @from AND received_at <= @to
  )
  SELECT
    count(*) AS reports,
    round(avg(battery), 1) AS avg_battery,
    round(coalesce(sum(
      CASE
        WHEN prev_received_at IS NOT NULL
         AND received_at - prev_received_at <= @offlineAfterMs
        THEN sqrt((x - prev_x) * (x - prev_x) + (y - prev_y) * (y - prev_y))
      END
    ), 0), 1) AS distance_m,
    coalesce(sum(
      CASE
        WHEN prev_received_at IS NOT NULL
         AND received_at - prev_received_at > @offlineAfterMs
        THEN 1 ELSE 0
      END
    ), 0) AS gap_count
  FROM ordered
`;

/** How many events a detail response carries; the newest ones win. */
export const EVENT_LIMIT = 200;

function toRobotRow(row: RobotRowDb): RobotRow {
  return {
    robotId: row.robot_id,
    name: row.name,
    siteId: row.site_id,
    model: row.model,
    seq: row.seq,
    deviceTs: row.device_ts,
    receivedAt: row.received_at,
    battery: row.battery,
    charging: row.charging === 1,
    motion: row.motion,
    x: row.x,
    y: row.y,
    heading: row.heading,
    speed: row.speed,
    errorCode: row.error_code,
  };
}

/** One robot's state, or `null` if it has never reported. */
export function getRobot(db: Database.Database, robotId: string): RobotRow | null {
  const row = statements(db).selectRobot.get({ robotId });
  return row === undefined ? null : toRobotRow(row);
}

/** Downsampled history for `[from, to]`, oldest bucket first. */
export function listBuckets(
  db: Database.Database,
  options: BucketParams,
): BucketRow[] {
  return statements(db)
    .selectBuckets.all(options)
    .map((row) => ({
      t: row.t,
      battery: row.battery,
      speed: row.speed,
      charging: row.charging === 1,
      x: row.x,
      y: row.y,
    }));
}

/** Edges in `[from, to]`, newest first, capped at `limit`. */
export function listEvents(
  db: Database.Database,
  options: Omit<EventParams, "limit"> & { limit?: number },
): EventRow[] {
  return statements(db).selectEvents.all({ ...options, limit: options.limit ?? EVENT_LIMIT });
}

/** Totals over the raw rows in `[from, to]`. */
export function readWindowStats(db: Database.Database, options: StatsParams): WindowStats {
  const row = statements(db).selectStats.get(options);
  return {
    reports: row?.reports ?? 0,
    avgBattery: row?.avg_battery ?? null,
    distanceM: row?.distance_m ?? 0,
    gapCount: row?.gap_count ?? 0,
  };
}
