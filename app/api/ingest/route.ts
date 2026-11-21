/**
 * `POST /api/ingest` — the one door telemetry comes in through.
 *
 * Adapter only: resolve the shared database, the configured key and the clock,
 * then delegate. All decisions live in `lib/http/ingest.ts`, which is why the
 * gate can test them without this file or a dev server.
 *
 * No route segment config here: `cacheComponents` is enabled and Next rejects
 * any `runtime` export, including `runtime = "nodejs"`. Route handlers are
 * uncached by default, and unsupported methods already answer 405.
 */

import { config } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { handleIngest } from "@/lib/http/ingest";

export async function POST(request: Request): Promise<Response> {
  return handleIngest(request, {
    db: getDb(),
    expectedKey: config.ingestApiKey,
    now: Date.now(),
  });
}
