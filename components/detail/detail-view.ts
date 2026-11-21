/**
 * Everything the robot detail screen decides for itself, as pure functions.
 *
 * The payload is the source of truth: state, history, trail, events, stats and
 * the applied window all arrive in one response, and nothing here recomputes a
 * status. What is local is geometry — where a bucket sits on the chart, which
 * points belong to the same line, when a charge period starts — plus formatting.
 *
 * Two rules worth knowing:
 *   1. A missing bucket is a hole, not an interpolation. Points are split into
 *      segments when the gap between them exceeds one and a half buckets (and at
 *      least the offline threshold), so a 20 s silence is drawn as a break
 *      instead of a straight line across it.
 *   2. Every scale guards a zero-span domain. One point, or a robot that has not
 *      moved, is normal — a chart that divides by zero would take the page down.
 *
 * Server-only types come in with `import type`, so nothing from `lib/http` (or
 * the SQLite driver behind it) reaches the browser bundle.
 */

import type {
  AppliedWindow,
  HistoryPoint,
  RobotResponseBody,
  WindowName,
} from "@/lib/http/robot";
import type { StatusThresholds } from "@/lib/telemetry/status";

/** One derived edge event, exactly as the API lists it. */
export type RobotEvent = RobotResponseBody["events"][number];

/** The windows the screen offers. The API allows six; PLAN §7 names these three. */
export const WINDOW_CHOICES = ["5m", "15m", "1h"] as const satisfies readonly WindowName[];

export type WindowChoice = (typeof WINDOW_CHOICES)[number];

/** PLAN §5's default, and the window whose 5 s buckets the API documents. */
export const DEFAULT_CHOICE: WindowChoice = "15m";

const WINDOW_LABELS: Record<WindowName, string> = {
  "1m": "1 min",
  "5m": "5 min",
  "15m": "15 min",
  "1h": "1 hour",
  "6h": "6 hours",
  "24h": "24 hours",
};

export function formatWindow(name: WindowName): string {
  return WINDOW_LABELS[name];
}

export interface Box {
  readonly width: number;
  readonly height: number;
  readonly padX: number;
  readonly padTop: number;
  readonly padBottom: number;
}

/** Chart geometry in viewBox units; the SVG scales as a unit, text included. */
export const BATTERY_BOX: Box = {
  width: 720,
  height: 180,
  padX: 10,
  padTop: 14,
  padBottom: 24,
};

export const TRAIL_BOX: Box = {
  width: 360,
  height: 240,
  padX: 16,
  padTop: 16,
  padBottom: 16,
};

/**
 * A linear map from a domain to a range. A zero-span domain (one point, no
 * movement) maps everything to the middle of the range instead of dividing by
 * zero — the chart then draws a single dot, which is the truth.
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (value: number) => number {
  const [domainFrom, domainTo] = domain;
  const [rangeFrom, rangeTo] = range;
  const span = domainTo - domainFrom;
  const middle = (rangeFrom + rangeTo) / 2;

  if (span === 0) return () => middle;

  return (value) => rangeFrom + ((value - domainFrom) / span) * (rangeTo - rangeFrom);
}

/** Time → x, across the window the server actually applied. */
export function chartX(scope: AppliedWindow, box: Box = BATTERY_BOX): (t: number) => number {
  return linearScale([scope.from, scope.to], [box.padX, box.width - box.padX]);
}

/** Battery percent → y, inverted so 100 % is at the top. */
export function valueY(box: Box = BATTERY_BOX): (value: number) => number {
  return linearScale([0, 100], [box.height - box.padBottom, box.padTop]);
}

/**
 * The gap that breaks a line.
 *
 * `offlineAfterMs` alone is wrong once buckets get coarse: at the 1 h window the
 * buckets are 30 s apart, and every pair of adjacent points would look like a
 * 30 s silence. One and a half buckets keeps neighbours connected while a
 * skipped bucket still splits, and the offline threshold keeps the 5 s window
 * honest (a 10 s silence is a real gap, not one missing sample).
 */
export function maxGapMs(bucketMs: number, offlineAfterMs: number): number {
  return Math.max(offlineAfterMs, Math.round(bucketMs * 1.5));
}

/** Split an ascending series wherever the silence exceeds `maxGapMs`. */
export function splitAtGaps<T extends { readonly t: number }>(
  points: readonly T[],
  maxGapMs: number,
): T[][] {
  const runs: T[][] = [];
  let run: T[] = [];

  for (const point of points) {
    const previous = run[run.length - 1];
    if (previous !== undefined && point.t - previous.t > maxGapMs) {
      runs.push(run);
      run = [];
    }
    run.push(point);
  }

  if (run.length > 0) runs.push(run);
  return runs;
}

export interface PlottedPoint {
  readonly x: number;
  readonly y: number;
}

export interface BatteryPlot {
  /** One array per continuous stretch; more than one means a gap was bridged. */
  readonly segments: PlottedPoint[][];
  readonly empty: boolean;
}

export function batteryPoints(
  history: readonly HistoryPoint[],
  scope: AppliedWindow,
  thresholds: StatusThresholds,
  box: Box = BATTERY_BOX,
): BatteryPlot {
  if (history.length === 0) return { segments: [], empty: true };

  const x = chartX(scope, box);
  const y = valueY(box);
  const runs = splitAtGaps(history, maxGapMs(scope.bucketMs, thresholds.offlineAfterMs));

  return {
    segments: runs.map((run) => run.map((point) => ({ x: x(point.t), y: y(point.battery) }))),
    empty: false,
  };
}

export interface ChargeSpan {
  readonly x: number;
  readonly width: number;
}

