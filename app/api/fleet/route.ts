/**
 * `GET /api/fleet` — the snapshot the fleet screen polls.
 *
 * Adapter only: resolve the database, the configured thresholds and the clock,
 * then delegate. Filtering decisions live in `lib/http/fleet.ts`, which is why
 * the gate tests them without this file or a dev server.
 *
 * No route segment config: `cacheComponents` is enabled and Next rejects any
 * `runtime` export. Reading `request.url` makes the handler request-time, which
 * is exactly what a live snapshot needs; `GET` handlers are uncached by default
 * and unsupported methods still answer 405.
 */

import { config } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { handleFleet } from "@/lib/http/fleet";

export function GET(request: Request): Response {
  return handleFleet(request, {
    db: getDb(),
    thresholds: config.thresholds,
    now: Date.now(),
  });
}
