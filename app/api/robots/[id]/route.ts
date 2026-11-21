/**
 * `GET /api/robots/:id?window=15m` — everything the detail screen draws.
 *
 * Adapter only: decode the id, resolve the database, thresholds and clock, then
 * delegate. Window rules, bucketing and event derivation live in
 * `lib/http/robot.ts`, which is why the gate tests them without this file or a
 * dev server.
 *
 * `params` is a Promise in this version of Next; `RouteContext` is generated
 * from the route tree (`next typegen` / `next build`), so the id is typed
 * against the actual path rather than a hand-written shape.
 *
 * No route segment config: `cacheComponents` is enabled and Next rejects any
 * `runtime` export. Reading `request.url` and the clock keeps this request-time,
 * which a live window needs.
 */

import { config } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { handleRobot } from "@/lib/http/robot";

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/robots/[id]">,
): Promise<Response> {
  const { id } = await ctx.params;
  return handleRobot(request, id, {
    db: getDb(),
    thresholds: config.thresholds,
    now: Date.now(),
  });
}