/**
 * Contiguous charging buckets as shaded bands.
 *
 * A bucket is one bucket wide at most: if the next point is missing, the band
 * ends where the bucket does rather than claiming a charge across the silence.
 */
export function chargeSpans(
  history: readonly HistoryPoint[],
  scope: AppliedWindow,
  box: Box = BATTERY_BOX,
): ChargeSpan[] {
  const x = chartX(scope, box);
  const spans: ChargeSpan[] = [];
  let from: number | null = null;
  let to = 0;

  const flush = () => {
    if (from === null) return;
    spans.push({ x: x(from), width: Math.max(1, x(to) - x(from)) });
    from = null;
  };

  for (const point of history) {
    if (!point.charging) {
      flush();
      continue;
    }

    const start = point.t;
    const end = Math.min(point.t + scope.bucketMs, scope.to);

    if (from !== null && start <= to) {
      to = Math.max(to, end);
    } else {
      flush();
      from = start;
      to = end;
    }
  }

  flush();
  return spans;
}

/** Where the low-battery line sits. */
export function thresholdY(pct: number, box: Box = BATTERY_BOX): number {
  return valueY(box)(pct);
}

export interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * Map bounds, padded by 10 % and never narrower than `minSpan` metres on either
 * axis. Without the floor a parked robot would be drawn as one pixel scaled to
 * the size of a building.
 */
export function trailBounds(
  points: readonly { readonly x: number; readonly y: number }[],
  minSpan = 20,
): Bounds {
  let rawMinX = Infinity;
  let rawMaxX = -Infinity;
  let rawMinY = Infinity;
  let rawMaxY = -Infinity;

  for (const point of points) {
    rawMinX = Math.min(rawMinX, point.x);
    rawMaxX = Math.max(rawMaxX, point.x);
    rawMinY = Math.min(rawMinY, point.y);
    rawMaxY = Math.max(rawMaxY, point.y);
  }

  if (!Number.isFinite(rawMinX)) {
    rawMinX = 0;
    rawMaxX = 0;
    rawMinY = 0;
    rawMaxY = 0;
  }

  const padX = Math.max((rawMaxX - rawMinX) * 0.1, 1);
  const padY = Math.max((rawMaxY - rawMinY) * 0.1, 1);

  const widen = (min: number, max: number): readonly [number, number] => {
    const centre = (min + max) / 2;
    const half = Math.max((max - min) / 2, minSpan / 2);
    return [centre - half, centre + half];
  };

  const [minX, maxX] = widen(rawMinX - padX, rawMaxX + padX);
  const [minY, maxY] = widen(rawMinY - padY, rawMaxY + padY);

  return { minX, maxX, minY, maxY };
}

/** Metres → viewBox, with north up (the y axis is flipped). */
export function projectPoint(
  point: { readonly x: number; readonly y: number },
  bounds: Bounds,
  box: Box = TRAIL_BOX,
): PlottedPoint {
  const x = linearScale([bounds.minX, bounds.maxX], [box.padX, box.width - box.padX]);
  const y = linearScale([bounds.minY, bounds.maxY], [box.height - box.padBottom, box.padTop]);
  return { x: x(point.x), y: y(point.y) };
}

export function projectTrail(
  points: readonly { readonly x: number; readonly y: number }[],
  bounds: Bounds,
  box: Box = TRAIL_BOX,
): PlottedPoint[] {
  const x = linearScale([bounds.minX, bounds.maxX], [box.padX, box.width - box.padX]);
  const y = linearScale([bounds.minY, bounds.maxY], [box.height - box.padBottom, box.padTop]);
  return points.map((point) => ({ x: x(point.x), y: y(point.y) }));
}

const GRID_STEPS = [5, 10, 20, 25, 50, 100, 200, 500] as const;

/** A round metre step that yields roughly five grid lines. */
export function gridStep(bounds: Bounds): number {
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const target = span / 5;
  return GRID_STEPS.find((step) => step >= target) ?? 1_000;
}

/**
 * The y-axis maximum for the speed sparkline. Floored at 1 m/s: an idle robot
 * should read as a flat baseline, not as a zero-height line.
 */
export function speedMax(history: readonly { readonly speed: number }[]): number {
  const peak = history.reduce((max, point) => Math.max(max, point.speed), 0);
  return Math.max(1, peak);
}

/** Metres as a human reads them: `0.4 m`, `412 m`, `1.2 km`, `12 km`. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1_000) return `${meters < 10 ? meters.toFixed(1) : Math.round(meters)} m`;

  const km = meters / 1_000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** `91° E` — the bearing normalised, rounded, and named. */
export function formatHeading(degrees: number): string {
  const normal = ((degrees % 360) + 360) % 360;
  const index = Math.round(normal / 45) % COMPASS.length;
  return `${Math.round(normal)}° ${COMPASS[index] ?? "N"}`;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** `HH:MM`, for chart edges. */
export function formatClock(t: number): string {
  const date = new Date(t);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** `HH:MM:SS`, for the event log. */
export function formatEventTime(t: number): string {
  const date = new Date(t);
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

export function eventLabel(kind: RobotEvent["kind"]): string {
  switch (kind) {
    case "fault":
      return "Fault";
    case "charge_start":
      return "Charging started";
    case "comms_gap":
      return "Comms gap";
    default:
      return "Event";
  }
}

/** One colour per kind, from the app's theme tokens. */
export function eventTone(kind: RobotEvent["kind"]): string {
  switch (kind) {
    case "fault":
      return "var(--color-bad)";
    case "charge_start":
      return "var(--color-ok)";
    default:
      return "var(--color-warn)";
  }
}
