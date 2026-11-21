/**
 * `npm run sim` — the fleet's only writer.
 *
 * This file is the whole I/O surface of the simulator: a clock, a `fetch`, a log
 * line and the exit code. The fleet itself lives in `robot.ts` and knows nothing
 * about either.
 *
 * Pacing is a grid anchored at start (`sleep until start + n·interval`) rather
 * than `sleep(interval)` after each request. That keeps 1 Hz true when a request
 * is slow: a response that overruns its slot makes the loop skip the next slot
 * and say so, instead of firing two batches back to back. One request is in
 * flight at any moment.
 *
 * Failure policy, deliberately split:
 *   401/403  the key is wrong — say so and exit 1. A silently rejected simulator
 *            looks exactly like a broken UI, so this must be loud.
 *   anything else (400, 5xx, network, timeout) — log and keep ticking, so a
 *            restarted server does not require a restarted fleet.
 */

import { parseArgs, usage, type SimConfig } from "./args";
import { createFleet, createRandom, tickFleet } from "./robot";
import type { TelemetryReport } from "../lib/telemetry/schema";

const REQUEST_TIMEOUT_MS = 5_000;

interface IngestResponseBody {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: ReadonlyArray<{ readonly index: number; readonly reason: string }>;
}

interface IngestErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

function log(line: string): void {
  console.log(`[sim] ${line}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function postReports(config: SimConfig, reports: TelemetryReport[]): Promise<Response> {
  return fetch(config.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-key": config.key },
    body: JSON.stringify({ reports }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function run(config: SimConfig): Promise<number> {
  const fleet = createFleet({ robots: config.robots, seed: config.seed });
  const dropRandom = createRandom(config.seed ^ 0x85ebca6b);
  const startedAt = Date.now();

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let tick = 0;
  let ticks = 0;
  let reportCount = 0;
  let accepted = 0;
  let duplicates = 0;
  let rejected = 0;
  let dropped = 0;
  let skipped = 0;
  let failed = 0;
  let exitCode = 0;

  log(
    `fleet ${config.robots} robots · ${config.intervalMs} ms · seed ${config.seed} · ` +
      `drop ${config.dropRate} · ${config.url}`,
  );

  while (!stopping) {
    const due = startedAt + tick * config.intervalMs;
    const late = Date.now() - due;

    // More than a full slot behind: jump to the next future slot and count the
    // misses. Never send two batches back to back to "catch up".
    if (late > config.intervalMs) {
      const missed = Math.floor(late / config.intervalMs);
      tick += missed;
      skipped += missed;
      log(`skipped ${missed} tick(s): ${late - missed * config.intervalMs} ms behind`);
    }

    const waitMs = startedAt + tick * config.intervalMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    if (stopping) break;

    const { reports, dropped: droppedNow } = tickFleet(fleet, {
      dtSeconds: config.intervalMs / 1000,
      now: Date.now(),
      dropRate: config.dropRate,
      random: dropRandom,
    });

    dropped += droppedNow;
    ticks += 1;
    tick += 1;

    if (reports.length === 0) {
      log(`t=${tick - 1} reports=0 dropped=${droppedNow}`);
      continue;
    }

    reportCount += reports.length;
    const startedRequest = performance.now();

    try {
      const response = await postReports(config, reports);
      const rtt = Math.round(performance.now() - startedRequest);

      if (response.status === 401 || response.status === 403) {
        console.error(
          `[sim] ingest refused the key (x-ingest-key) with ${response.status}: ` +
            "check --key or INGEST_API_KEY.",
        );
        exitCode = 1;
        break;
      }

      const body = (await response.json().catch(() => null)) as
        | IngestResponseBody
        | IngestErrorBody
        | null;

      if (!response.ok) {
        failed += 1;
        const code = body && "error" in body ? body.error?.code : undefined;
        log(`t=${tick - 1} HTTP ${response.status}${code === undefined ? "" : ` ${code}`} — continuing`);
        continue;
      }

      if (body === null || !("accepted" in body)) {
        failed += 1;
        log(`t=${tick - 1} HTTP ${response.status} with an unreadable body — continuing`);
        continue;
      }

      accepted += body.accepted;
      duplicates += body.duplicates;
      rejected += body.rejected.length;

      const firstRejection = body.rejected[0]?.reason;
      log(
        `t=${tick - 1} reports=${reports.length} accepted=${body.accepted} dup=${body.duplicates}` +
          ` rejected=${body.rejected.length} skipped=${skipped} rtt=${rtt}ms` +
          (firstRejection === undefined ? "" : ` first="${firstRejection}"`),
      );
    } catch (error) {
      failed += 1;
      log(`t=${tick - 1} ingest unreachable (${messageOf(error)}) — continuing`);
    }
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `stopped after ${ticks} ticks · ${reportCount} reports · ${accepted} accepted · ` +
      `${duplicates} duplicates · ${rejected} rejected · ${dropped} dropped · ` +
      `${failed} failed · ${skipped} skipped · ${seconds} s`,
  );

  return exitCode;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), process.env);

  if (parsed.kind === "help") {
    console.log(usage());
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`sim: ${parsed.message}\n\n${usage()}`);
    return 1;
  }

  return run(parsed.config);
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`[sim] fatal: ${messageOf(error)}`);
    process.exit(1);
  });
