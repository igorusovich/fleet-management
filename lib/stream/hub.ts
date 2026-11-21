/**
 * One fleet snapshot per tick, shared by every open stream.
 *
 * The stream ticks once a second and would otherwise rebuild the same snapshot
 * once per connection. The hub keeps the last body for one tick interval, so ten
 * tabs cost one query per second rather than ten.
 *
 * The cache is time-based rather than event-based because status is derived from
 * `now - receivedAt`: with no writes, the clock alone still changes what the
 * fleet looks like. A publish-on-write cache would serve a frozen snapshot
 * exactly when the fleet starts dying.
 *
 * Server-only: `buildFleetSnapshot` reads SQLite.
 */

import { config } from "../config";
import { getDb } from "../db/client";
import { buildFleetSnapshot, type FleetResponseBody } from "../http/fleet";

/** Default snapshot lifetime: one frame interval. */
export const HUB_TICK_MS = 1_000;

export interface FleetHub {
  /** How long a snapshot stays fresh. */
  readonly tickMs: number;
  /** The current snapshot, rebuilt when the cached one is older than `tickMs`. */
  snapshot(): FleetResponseBody;
  /** Drop the cache so the next read reflects a write that just landed. */
  invalidate(): void;
}

export interface FleetHubOptions {
  readonly build: () => FleetResponseBody;
  readonly tickMs?: number;
  /** Injected so tests can move time without sleeping. */
  readonly now?: () => number;
}

export function createFleetHub(options: FleetHubOptions): FleetHub {
  const { build, tickMs = HUB_TICK_MS, now = Date.now } = options;

  let cached: FleetResponseBody | undefined;
  let cachedAt = 0;

  return {
    tickMs,

    snapshot(): FleetResponseBody {
      const at = now();
      // `at >= cachedAt` guards a clock that jumped backwards: a stale-but-future
      // timestamp must not keep a snapshot alive indefinitely.
      if (cached !== undefined && at >= cachedAt && at - cachedAt < tickMs) {
        return cached;
      }
      cached = build();
      cachedAt = at;
      return cached;
    },

    invalidate(): void {
      cached = undefined;
    },
  };
}

interface HubScope {
  fleetHub?: FleetHub;
}

const scope = globalThis as HubScope;

/**
 * The process-wide hub, built on first use.
 *
 * Cached on `globalThis` for the same reason as `getDb`: the dev server
 * re-evaluates modules on hot reload, and a module-level singleton would leak a
 * second hub per reload.
 */
export function getFleetHub(): FleetHub {
  const existing = scope.fleetHub;
  if (existing) return existing;

  const hub = createFleetHub({
    build: () =>
      buildFleetSnapshot({
        db: getDb(),
        thresholds: config.thresholds,
        now: Date.now(),
      }),
    tickMs: HUB_TICK_MS,
  });

  scope.fleetHub = hub;
  return hub;
}

/** Forget the shared hub. Used by tests. */
export function closeFleetHub(): void {
  delete scope.fleetHub;
}
