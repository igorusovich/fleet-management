/**
 * The ingest request handler: auth, size, shape, per-report validation, store.
 *
 * Deliberately a plain function over a Web `Request`/`Response`. It imports
 * nothing from `next/*`, so the gate can call it directly against a temp
 * database with a pinned clock instead of booting a dev server.
 *
 * The gates run in this order, and the order is the design:
 *   1. auth      — before the body is read, so a rejected caller learns nothing
 *                  about the schema and cannot make us allocate a body.
 *   2. size      — declared `content-length` first, then the real byte count.
 *   3. JSON      — unparseable body is a 400, never a 500.
 *   4. shape     — one report object or `{ reports: [...] }`, 1..500 reports.
 *   5. per report — each report is validated on its own, so one bad robot never
 *                  drops the batch; only an entirely invalid batch is a 400.
 */

import type Database from "better-sqlite3";

import { ingestReports } from "../db/telemetry";
import {
  MAX_REPORTS_PER_BATCH,
  describeIssues,
  reportSchema,
  type TelemetryReport,
} from "../telemetry/schema";
import { INGEST_KEY_HEADER, hasValidIngestKey } from "./auth";

/**
 * 500 reports are roughly 120 KB of JSON; 512 KiB leaves room for verbose
 * payloads while keeping a hostile request from being read into memory.
 */
export const MAX_BODY_BYTES = 512 * 1024;

export type IngestErrorCode =
  | "unauthorized"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_body"
  | "empty_batch"
  | "batch_too_large"
  | "invalid_reports";

/** Why one report was dropped. `index` is its position in the request array. */
export interface RejectedReport {
  readonly index: number;
  readonly reason: string;
}

/** 200 body. `rejected` is always present, empty when the batch was clean. */
export interface IngestResponseBody {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: readonly RejectedReport[];
}

export interface IngestDeps {
  readonly db: Database.Database;
  /** `config.ingestApiKey` at request time. */
  readonly expectedKey: string;
  /** Server clock in epoch ms, injected so a batch has one timestamp and tests can pin it. */
  readonly now: number;
  /** One structured line per accepted request. Silent in tests. */
  readonly log?: (line: string) => void;
  /**
   * Fired only when at least one report was stored, so the live stream can drop
   * its cached snapshot and show the report on the next frame. Duplicates and
   * rejected reports do not fire it: nothing readable changed.
   */
  readonly onAccepted?: (stored: IngestResult) => void;
}

/** What the store reports back for one batch. */
export type IngestResult = Awaited<ReturnType<typeof ingestReports>>;

function errorResponse(
  status: number,
  code: IngestErrorCode,
  message: string,
  details?: unknown,
): Response {
  return Response.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

function payloadTooLarge(): Response {
  return errorResponse(
    413,
    "payload_too_large",
    `The request body must be at most ${MAX_BODY_BYTES} bytes.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unwrap the two accepted body forms. Returns `null` for anything else, so the
 * caller can answer with one `invalid_body` message.
 */
function reportsFromBody(body: unknown): unknown[] | null {
  if (!isRecord(body)) return null;
  if ("reports" in body) return Array.isArray(body.reports) ? body.reports : null;
  // A single source that posts one report per request: the object *is* the report.
  if ("robotId" in body) return [body];
  return null;
}

export async function handleIngest(request: Request, deps: IngestDeps): Promise<Response> {
  const { db, expectedKey, now } = deps;
  const log = deps.log ?? ((line: string) => console.info(line));

  // Gate 1 — authentication.
  if (!hasValidIngestKey(request.headers.get(INGEST_KEY_HEADER), expectedKey)) {
    return errorResponse(401, "unauthorized", `Missing or invalid ${INGEST_KEY_HEADER} header.`);
  }

  // Gate 2 — size, from the declared length first so an oversized body is never read.
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
      return payloadTooLarge();
    }
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return errorResponse(400, "invalid_body", "The request body could not be read.");
  }
  // `content-length` can be absent (chunked) or wrong, so measure what arrived.
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return payloadTooLarge();

  // Gate 3 — JSON.
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    return errorResponse(400, "invalid_json", "The request body is not valid JSON.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  // Gate 4 — envelope shape and batch bounds.
  const items = reportsFromBody(body);
  if (items === null) {
    return errorResponse(
      400,
      "invalid_body",
      'Expected one report object or { "reports": [...] }.',
    );
  }
  if (items.length === 0) {
    return errorResponse(400, "empty_batch", "The batch contains no reports.");
  }
  if (items.length > MAX_REPORTS_PER_BATCH) {
    return errorResponse(
      400,
      "batch_too_large",
      `A batch may contain at most ${MAX_REPORTS_PER_BATCH} reports.`,
      { received: items.length, limit: MAX_REPORTS_PER_BATCH },
    );
  }

  // Gate 5 — per-report validation: the batch survives its bad members.
  const valid: TelemetryReport[] = [];
  const rejected: RejectedReport[] = [];
  items.forEach((item, index) => {
    const parsed = reportSchema.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
    else rejected.push({ index, reason: describeIssues(parsed.error) });
  });

  if (valid.length === 0) {
    return errorResponse(
      400,
      "invalid_reports",
      "No report in the batch was valid.",
      { rejected },
    );
  }

  const startedAt = performance.now();
  const stored = ingestReports(db, valid, now);
  const elapsedMs = Math.round(performance.now() - startedAt);

  log(
    `ingest received=${items.length} accepted=${stored.accepted} duplicates=${stored.duplicates}` +
      ` rejected=${rejected.length} ms=${elapsedMs}`,
  );

  if (stored.accepted > 0) deps.onAccepted?.(stored);

  const responseBody: IngestResponseBody = {
    accepted: stored.accepted,
    duplicates: stored.duplicates,
    rejected,
  };
  return Response.json(responseBody);
}
