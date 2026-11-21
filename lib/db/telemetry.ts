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
