/**
 * The robot fleet model: pure, deterministic, no clock and no socket.
 *
 * Time is a parameter (`dtSeconds`) rather than something read from the wall, so
 * the same seed replays the same fleet and the gate can advance ten thousand
 * ticks in milliseconds. Only the CLI reads the clock, and only to stamp `ts`
 * and to pace the loop.
 *
 * The point of the model is reachability, not realism: every status the server
 * derives must actually occur. Waypoints give `moving`/`idle`, the dock cycle
 * gives `low_battery`/`charging`, fault episodes give `fault`, and the CLI's drop
 * rate gives `delayed`/`offline` for free.
 *
 * Imports the wire contract and nothing else — no database, no `next/*`, no
 * `process` — so it can be tested and reasoned about on its own.
 */

import type { MotionState, TelemetryReport } from "../lib/telemetry/schema";
import { normaliseHeading } from "../lib/telemetry/schema";

/** Uniform [0, 1). */
export type Random = () => number;

/** Waypoints are drawn inside this square of site-local metres. */
export const WAYPOINT_BOUNDS_M = 40;
export const SPEED_MIN_MS = 0.5;
export const SPEED_MAX_MS = 1.4;
export const ARRIVE_RADIUS_M = 0.25;
export const DOCK_RADIUS_M = 0.4;

/** Battery cost per metre travelled — PLAN's "drain proportional to speed". */
export const DRAIN_PCT_PER_M = 0.03;
/** Charge rate while docked; 18 % → 95 % takes about 2.5 minutes. */
export const CHARGE_PCT_PER_S = 0.5;
/** Dock below this, leave at `RESUME_AT_PCT`. PLAN §6, with hysteresis. */
export const DOCK_AT_PCT = 18;
export const RESUME_AT_PCT = 95;

export const INITIAL_BATTERY_MIN = 55;
export const INITIAL_BATTERY_MAX = 95;

/** Per robot per tick: about one episode every eight minutes. */
export const FAULT_RATE = 0.002;
export const FAULT_MIN_TICKS = 3;
export const FAULT_MAX_TICKS = 8;
export const FAULT_CODES = ["E_STUCK", "E_LIDAR", "E_WHEEL_SLIP"] as const;

/** Longest pause once a waypoint is reached. */
export const IDLE_MAX_TICKS = 3;

export type RobotMode = "cruising" | "idle" | "returning" | "charging";

export interface Robot {
  readonly id: string;
  /**
   * This robot's private stream of randomness. Mutated in place by every call,
   * which is what makes a seed reproduce a whole run.
   */
  readonly random: Random;
  /** Reports produced so far; the server's idempotency key is (id, seq). */
  seq: number;
  mode: RobotMode;
  battery: number;
  x: number;
  y: number;
  /** Degrees, always normalised into [0, 360). */
  heading: number;
  speed: number;
  targetX: number;
  targetY: number;
  idleTicks: number;
  faultCode: string | null;
  faultTicks: number;
}

export interface AdvanceOptions {
  /** Override the fault chance; the gate pins it to 0 for dock and fault tests. */
  readonly faultRate?: number;
}

/** mulberry32: twelve lines, no dependency, good enough for a demo fleet. */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive one robot's seed from the fleet seed and its id (FNV-1a).
 *
 * Robot 7's behaviour then does not change when the fleet grows, so a test can
 * assert a single robot without simulating the other nineteen.
 */
export function robotSeed(seed: number, id: string): number {
  let hash = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export interface FleetOptions {
  readonly robots: number;
  readonly seed?: number;
  readonly prefix?: string;
}

export function createFleet(options: FleetOptions): Robot[] {
  const seed = options.seed ?? 42;
  const prefix = options.prefix ?? "RBT";
  const fleet: Robot[] = [];

  for (let index = 0; index < options.robots; index += 1) {
    const id = `${prefix}-${String(index + 1).padStart(3, "0")}`;
    const random = createRandom(robotSeed(seed, id));

    const robot: Robot = {
      id,
      random,
      seq: 0,
      mode: "cruising",
      battery: INITIAL_BATTERY_MIN + random() * (INITIAL_BATTERY_MAX - INITIAL_BATTERY_MIN),
      x: (random() * 2 - 1) * WAYPOINT_BOUNDS_M * 0.8,
      y: (random() * 2 - 1) * WAYPOINT_BOUNDS_M * 0.8,
      heading: random() * 360,
      speed: SPEED_MIN_MS + random() * (SPEED_MAX_MS - SPEED_MIN_MS),
      targetX: 0,
      targetY: 0,
      idleTicks: 0,
      faultCode: null,
      faultTicks: 0,
    };

    pickWaypoint(robot);
    fleet.push(robot);
  }

  return fleet;
}

function pickWaypoint(robot: Robot): void {
  robot.targetX = (robot.random() * 2 - 1) * WAYPOINT_BOUNDS_M * 0.9;
  robot.targetY = (robot.random() * 2 - 1) * WAYPOINT_BOUNDS_M * 0.9;
}

/**
 * Move at most `speed * dtSeconds` toward a point. Returns the distance actually
 * covered, which is what the battery has to pay for.
 */
function moveToward(robot: Robot, targetX: number, targetY: number, dtSeconds: number): number {
  const dx = targetX - robot.x;
  const dy = targetY - robot.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    robot.speed = 0;
    return 0;
  }

  const step = Math.min(distance, robot.speed * dtSeconds);
  robot.x += (dx / distance) * step;
  robot.y += (dy / distance) * step;
  robot.heading = normaliseHeading((Math.atan2(dy, dx) * 180) / Math.PI);
  return step;
}

