import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type Database from "better-sqlite3";

import { openDatabase } from "../lib/db/client";
import { ingestReports } from "../lib/db/telemetry";
import {
  DEFAULT_WINDOW,
  MAX_POINTS,
  WINDOW_ALLOWLIST,
  WINDOW_NAMES,
  bucketFor,
  handleRobot,
  type RobotDeps,
  type RobotResponseBody,
} from "../lib/http/robot";
import type { TelemetryReport } from "../lib/telemetry/schema";
import type { StatusThresholds } from "../lib/telemetry/status";

/**
 * Aligned to the 5 s bucket grid on purpose: bucket starts then land on round
 * offsets from `NOW`, so the expected `t` values in these tests are arithmetic
 * instead of `Math.floor` noise.
 */
const NOW = 1_700_000_000_000;
const SECOND = 1_000;

const THRESHOLDS: StatusThresholds = {
  offlineAfterMs: 10_000,
  delayedAfterMs: 3_000,
  lowBatteryPct: 20,
};

const handles: Database.Database[] = [];
const directories: string[] = [];

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "robot-detail-"));
  directories.push(dir);
  const db = openDatabase(path.join(dir, "robot.db"));
  handles.push(db);
  return db;
}

after(() => {
  for (const db of handles) {
    if (db.open) db.close();
  }
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function report(
  robotId: string,
  seq: number,
  receivedAt: number,
  overrides: Partial<TelemetryReport> = {},
): TelemetryReport {
  return {
    robotId,
    seq,
    ts: receivedAt,
    battery: 80,
    charging: false,
    motion: "moving",
    x: 0,
    y: 0,
    heading: 0,
    speed: 0.6,
    errorCode: null,
    ...overrides,
  };
}

/** One ingest per report, so each row keeps the receive time the test chose. */
function seed(
  db: Database.Database,
  robotId: string,
  receivedAt: number,
  seq: number,
  overrides: Partial<TelemetryReport> = {},
): void {
  ingestReports(db, [report(robotId, seq, receivedAt, overrides)], receivedAt);
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

type Body = RobotResponseBody & Partial<ErrorBody>;

interface Sent {
  status: number;
  body: Body;
}

async function send(
  db: Database.Database,
  robotId: string,
  query = "",
  overrides: Partial<RobotDeps> = {},
): Promise<Sent> {
  const request = new Request(`http://localhost/api/robots/${encodeURIComponent(robotId)}${query}`);
  const response = handleRobot(request, robotId, {
    db,
    thresholds: THRESHOLDS,
    now: NOW,
    ...overrides,
  });
  return { status: response.status, body: (await response.json()) as Body };
}

function expectOk(sent: Sent): RobotResponseBody {
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return sent.body;
}

describe("GET /api/robots/:id", () => {
  it("answers 404 robot_not_found for an unknown id and for metadata with no telemetry", async () => {
    const db = freshDb();

    const unknown = await send(db, "RBT-404");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error?.code, "robot_not_found");
    assert.match(unknown.body.error?.message ?? "", /RBT-404/);

    // A curated robot that has never reported: the read model decides existence.
    db.prepare("INSERT INTO robots (id, name, site_id, model, created_at) VALUES (?, ?, ?, ?, ?)").run(
      "RBT-IDLE",
      "Idle",
      "site-oslo",
      "TL-2",
      NOW,
    );

    const metadataOnly = await send(db, "RBT-IDLE");
    assert.equal(metadataOnly.status, 404);
    assert.equal(metadataOnly.body.error?.code, "robot_not_found");
  });

  it("answers the default 15m window with metadata, state, one bucket, trail and stats", async () => {
    const db = freshDb();
    seed(db, "RBT-001", NOW - SECOND, 1, {
      battery: 73.4,
      charging: false,
      motion: "moving",
      x: 12.5,
      y: -3.02,
      heading: 91.2,
      speed: 0.7,
    });

    const body = expectOk(await send(db, "RBT-001"));

    assert.equal(body.generatedAt, NOW);
    assert.deepEqual(body.window, {
      requested: "15m",
      ms: 900_000,
      bucketMs: 5_000,
      from: NOW - 900_000,
      to: NOW,
    });
    assert.deepEqual(body.thresholds, THRESHOLDS);
    assert.deepEqual(body.robot, {
      id: "RBT-001",
      name: "RBT-001",
      siteId: "unassigned",
      model: "unknown",
    });
    assert.deepEqual(body.state, {
      status: "moving",
      battery: 73.4,
      charging: false,
      motion: "moving",
      x: 12.5,
      y: -3.02,
      heading: 91.2,
      speed: 0.7,
      errorCode: null,
      seq: 1,
      deviceTs: NOW - SECOND,
      receivedAt: NOW - SECOND,
      ageMs: SECOND,
    });

    assert.equal(body.history.length, 1);
    assert.deepEqual(body.history[0], {
      t: NOW - 5_000,
      battery: 73.4,
      speed: 0.7,
      charging: false,
    });
    assert.deepEqual(body.trail, [{ t: NOW - 5_000, x: 12.5, y: -3.02 }]);
    assert.deepEqual(body.events, []);
    assert.deepEqual(body.stats, { reports: 1, avgBattery: 73.4, distanceM: 0, gapCount: 0 });
  });

  it("accepts each allowlisted window and applies the ladder bucket", async () => {
    const db = freshDb();
    seed(db, "RBT-001", NOW - SECOND, 1);

    for (const [name, ms] of Object.entries(WINDOW_ALLOWLIST)) {
      const body = expectOk(await send(db, "RBT-001", `?window=${name}`));
      assert.equal(body.window.requested, name);
      assert.equal(body.window.ms, ms);
      assert.equal(body.window.bucketMs, bucketFor(ms));
      assert.equal(body.window.from, NOW - ms);
      assert.equal(body.window.to, NOW);
    }

    // The numbers PLAN §5 documents, pinned so a ladder edit cannot drift them.
    const defaults = expectOk(await send(db, "RBT-001", `?window=${DEFAULT_WINDOW}`));
    assert.equal(defaults.window.bucketMs, 5_000);

    const day = expectOk(await send(db, "RBT-001", "?window=24h"));
    assert.equal(day.window.bucketMs, 600_000);
  });

  it("answers an unknown window with 400 invalid_query naming the allowlist", async () => {
    const db = freshDb();
    seed(db, "RBT-001", NOW - SECOND, 1);

    const sent = await send(db, "RBT-001", "?window=7m");

    assert.equal(sent.status, 400);
    assert.equal(sent.body.error?.code, "invalid_query");
    assert.match(sent.body.error?.message ?? "", /7m/);
    const details = sent.body.error?.details as { parameter: string; allowed: readonly string[] };
    assert.equal(details.parameter, "window");
    assert.deepEqual(details.allowed, WINDOW_NAMES);
  });

  it("treats a blank window as absent and ignores unknown parameters", async () => {
    const db = freshDb();
    seed(db, "RBT-001", NOW - SECOND, 1);

    const blank = expectOk(await send(db, "RBT-001", "?window=%20"));
    assert.equal(blank.window.requested, DEFAULT_WINDOW);

    const extra = expectOk(await send(db, "RBT-001", "?foo=bar"));
    assert.equal(extra.window.requested, DEFAULT_WINDOW);
  });

  it("folds a bucket to mean battery and position, peak speed and any-while-charging", async () => {
    const db = freshDb();
    seed(db, "RBT-001", NOW - 2 * SECOND, 1, {
      battery: 60,
      speed: 0.5,
      charging: false,
      x: 0,
      y: 0,
    });
    seed(db, "RBT-001", NOW - SECOND, 2, {
      battery: 80,
      speed: 1.5,
      charging: true,
      x: 10,
      y: 4,
    });

    const body = expectOk(await send(db, "RBT-001"));

    assert.equal(body.history.length, 1, "both reports land in the same 5 s bucket");
    assert.deepEqual(body.history[0], {
      t: NOW - 5_000,
      battery: 70,
      speed: 1.5,
      charging: true,
    });
    assert.deepEqual(body.trail, [{ t: NOW - 5_000, x: 5, y: 2 }]);
  });

  it("aligns bucket starts to the grid and keeps a full window to the point cap", async () => {
    const db = freshDb();
    // 15 minutes at 1 Hz: one report per second, newest at NOW.
    for (let age = 0; age < 900; age += 1) {
      seed(db, "RBT-001", NOW - age * SECOND, age, { ts: NOW - age * SECOND });
    }

    const body = expectOk(await send(db, "RBT-001"));
    const starts = body.history.map((point) => point.t);

    assert.equal(starts.length, MAX_POINTS + 1, "900 samples → 180 intervals, plus the aligned edge");
    for (const t of starts) {
      assert.equal(t % 5_000, 0, "every bucket starts on the epoch-aligned 5 s grid");
    }
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "oldest bucket first");
    assert.equal(starts[starts.length - 1], NOW);
    assert.equal(starts[0], NOW - 900_000);
    assert.equal(body.trail.length, body.history.length);
    assert.equal(body.stats.reports, 900);
  });

  it("counts only reports inside the window, including both edges", async () => {
    const db = freshDb();
    seed(db, "RBT-001", NOW - 900_000, 1, { battery: 90 }); // exactly at `from`
    seed(db, "RBT-001", NOW - 901_000, 2, { battery: 10 }); // one second too old
    seed(db, "RBT-001", NOW - SECOND, 3, { battery: 70 });

    const body = expectOk(await send(db, "RBT-001"));

    assert.equal(body.stats.reports, 2);
    assert.equal(body.stats.avgBattery, 80);
    assert.equal(body.history.length, 2);
    assert.equal(body.history[0]!.t, NOW - 900_000);
  });

  it("reports fault edges once per change, newest first, and clears with the code", async () => {
    const db = freshDb();
    seed(db, "RBT-001", NOW - 15 * SECOND, 1);
    seed(db, "RBT-001", NOW - 14 * SECOND, 2, { errorCode: "E_STUCK" });
    seed(db, "RBT-001", NOW - 13 * SECOND, 3, { errorCode: "E_STUCK" });
    seed(db, "RBT-001", NOW - 12 * SECOND, 4, { errorCode: "E_WHEEL" });
    seed(db, "RBT-001", NOW - 11 * SECOND, 5);
    seed(db, "RBT-001", NOW - 10 * SECOND, 6);
    seed(db, "RBT-001", NOW - 9 * SECOND, 7, { errorCode: "E_STUCK" });

    const body = expectOk(await send(db, "RBT-001"));
    const faults = body.events.filter((event) => event.kind === "fault");

    assert.deepEqual(faults, [
      { t: NOW - 9 * SECOND, kind: "fault", detail: "E_STUCK" },
      { t: NOW - 12 * SECOND, kind: "fault", detail: "E_WHEEL" },
      { t: NOW - 14 * SECOND, kind: "fault", detail: "E_STUCK" },
    ]);
    assert.equal(body.events.length, 3, "a persisting code and a cleared one add no event");
  });

  it("reports charge_start only on the false→true edge", async () => {
    const db = freshDb();
    seed(db, "RBT-001", NOW - 6 * SECOND, 1, { charging: true });
    seed(db, "RBT-001", NOW - 5 * SECOND, 2, { charging: false });
    seed(db, "RBT-001", NOW - 4 * SECOND, 3, { charging: true });
    seed(db, "RBT-001", NOW - 3 * SECOND, 4, { charging: true });
    seed(db, "RBT-001", NOW - 2 * SECOND, 5, { charging: false });
    seed(db, "RBT-001", NOW - SECOND, 6, { charging: true });

    const body = expectOk(await send(db, "RBT-001"));

    assert.deepEqual(body.events, [
      { t: NOW - SECOND, kind: "charge_start", detail: null },
      { t: NOW - 4 * SECOND, kind: "charge_start", detail: null },
    ]);
    assert.equal(body.state.charging, true);
  });

  it("reports a comms_gap only past the offline threshold, with the length as detail", async () => {
    const db = freshDb();
    seed(db, "RBT-001", NOW - 40 * SECOND, 1);
    seed(db, "RBT-001", NOW - 25 * SECOND, 2); // 15 s of silence
    seed(db, "RBT-001", NOW - 24 * SECOND, 3); // 1 s: back to normal
    seed(db, "RBT-001", NOW - 14 * SECOND, 4); // 10 s exactly: still not offline

    const body = expectOk(await send(db, "RBT-001"));

    assert.deepEqual(body.events, [
      { t: NOW - 25 * SECOND, kind: "comms_gap", detail: "no reports for 15.0s" },
    ]);
  });

  it("caps the event list at the newest 200", async () => {
    const db = freshDb();
    // 250 changes of code, one per second — every one is an edge.
    for (let i = 0; i < 250; i += 1) {
      seed(db, "RBT-001", NOW - (250 - i) * SECOND, i, {
        errorCode: i % 2 === 0 ? "E_A" : "E_B",
      });
    }

    const body = expectOk(await send(db, "RBT-001"));

    assert.equal(body.events.length, 200);
    assert.equal(body.events[0]!.t, NOW - SECOND, "the newest edge survives the cap");
    for (let i = 1; i < body.events.length; i += 1) {
      assert.ok(body.events[i]!.t < body.events[i - 1]!.t, "newest first");
    }
  });

  it("totals reports, battery and travelled distance, skipping gap-spanning segments", async () => {
    const straight = freshDb();
    seed(straight, "RBT-001", NOW - 3 * SECOND, 1, { x: 0, y: 0, battery: 60 });
    seed(straight, "RBT-001", NOW - 2 * SECOND, 2, { x: 3, y: 4, battery: 70 });
    seed(straight, "RBT-001", NOW - SECOND, 3, { x: 6, y: 8, battery: 80 });

    const clean = expectOk(await send(straight, "RBT-001"));
    assert.deepEqual(clean.stats, { reports: 3, avgBattery: 70, distanceM: 10, gapCount: 0 });

    const gapped = freshDb();
    seed(gapped, "RBT-001", NOW - 40 * SECOND, 1, { x: 0, y: 0 });
    seed(gapped, "RBT-001", NOW - 20 * SECOND, 2, { x: 100, y: 0 }); // 20 s gap: unknown path
    seed(gapped, "RBT-001", NOW - 19 * SECOND, 3, { x: 103, y: 4 });

    const stats = expectOk(await send(gapped, "RBT-001")).stats;
    assert.equal(stats.reports, 3);
    assert.equal(stats.gapCount, 1);
    assert.equal(stats.distanceM, 5, "the 100 m jump across the gap is not a measured segment");
  });

  it("prefers curated metadata and falls back to the id when the robots row is gone", async () => {
    const db = freshDb();
    seed(db, "RBT-001", NOW - SECOND, 1);
    seed(db, "RBT-002", NOW - SECOND, 1);
    db.prepare("UPDATE robots SET name = ?, site_id = ?, model = ? WHERE id = ?").run(
      "Top Loader",
      "site-berlin",
      "TL-2",
      "RBT-001",
    );
    db.prepare("DELETE FROM robots WHERE id = ?").run("RBT-002");

    assert.deepEqual(expectOk(await send(db, "RBT-001")).robot, {
      id: "RBT-001",
      name: "Top Loader",
      siteId: "site-berlin",
      model: "TL-2",
    });

    assert.deepEqual(expectOk(await send(db, "RBT-002")).robot, {
      id: "RBT-002",
      name: "RBT-002",
      siteId: "unassigned",
      model: "unknown",
    });
  });

  it("derives offline from a stale report and clamps the age of a future one at 0", async () => {
    const db = freshDb();
    seed(db, "RBT-STALE", NOW - 11 * SECOND, 1, { ts: NOW - 11 * SECOND });
    ingestReports(db, [report("RBT-FUTURE", 1, NOW + 5 * SECOND)], NOW + 5 * SECOND);

    const stale = expectOk(await send(db, "RBT-STALE"));
    assert.equal(stale.state.status, "offline");
    assert.equal(stale.state.ageMs, 11 * SECOND);

    const future = expectOk(await send(db, "RBT-FUTURE"));
    assert.equal(future.state.status, "moving");
    assert.equal(future.state.ageMs, 0);
  });
});
