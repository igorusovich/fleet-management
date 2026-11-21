/**
 * Operational status — what the fleet manager needs to know, derived from what
 * the robot last said.
 *
 * Pure and time-injected: callers pass `now`, so a stopped simulator flips
 * robots to `offline` with no background sweeper and no writes.
 */

import type { MotionState } from "./schema";

export const ROBOT_STATUSES = [
  "offline",
  "delayed",
  "fault",
  "charging",
  "low_battery",
  "moving",
  "idle",
] as const;

export type RobotStatus = (typeof ROBOT_STATUSES)[number];

/** The minimum a stored "latest" row must expose for status derivation. */
export interface StatusSnapshot {
  /** When the server accepted the report (not the device clock). */
  receivedAt: number;
  battery: number;
  charging: boolean;
  motion: MotionState;
  errorCode: string | null;
}

export interface StatusThresholds {
  offlineAfterMs: number;
  delayedAfterMs: number;
  lowBatteryPct: number;
}

/**
 * First match wins, so the order below is the precedence:
 *
 *   offline → delayed → fault → charging → low_battery → moving → idle
 *
 * Freshness comes first deliberately: a robot that stopped talking is more
 * urgent than anything its last message claimed, so a faulting robot silent for
 * 11 s reads `offline`, not `fault`.
 */
export function deriveStatus(
  snapshot: StatusSnapshot,
  now: number,
  thresholds: StatusThresholds,
): RobotStatus {
  // Clamp: a device clock ahead of the server would otherwise make age negative.
  const ageMs = Math.max(0, now - snapshot.receivedAt);

  if (ageMs > thresholds.offlineAfterMs) return "offline";
  if (ageMs > thresholds.delayedAfterMs) return "delayed";
  if (snapshot.errorCode !== null) return "fault";
  if (snapshot.charging) return "charging";
  if (snapshot.battery < thresholds.lowBatteryPct) return "low_battery";
  if (snapshot.motion === "moving") return "moving";
  return "idle";
}
