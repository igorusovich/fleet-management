/**
 * The fleet snapshot: read the store, derive status against one clock, filter,
 * count, respond.
 *
 * Plain function over a Web `Request`/`Response`, no `next/*` import, so the
 * gate calls it directly against a temp database with a pinned `now`.
 *
 * Why the filtering happens here and not in SQL: `status` is derived from
 * `receivedAt` and the thresholds at request time — it is not a column. Pushing
 * the other filters into SQL would give the app two filter paths and two chances
 * for the counts to disagree with the rows. One list, one `now`, one pass.
 *
 * Summary semantics (task 4 decision): the counts are computed *after* `site` and
 * `q` but *before* `status`. Picking a status therefore narrows the list without
 * zeroing the other chips — you can look at the moving robots and still see that
 * three are faulted.
 */

import type Database from "better-sqlite3";

import { listFleet, type FleetRow } from "../db/telemetry";
import {
  ROBOT_STATUSES,
  deriveStatus,
  type RobotStatus,
  type StatusThresholds,
} from "../telemetry/status";

/** Health counts. `total` is the number of robots the other counts are over. */
export interface FleetSummary {
  total: number;
  moving: number;
  idle: number;
  charging: number;
  low_battery: number;
  fault: number;
  delayed: number;
  offline: number;
}

/** One robot as the fleet screen sees it. */
export interface FleetRobot {
  id: string;
  name: string;
  siteId: string;
  model: string;
  status: RobotStatus;
  battery: number;
  charging: boolean;
  motion: FleetRow["motion"];
  x: number;
  y: number;
  heading: number;
  speed: number;
  errorCode: string | null;
  seq: number;
  deviceTs: number;
  receivedAt: number;
  /** `now - receivedAt`, clamped at 0 so a device clock ahead cannot read negative. */
  ageMs: number;
  samplesLastMinute: number;
}

/** 200 body. `thresholds` travels with the data so the UI cannot drift from the server. */
export interface FleetResponseBody {
  generatedAt: number;
  thresholds: StatusThresholds;
  summary: FleetSummary;
  robots: FleetRobot[];
}

export interface FleetDeps {
  readonly db: Database.Database;
  /** `config.thresholds` at request time. */
  readonly thresholds: StatusThresholds;
  /** Server clock in epoch ms. One value for the whole response. */
  readonly now: number;
}

const ROBOT_STATUS_SET: ReadonlySet<string> = new Set(ROBOT_STATUSES);

function isRobotStatus(value: string): value is RobotStatus {
  return ROBOT_STATUS_SET.has(value);
}

/** Query parameters arrive as `string | null`; a blank one means "not set". */
function cleanParam(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function invalidQuery(message: string, details?: unknown): Response {
  return Response.json(
    { error: { code: "invalid_query", message, ...(details === undefined ? {} : { details }) } },
    { status: 400 },
  );
}

function emptySummary(): FleetSummary {
  return {
    total: 0,
    moving: 0,
    idle: 0,
    charging: 0,
    low_battery: 0,
    fault: 0,
    delayed: 0,
    offline: 0,
  };
}

/**
 * Every robot with its status derived against one clock, unfiltered.
 *
 * Exported for the stream hub, which caches one snapshot per tick and serves it
 * to every connection; `handleFleet` reuses it for the filtered path.
 */
export function collectFleet(deps: FleetDeps): FleetRobot[] {
  const { db, thresholds, now } = deps;
  return listFleet(db, { now }).map((row) =>
    toFleetRobot(row, deriveStatus(row, now, thresholds), now),
  );
}

/** Count each status bucket once. */
export function summariseFleet(robots: readonly FleetRobot[]): FleetSummary {
  const summary = emptySummary();
  for (const robot of robots) {
    summary.total += 1;
    summary[robot.status] += 1;
  }
  return summary;
}

/** The unfiltered snapshot: what `GET /api/fleet` returns with no parameters. */
export function buildFleetSnapshot(deps: FleetDeps): FleetResponseBody {
  const robots = collectFleet(deps);
  return {
    generatedAt: deps.now,
    thresholds: deps.thresholds,
    summary: summariseFleet(robots),
    robots,
  };
}

function toFleetRobot(row: FleetRow, status: RobotStatus, now: number): FleetRobot {
  return {
    id: row.robotId,
    name: row.name,
    siteId: row.siteId,
    model: row.model,
    status,
    battery: row.battery,
    charging: row.charging,
    motion: row.motion,
    x: row.x,
    y: row.y,
    heading: row.heading,
    speed: row.speed,
    errorCode: row.errorCode,
    seq: row.seq,
    deviceTs: row.deviceTs,
    receivedAt: row.receivedAt,
    ageMs: Math.max(0, now - row.receivedAt),
    samplesLastMinute: row.samplesLastMinute,
  };
}

export function handleFleet(request: Request, deps: FleetDeps): Response {
  const { thresholds, now } = deps;
  const params = new URL(request.url).searchParams;

  const site = cleanParam(params.get("site"));
  const search = cleanParam(params.get("q"));
  const statusFilter = cleanParam(params.get("status"));

  if (statusFilter !== undefined && !isRobotStatus(statusFilter)) {
    return invalidQuery(
      `Unknown status ${JSON.stringify(statusFilter)}: expected one of ${ROBOT_STATUSES.join(", ")}.`,
      { parameter: "status", allowed: ROBOT_STATUSES },
    );
  }

  if (site === undefined && search === undefined && statusFilter === undefined) {
    return Response.json(buildFleetSnapshot(deps));
  }

  const needle = search?.toLowerCase();
  const scoped = collectFleet(deps).filter((robot) => {
    if (site !== undefined && robot.siteId !== site) return false;
    if (
      needle !== undefined &&
      !robot.id.toLowerCase().includes(needle) &&
      !robot.name.toLowerCase().includes(needle)
    ) {
      return false;
    }
    return true;
  });

  const robots = statusFilter === undefined ? scoped : scoped.filter((robot) => robot.status === statusFilter);
  const body: FleetResponseBody = {
    generatedAt: now,
    thresholds,
    summary: summariseFleet(scoped),
    robots,
  };
  return Response.json(body);
}
