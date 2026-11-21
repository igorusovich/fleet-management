import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_REPORTS_PER_BATCH,
  describeIssues,
  ingestBodySchema,
  normaliseHeading,
  reportSchema,
} from "../lib/telemetry/schema";
import { deriveStatus, type RobotStatus, type StatusSnapshot } from "../lib/telemetry/status";

const VALID_REPORT = {
  robotId: "RBT-001",
  seq: 412,
  ts: 1_732_700_000_000,
  battery: 73.4,
  charging: false,
  motion: "moving",
  x: 12.5,
  y: -3.02,
  heading: 91.2,
  speed: 0.7,
  errorCode: null,
};

/** Parse a report with one field patched; return the failure description. */
function rejection(patch: Record<string, unknown>): string {
  const result = reportSchema.safeParse({ ...VALID_REPORT, ...patch });
  assert.equal(result.success, false, `expected ${JSON.stringify(patch)} to be rejected`);
  return describeIssues(result.error);
}

describe("reportSchema", () => {
  it("parses a valid report and strips unknown keys", () => {
    const parsed = reportSchema.parse({ ...VALID_REPORT, firmware: "v9.1.0", rssi: -61 });

    assert.equal(parsed.robotId, "RBT-001");
    assert.equal(parsed.battery, 73.4);
    assert.equal(parsed.errorCode, null);
    assert.ok(!("firmware" in parsed), "unknown key must not survive the parse");
    assert.ok(!("rssi" in parsed));
  });

  it("defaults errorCode to null when the device omits it", () => {
    const withoutErrorCode: Record<string, unknown> = { ...VALID_REPORT };
    delete withoutErrorCode.errorCode;

    const parsed = reportSchema.parse(withoutErrorCode);
    assert.equal(parsed.errorCode, null);
  });

  it("rejects a battery above 100, naming the field", () => {
    assert.match(rejection({ battery: 101 }), /^battery:/);
  });

  it("rejects a negative seq, naming the field", () => {
    assert.match(rejection({ seq: -1 }), /^seq:/);
  });

  it("rejects an unknown motion state, naming the field", () => {
    assert.match(rejection({ motion: "flying" }), /^motion:/);
  });

  it("rejects a non-finite coordinate, naming the field", () => {
    assert.match(rejection({ x: Number.POSITIVE_INFINITY }), /^x:/);
    assert.match(rejection({ y: Number.NaN }), /^y:/);
  });

  it("rejects an empty robot id, naming the field", () => {
    assert.match(rejection({ robotId: "" }), /^robotId:/);
  });

  it("rejects a robot id with characters unsafe for a URL", () => {
    assert.match(rejection({ robotId: "RBT 001/../x" }), /^robotId:/);
  });
});

describe("ingestBodySchema", () => {
  const batch = (length: number) => ({
    reports: Array.from({ length }, () => VALID_REPORT),
  });

  it("accepts a batch at the size limit", () => {
    const result = ingestBodySchema.safeParse(batch(MAX_REPORTS_PER_BATCH));
    assert.equal(result.success, true);
  });

  it("rejects a batch over the size limit, naming the array", () => {
    const result = ingestBodySchema.safeParse(batch(MAX_REPORTS_PER_BATCH + 1));
    assert.equal(result.success, false);
    assert.match(describeIssues(result.error), /^reports:/);
  });

  it("accepts an empty batch — nothing to do is not an error", () => {
    const result = ingestBodySchema.safeParse({ reports: [] });
    assert.equal(result.success, true);
    assert.deepEqual(result.success ? result.data.reports : null, []);
  });

  it("rejects a body without a reports array", () => {
    const result = ingestBodySchema.safeParse({ report: VALID_REPORT });
    assert.equal(result.success, false);
  });
});

describe("normaliseHeading", () => {
  it("wraps 360 to 0, negative bearings upwards, and leaves the rest alone", () => {
    assert.equal(normaliseHeading(360), 0);
    assert.equal(normaliseHeading(0), 0);
    assert.equal(normaliseHeading(-10), 350);
    assert.equal(normaliseHeading(361), 1);
    assert.equal(normaliseHeading(-360), 0);
    assert.equal(normaliseHeading(91.2), 91.2);
  });
});

const NOW = 1_732_700_100_000;

const THRESHOLDS = { offlineAfterMs: 10_000, delayedAfterMs: 3_000, lowBatteryPct: 20 };

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    receivedAt: NOW,
    battery: 80,
    charging: false,
    motion: "moving",
    errorCode: null,
    ...overrides,
  };
}

function statusAt(overrides: Partial<StatusSnapshot> = {}, now = NOW): RobotStatus {
  return deriveStatus(snapshot(overrides), now, THRESHOLDS);
}

describe("deriveStatus", () => {
  it("derives the nominal states", () => {
    assert.equal(statusAt(), "moving");
    assert.equal(statusAt({ motion: "idle" }), "idle");
    assert.equal(statusAt({ battery: 19 }), "low_battery");
    assert.equal(statusAt({ charging: true }), "charging");
    assert.equal(statusAt({ errorCode: "LIDAR_BLOCKED" }), "fault");
  });

  it("treats exactly 20% as not low", () => {
    assert.equal(statusAt({ battery: 20, motion: "idle" }), "idle");
    assert.equal(statusAt({ battery: 19.9, motion: "idle" }), "low_battery");
  });

  it("applies precedence fault → charging → low_battery → moving → idle", () => {
    assert.equal(
      statusAt({ errorCode: "WHEEL_SLIP", charging: true, battery: 5 }),
      "fault",
    );
    assert.equal(statusAt({ charging: true, battery: 5 }), "charging");
    assert.equal(statusAt({ battery: 5 }), "low_battery");
  });

  it("puts freshness above everything the robot reported", () => {
    assert.equal(statusAt({ errorCode: "STUCK", charging: true }, NOW + 3_001), "delayed");
    assert.equal(statusAt({ errorCode: "STUCK", charging: true }, NOW + 10_001), "offline");
  });

  it("treats the thresholds as strict: the boundary age still belongs to the faster bucket", () => {
    assert.equal(statusAt({}, NOW + 3_000), "moving");
    assert.equal(statusAt({}, NOW + 3_001), "delayed");
    assert.equal(statusAt({}, NOW + 10_000), "delayed");
    assert.equal(statusAt({}, NOW + 10_001), "offline");
  });

  it("does not go negative when the device clock is ahead of the server", () => {
    assert.equal(statusAt({}, NOW - 5_000), "moving");
  });
});