function drainFor(robot: Robot, metres: number): void {
  robot.battery = Math.max(0, robot.battery - metres * DRAIN_PCT_PER_M);
}

function rollSpeed(robot: Robot): void {
  robot.speed = SPEED_MIN_MS + robot.random() * (SPEED_MAX_MS - SPEED_MIN_MS);
}

/**
 * Advance one robot by `dtSeconds` and bump its seq.
 *
 * Mutates in place and returns the robot: the fleet is a long-lived simulation,
 * not a value, and this keeps the per-second work allocation-free.
 *
 * Order matters: a fault episode blocks movement for its whole length, charging
 * never faults, and a low battery is checked before a new waypoint is chosen so a
 * robot never starts a fresh trip it cannot finish.
 */
export function advanceRobot(robot: Robot, dtSeconds: number, options: AdvanceOptions = {}): Robot {
  robot.seq += 1;

  const faultRate = options.faultRate ?? FAULT_RATE;
  const rng = robot.random;

  // Inject a new episode, then fall straight into the episode handling below so
  // the injection tick counts as the first tick of the fault.
  if (robot.faultCode === null && robot.mode !== "charging" && rng() < faultRate) {
    robot.faultCode = FAULT_CODES[Math.floor(rng() * FAULT_CODES.length)] ?? FAULT_CODES[0];
    robot.faultTicks = FAULT_MIN_TICKS + Math.floor(rng() * (FAULT_MAX_TICKS - FAULT_MIN_TICKS + 1));
  }

  if (robot.faultCode !== null) {
    if (robot.faultTicks <= 0) {
      // The episode is over: clear it and let the robot resume this same tick.
      robot.faultCode = null;
    } else {
      robot.faultTicks -= 1;
      robot.speed = 0;
      return robot;
    }
  }

  if (robot.mode === "charging") {
    robot.speed = 0;
    robot.battery = Math.min(100, robot.battery + CHARGE_PCT_PER_S * dtSeconds);
    if (robot.battery >= RESUME_AT_PCT) {
      robot.mode = "cruising";
      pickWaypoint(robot);
    }
    return robot;
  }

  if (robot.mode === "returning") {
    if (Math.hypot(robot.x, robot.y) <= DOCK_RADIUS_M) {
      robot.x = 0;
      robot.y = 0;
      robot.speed = 0;
      robot.mode = "charging";
      return robot;
    }
    rollSpeed(robot);
    drainFor(robot, moveToward(robot, 0, 0, dtSeconds));
    return robot;
  }

  if (robot.battery < DOCK_AT_PCT) {
    robot.mode = "returning";
    robot.speed = 0;
    return robot;
  }

  if (robot.mode === "idle") {
    robot.speed = 0;
    robot.idleTicks -= 1;
    if (robot.idleTicks <= 0) {
      robot.mode = "cruising";
      pickWaypoint(robot);
    }
    return robot;
  }

  rollSpeed(robot);
  if (Math.hypot(robot.targetX - robot.x, robot.targetY - robot.y) <= ARRIVE_RADIUS_M) {
    robot.mode = "idle";
    robot.speed = 0;
    robot.idleTicks = Math.floor(rng() * (IDLE_MAX_TICKS + 1));
    return robot;
  }

  drainFor(robot, moveToward(robot, robot.targetX, robot.targetY, dtSeconds));
  return robot;
}

/** Internal mode plus fault overlay, collapsed into the wire's four values. */
export function motionOf(robot: Robot): MotionState {
  if (robot.faultCode !== null) return "error";
  if (robot.mode === "charging") return "charging";
  if (robot.mode === "idle") return "idle";
  return "moving";
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The report this robot would send right now. */
export function toReport(robot: Robot, ts: number): TelemetryReport {
  const motion = motionOf(robot);

  return {
    robotId: robot.id,
    seq: robot.seq,
    ts,
    battery: round(Math.min(100, Math.max(0, robot.battery)), 1),
    charging: motion === "charging",
    motion,
    x: round(robot.x, 2),
    y: round(robot.y, 2),
    heading: round(normaliseHeading(robot.heading), 1),
    // A stationary robot must not claim a speed: the fleet screen shows it.
    speed: motion === "moving" ? round(robot.speed, 1) : 0,
    errorCode: robot.faultCode,
  };
}

export interface TickOptions {
  readonly dtSeconds: number;
  /** The server clock, stamped into every report in this tick. */
  readonly now: number;
  /** Fraction of reports to omit; 0.02 by default in the CLI. */
  readonly dropRate?: number;
  readonly random?: Random;
}

export interface TickResult {
  readonly reports: TelemetryReport[];
  readonly dropped: number;
}

/**
 * Advance the whole fleet and build one batch.
 *
 * A dropped report is a *gap*: the robot advanced and its seq moved, the report
 * simply never reaches the server. Retrying it would produce a duplicate and hide
 * the loss, which is the opposite of what the drop rate is for.
 */
export function tickFleet(fleet: readonly Robot[], options: TickOptions): TickResult {
  const { dtSeconds, now, dropRate = 0, random = Math.random } = options;
  const reports: TelemetryReport[] = [];
  let dropped = 0;

  for (const robot of fleet) {
    advanceRobot(robot, dtSeconds);
    if (random() < dropRate) {
      dropped += 1;
      continue;
    }
    reports.push(toReport(robot, now));
  }

  return { reports, dropped };
}
