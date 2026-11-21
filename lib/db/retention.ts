/**
 * Retention: delete telemetry older than `RETENTION_HOURS`.
 *
 * Only `telemetry` is swept. `robot_latest` and `robots` are the fleet's memory
 * of what exists and where it was last seen, so a robot that has been gone for a
 * week still appears in the fleet — offline, with no history left to chart.
 *
 * The delete runs on accepted ingest rather than on a timer: there is nothing to
 * expire if nothing is arriving, and a per-process interval is exactly the kind
 * of module state that leaks across HMR reloads. A 60 s throttle keeps the cost
 * off the hot path; the statement rides the `telemetry_received` index added in
 * migration 3.
 */

import type Database from "better-sqlite3";

import { config } from "../config";
import { getDb } from "./client";

/** How often a sweep may run, however many batches arrive in between. */
export const SWEEP_INTERVAL_MS = 60_000;

const HOUR_MS = 3_600_000;

export interface SweepResult {
  /** Rows removed from `telemetry`. */
  readonly deleted: number;
  /** Everything with `received_at < cutoff` is gone. Strict: a row exactly at the cutoff stays. */
  readonly cutoff: number;
}

/**
 * Delete expired history. Exported separately from the sweeper so tests can pin
 * `now` and assert the boundary without a clock or a throttle.
 */
export function sweepTelemetry(
  db: Database.Database,
  options: { now: number; retentionHours: number },
): SweepResult {
  const cutoff = options.now - Math.round(options.retentionHours * HOUR_MS);
  const info = db.prepare("DELETE FROM telemetry WHERE received_at < ?").run(cutoff);

  return { deleted: info.changes, cutoff };
}

export interface RetentionSweeper {
  /** Sweep if the throttle allows it; `null` means this call was skipped. */
  run(now: number): SweepResult | null;
}

export interface SweeperOptions {
  readonly db: Database.Database;
  readonly retentionHours: number;
  readonly minIntervalMs?: number;
  /** One line per sweep that actually deleted something. Silent by default in tests. */
  readonly log?: (line: string) => void;
}

export function createRetentionSweeper({
  db,
  retentionHours,
  minIntervalMs = SWEEP_INTERVAL_MS,
  log = (line) => console.info(line),
}: SweeperOptions): RetentionSweeper {
  let lastRun: number | null = null;

  return {
    run(now) {
      if (lastRun !== null && now - lastRun < minIntervalMs) return null;
      lastRun = now;

      const startedAt = performance.now();
      const result = sweepTelemetry(db, { now, retentionHours });
      if (result.deleted > 0) {
        log(
          `retention deleted=${result.deleted} cutoff=${result.cutoff}` +
            ` ms=${Math.round(performance.now() - startedAt)}`,
        );
      }

      return result;
    },
  };
}

interface SweeperScope {
  fleetRetentionSweeper?: RetentionSweeper;
}

const scope = globalThis as SweeperScope;

/**
 * The process-wide sweeper, cached like `getDb()` so a dev reload does not
 * reset the throttle and sweep on every request.
 */
export function getRetentionSweeper(): RetentionSweeper {
  if (scope.fleetRetentionSweeper === undefined) {
    scope.fleetRetentionSweeper = createRetentionSweeper({
      db: getDb(),
      retentionHours: config.retentionHours,
    });
  }

  return scope.fleetRetentionSweeper;
}
