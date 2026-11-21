/**
 * Everything the fleet screen decides for itself, as pure functions.
 *
 * The frame is the source of truth: status, summary and thresholds are read from
 * it, never recomputed here. What *is* local is presentation — which robots the
 * user asked for, in what order, and how an age reads. Keeping that out of the
 * component is what makes the sort rule testable without a DOM.
 *
 * Server-only types are imported with `import type`, so nothing from `lib/http`
 * (or the SQLite driver behind it) reaches the browser bundle.
 */

import type { FleetRobot } from "@/lib/http/fleet";
import type { RobotStatus } from "@/lib/telemetry/status";

/** Most urgent first. This order is the default sort and the chip order. */
export const STATUS_ORDER = [
  "offline",
  "fault",
  "low_battery",
  "delayed",
  "charging",
  "moving",
  "idle",
] as const satisfies readonly RobotStatus[];

/** `all` is the empty filter, not a status. */
export type StatusFilter = RobotStatus | "all";

export type SortOrder = "severity" | "battery" | "id";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortOrder; label: string }> = [
  { value: "severity", label: "Status severity" },
  { value: "battery", label: "Battery (low first)" },
  { value: "id", label: "Robot id" },
];

export interface FleetFilters {
  readonly query?: string;
  readonly status?: StatusFilter;
}

/** Rank in the severity order; 0 is the most urgent. */
export function statusSeverity(status: RobotStatus): number {
  return STATUS_ORDER.indexOf(status);
}

/** Human label for a status, e.g. `low_battery` → `low battery`. */
export function statusLabel(status: RobotStatus): string {
  return status === "low_battery" ? "low battery" : status;
}

function matches(robot: FleetRobot, needle: string): boolean {
  return (
    robot.id.toLowerCase().includes(needle) || robot.name.toLowerCase().includes(needle)
  );
}

/**
 * Search and status filters, ANDed. Blank query and `all` are no-ops, so the
 * unfiltered screen is the same code path as a filtered one.
 */
export function filterRobots(
  robots: readonly FleetRobot[],
  filters: FleetFilters = {},
): FleetRobot[] {
  const needle = (filters.query ?? "").trim().toLowerCase();
  const status = filters.status ?? "all";

  return robots.filter((robot) => {
    if (status !== "all" && robot.status !== status) return false;
    if (needle === "") return true;
    return matches(robot, needle);
  });
}

/**
 * A total, stable order, so two frames with the same statuses never swap cards.
 * Severity ties break on battery ascending, then id.
 */
export function sortRobots(robots: readonly FleetRobot[], order: SortOrder): FleetRobot[] {
  const sorted = [...robots];

  if (order === "battery") {
    sorted.sort((a, b) => a.battery - b.battery || a.id.localeCompare(b.id));
    return sorted;
  }

  if (order === "id") {
    sorted.sort((a, b) => a.id.localeCompare(b.id));
    return sorted;
  }

  sorted.sort(
    (a, b) =>
      statusSeverity(a.status) - statusSeverity(b.status) ||
      a.battery - b.battery ||
      a.id.localeCompare(b.id),
  );
  return sorted;
}

/** `now - receivedAt`, clamped so a server clock behind the device cannot go negative. */
export function ageOf(robot: Pick<FleetRobot, "receivedAt">, now: number): number {
  return Math.max(0, now - robot.receivedAt);
}

/** Coarse, human age: `just now`, `3s ago`, `1m 4s ago`, `1h 1m ago`. */
export function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));

  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m ago` : `${minutes}m ${rest}s ago`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h ago` : `${hours}h ${rest}m ago`;
}

export type BatteryTone = "ok" | "low";

/** The threshold travels in the frame, so the bar cannot disagree with the server. */
export function batteryTone(battery: number, lowBatteryPct: number): BatteryTone {
  return battery < lowBatteryPct ? "low" : "ok";
}
