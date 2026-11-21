/**
 * `GET /api/stream` — the fleet screen's live feed.
 *
 * Adapter only: resolve the shared hub and the clock, then delegate. Frame
 * decisions live in `lib/http/stream.ts`, which is why the gate reads whole
 * frames without booting a server.
 *
 * No route segment config: `cacheComponents` is enabled and Next rejects any
 * `runtime` export. A route handler may return a raw `ReadableStream`, and the
 * status line is committed with the first chunk — exactly what SSE needs.
 */

import { getFleetHub } from "@/lib/stream/hub";
import { handleStream } from "@/lib/http/stream";

export function GET(request: Request): Response {
  return handleStream(request, {
    hub: getFleetHub(),
    now: () => Date.now(),
  });
}
