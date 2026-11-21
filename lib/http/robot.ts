/**
 * The robot detail read: resolve the window, read the state, downsample the
 * history, collect the edges, total the window, respond.
 *
 * Plain function over a Web `Request`/`Response`, no `next/*` import, so the
 * gate calls it against a temp database with a pinned `now`.
 *
 * Three decisions worth knowing:
 *   1. The window is an allowlist, not a free-form duration. A caller cannot ask
 *      for 47 minutes and get 2 820 points; there are six sizes and the UI picks
 *      one. An unknown value is a 400, not a silent fallback.
 *   2. Resolution follows the window, not the caller: the smallest bucket on the
 *      ladder that keeps the response at or under `MAX_POINTS`. Since the ladder
 *      is fixed, the bucket for a given window is the same on every request, so
 *      chart points do not jitter between polls.
 *   3. `received_at` is the window clock, matching `samplesLastMinute` and the
 *      status ladder. A device with a drifting clock still appears where the
 *      server saw it.
 */

import type Database from "better-sqlite3";

import {
  EVENT_LIMIT,
  getRobot,
  listBuckets,
  listEvents,
  readWindowStats,
  type EventRow,
  type RobotRow,
  type WindowStats,
} from "../db/telemetry";
import { deriveStatus, type RobotStatus, type StatusThresholds } from "../telemetry/status";

/** The window sizes the detail screen can request, in milliseconds. */
export const WINDOW_ALLOWLIST = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
} as const;

export type WindowName = keyof typeof WINDOW_ALLOWLIST;

export const WINDOW_NAMES = Object.keys(WINDOW_ALLOWLIST) as WindowName[];

/** What the detail screen opens with. PLAN §5 documents 15 m → ~5 s buckets. */
export const DEFAULT_WINDOW: WindowName = "15m";

/**
 * Bucket sizes in milliseconds, smallest first. The smallest one that fits the
 * window in `MAX_POINTS` wins, so 15 m lands on 5 s — the value PLAN §5 prints —
 * and 24 h lands on 10 m.
 */
export const BUCKET_LADDER = [
  500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
] as const;

/**
 * Target resolution: the largest a series may be is `MAX_POINTS` intervals.
 *
 * Buckets are epoch-aligned and the range is inclusive at both ends, so a
 * window that is an exact multiple of the bucket (`15m` at `5s`) can produce one
 * extra bucket: 181 points, not 180. That is the documented worst case.
 */
export const MAX_POINTS = 180;

/** One chart point. Battery and charging drive the chart, speed the tooltip. */
export interface HistoryPoint {
  t: number;
  battery: number;
  speed: number;
  charging: boolean;
}

/** One trail vertex: the bucket's mean position. */
export interface TrailPoint {
  t: number;
  x: number;
  y: number;
}

/** The window the server actually applied, echoed so the UI need not re-derive it. */
export interface AppliedWindow {
  requested: WindowName;
  ms: number;
  bucketMs: number;
  from: number;
  to: number;
}

/** Metadata, exactly as the fleet list presents it. */
export interface RobotSummary {
  id: string;
  name: string;
  siteId: string;
  model: string;
}

/** Current state: the read model plus the derived status and age. */
export interface RobotState {
  status: RobotStatus;
  battery: number;
  charging: boolean;
  motion: RobotRow["motion"];
  x: number;
  y: number;
  heading: number;
  speed: number;
  errorCode: string | null;
  seq: number;
  deviceTs: number;
  receivedAt: number;
  ageMs: number;
}

/** 200 body. */
export interface RobotResponseBody {
  generatedAt: number;
  window: AppliedWindow;
  thresholds: StatusThresholds;
  robot: RobotSummary;
  state: RobotState;
  history: HistoryPoint[];
  trail: TrailPoint[];
  events: EventRow[];
  stats: WindowStats;
}

export interface RobotDeps {
  readonly db: Database.Database;
  readonly thresholds: StatusThresholds;
  /** Server clock in epoch ms: one value for the window, the state and the events. */
  readonly now: number;
}

const WINDOW_SET: ReadonlySet<string> = new Set(WINDOW_NAMES);

function isWindowName(value: string): value is WindowName {
  return WINDOW_SET.has(value);
}

/** Same rule as the fleet read: a blank parameter means "not set". */
function cleanParam(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Smallest ladder bucket that keeps `windowMs` within `MAX_POINTS` intervals. */
export function bucketFor(windowMs: number): number {
  for (const bucket of BUCKET_LADDER) {
    if (Math.ceil(windowMs / bucket) <= MAX_POINTS) return bucket;
  }
  // Unreachable with the allowlist; kept so a future window cannot silently
  // produce thousands of points.
  return BUCKET_LADDER[BUCKET_LADDER.length - 1]!;
}

function invalidWindow(value: string): Response {
  return Response.json(
    {
      error: {
        code: "invalid_query",
        message: `Unknown window ${JSON.stringify(value)}: expected one of ${WINDOW_NAMES.join(", ")}.`,
        details: { parameter: "window", allowed: WINDOW_NAMES },
      },
    },
    { status: 400 },
  );
}

/**
 * 404 rather than 200-with-nulls: existence is what the read model says, the
 * same rule the fleet list follows. A curated `robots` row with no telemetry yet
 * is a robot the screen has nothing to show for.
 */
function robotNotFound(robotId: string): Response {
  return Response.json(
    {
      error: {
        code: "robot_not_found",
        message: `No robot ${JSON.stringify(robotId)} has reported.`,
      },
    },
    { status: 404 },
  );
}

export function handleRobot(request: Request, robotId: string, deps: RobotDeps): Response {
  const { db, thresholds, now } = deps;
  const params = new URL(request.url).searchParams;

  const requested = cleanParam(params.get("window")) ?? DEFAULT_WINDOW;
  if (!isWindowName(requested)) return invalidWindow(requested);

  const windowMs = WINDOW_ALLOWLIST[requested];
  const bucketMs = bucketFor(windowMs);
  const range = { robotId, bucketMs, from: now - windowMs, to: now };

  const row = getRobot(db, robotId);
  if (row === null) return robotNotFound(robotId);

  // One query feeds both the chart and the map: at this resolution they are the
  // same points, and two queries would be two chances to disagree.
  const buckets = listBuckets(db, range);

  const body: RobotResponseBody = {
    generatedAt: now,
    window: { requested, ms: windowMs, bucketMs, from: range.from, to: range.to },
    thresholds,
    robot: { id: row.robotId, name: row.name, siteId: row.siteId, model: row.model },
    state: {
      status: deriveStatus(row, now, thresholds),
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
    },
    history: buckets.map(({ t, battery, speed, charging }) => ({ t, battery, speed, charging })),
    trail: buckets.map(({ t, x, y }) => ({ t, x, y })),
    events: listEvents(db, { ...range, offlineAfterMs: thresholds.offlineAfterMs, limit: EVENT_LIMIT }),
    stats: readWindowStats(db, { ...range, offlineAfterMs: thresholds.offlineAfterMs }),
  };

  return Response.json(body);
}
