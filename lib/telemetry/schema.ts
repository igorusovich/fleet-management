/**
 * Wire contract between a robot (or simulator) and the ingest endpoint.
 *
 * This is the only place the report shape is defined. It is pure: no I/O, no
 * imports from Next or the database, so the simulator's payloads, the API
 * validators and the tests all agree by construction.
 */

import { z } from "zod";

export const MOTION_STATES = ["idle", "moving", "charging", "error"] as const;
export type MotionState = (typeof MOTION_STATES)[number];

/** A gateway posts one batch per tick; this caps the batch size. */
export const MAX_REPORTS_PER_BATCH = 500;

/** Robot ids are join keys and URL segments, so keep them boring. */
export const ROBOT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Site-local metres. ±1000 km is far beyond any warehouse; the bound also
 *  rejects Infinity without needing a separate finiteness check. */
const COORDINATE_LIMIT = 1_000_000;

export const reportSchema = z.object({
  robotId: z
    .string()
    .min(1)
    .max(64)
    .regex(ROBOT_ID_PATTERN, "only letters, digits and . _ : - are allowed"),
  /** Per-robot monotonic counter. Together with robotId it is the idempotency key. */
  seq: z.number().int().min(0),
  /** Device clock, epoch milliseconds: when the robot sampled this state. */
  ts: z.number().int().positive(),
  battery: z.number().min(0).max(100),
  charging: z.boolean(),
  motion: z.enum(MOTION_STATES),
  x: z.number().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT),
  y: z.number().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT),
  /** Degrees. 0 and 360 are the same bearing; both are accepted. */
  heading: z.number().min(0).max(360),
  speed: z.number().min(0).max(10),
  errorCode: z.string().min(1).max(64).nullable().default(null),
});

export type TelemetryReport = z.infer<typeof reportSchema>;

export const ingestBodySchema = z.object({
  reports: z.array(reportSchema).max(MAX_REPORTS_PER_BATCH),
});

export type IngestBody = z.infer<typeof ingestBodySchema>;

/** Normalise a bearing into [0, 360), so 360 and -10 both land where they belong. */
export function normaliseHeading(degrees: number): number {
  // Pass in-range bearings through untouched: the modulo round-trip is exact for
  // integers but drags float noise into values like 91.2.
  if (degrees >= 0 && degrees < 360) return degrees;
  const wrapped = (((degrees % 360) + 360) % 360) || 0;
  return wrapped;
}

/**
 * Human-readable one-liner for a failed parse, e.g.
 * `battery: Too big: expected number to be <=100; motion: Invalid option`.
 * Paths are preserved so the ingest endpoint can report which field was wrong.
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
