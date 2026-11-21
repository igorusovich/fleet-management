import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type Database from "better-sqlite3";

import { openDatabase } from "../lib/db/client";
import { ingestReports } from "../lib/db/telemetry";
import { handleFleet, type FleetDeps, type FleetResponseBody } from "../lib/http/fleet";
import type { TelemetryReport } from "../lib/telemetry/schema";
import { ROBOT_STATUSES, type StatusThresholds } from "../lib/telemetry/status";

const T0 = 1_700_000_000_000;
const NOW = T0 + 600_000;

const THRESHOLDS: StatusThresholds = {
  offlineAfterMs: 10_000,
  delayedAfterMs: 3_000,
  lowBatteryPct: 20,
};

const handles: Database.Database[] = [];
const directories: string[] = [];

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-snapshot-"));
  directories.push(dir);
  const db = openDatabase(path.join(dir, "fleet.db"));
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
  overrides: Partial<TelemetryReport> = {},
): TelemetryReport {
  return {
    robotId,
    seq,
    ts: T0 + seq * 1_000,
    battery: 80,
    charging: false,
    motion: "moving",
    x: 1,
    y: 2,
    heading: 90,
    speed: 0.6,
    errorCode: null,
    ...overrides,
  };
}

/**
 * One ingest call per report, so every robot gets its own receive time and the
 * ages in a test read as ages rather than as batch arithmetic.
 */
function seed(
  db: Database.Database,
  robotId: string,
  ageMs: number,
  overrides: Partial<TelemetryReport> = {},
): void {
  ingestReports(db, [report(robotId, 1, overrides)], NOW - ageMs);
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

type Body = FleetResponseBody & Partial<ErrorBody>;

interface Sent {
  status: number;
  body: Body;
}

async function send(
  db: Database.Database,
  query = "",
  overrides: Partial<FleetDeps> = {},
): Promise<Sent> {
  const request = new Request(`http://localhost/api/fleet${query}`);
  const response = handleFleet(request, { db, thresholds: THRESHOLDS, now: NOW, ...overrides });
  return { status: response.status, body: (await response.json()) as Body };
}

function byId(body: Body, robotId: string): FleetResponseBody["robots"][number] {
  const robot = body.robots.find((entry) => entry.id === robotId);
  assert.ok(robot, `expected a robot ${robotId} in the response`);
  return robot;
}

describe("GET /api/fleet", () => {
  it("answers an empty fleet with 200, the clock, thresholds and zeroed counts", async () => {
    const sent = await send(freshDb());

    assert.equal(sent.status, 200);
    assert.equal(sent.body.generatedAt, NOW);
    assert.deepEqual(sent.body.thresholds, THRESHOLDS);
    assert.deepEqual(sent.body.summary, {
      total: 0,
      moving: 0,
      idle: 0,
      charging: 0,
      low_battery: 0,
      fault: 0,
      delayed: 0,
      offline: 0,
    });
    assert.deepEqual(sent.body.robots, []);
  });

  it("returns every robot ordered by id with derived status, age and state fields", async () => {
    const db = freshDb();
    seed(db, "RBT-002", 500);
    seed(db, "RBT-001", 500, { battery: 45, x: 12.5, y: -3, heading: 271, speed: 1.2 });

    const sent = await send(db);

    assert.equal(sent.status, 200);
    assert.deepEqual(
      sent.body.robots.map((robot) => robot.id),
      ["RBT-001", "RBT-002"],
    );

    const one = byId(sent.body, "RBT-001");
    assert.equal(one.name, "RBT-001");
    assert.equal(one.siteId, "unassigned");
    assert.equal(one.model, "unknown");
    assert.equal(one.status, "moving");
    assert.equal(one.battery, 45);
    assert.equal(one.charging, false);
    assert.equal(one.x, 12.5);
    assert.equal(one.y, -3);
    assert.equal(one.heading, 271);
    assert.equal(one.speed, 1.2);
    assert.equal(one.errorCode, null);
    assert.equal(one.seq, 1);
    assert.equal(one.deviceTs, T0 + 1_000);
    assert.equal(one.receivedAt, NOW - 500);
    assert.equal(one.ageMs, 500);
    assert.equal(one.samplesLastMinute, 1);
  });

  it("prefers curated metadata and falls back to the id when the robots row is gone", async () => {
    const db = freshDb();
    seed(db, "RBT-001", 500);
    seed(db, "RBT-002", 500);

    db.prepare("UPDATE robots SET name = ?, site_id = ?, model = ? WHERE id = ?").run(
      "Top Loader",
      "site-berlin",
      "TL-2",
      "RBT-001",
    );
    // A metadata row can be missing while the read model still has state.
    db.prepare("DELETE FROM robots WHERE id = ?").run("RBT-002");

    const sent = await send(db);

    const curated = byId(sent.body, "RBT-001");
    assert.equal(curated.name, "Top Loader");
    assert.equal(curated.siteId, "site-berlin");
    assert.equal(curated.model, "TL-2");

    const orphan = byId(sent.body, "RBT-002");
    assert.equal(orphan.name, "RBT-002");
    assert.equal(orphan.siteId, "unassigned");
    assert.equal(orphan.model, "unknown");
  });

  it("fills each status bucket once and counts every robot exactly once", async () => {
    const db = freshDb();
    seed(db, "RBT-OFF", 11_000);
    seed(db, "RBT-DEL", 4_000);
    seed(db, "RBT-FLT", 500, { errorCode: "E_STUCK" });
    seed(db, "RBT-CHG", 500, { charging: true, motion: "charging" });
    seed(db, "RBT-LOW", 500, { battery: 15 });
    seed(db, "RBT-MOV", 500);
    seed(db, "RBT-IDL", 500, { motion: "idle" });

    const sent = await send(db);

    assert.deepEqual(sent.body.summary, {
      total: 7,
      moving: 1,
      idle: 1,
      charging: 1,
      low_battery: 1,
      fault: 1,
      delayed: 1,
      offline: 1,
    });

    const statuses = new Map(sent.body.robots.map((robot) => [robot.id, robot.status]));
    assert.equal(statuses.get("RBT-OFF"), "offline");
    assert.equal(statuses.get("RBT-DEL"), "delayed");
    assert.equal(statuses.get("RBT-FLT"), "fault");
    assert.equal(statuses.get("RBT-CHG"), "charging");
    assert.equal(statuses.get("RBT-LOW"), "low_battery");
    assert.equal(statuses.get("RBT-MOV"), "moving");
    assert.equal(statuses.get("RBT-IDL"), "idle");
  });

  it("narrows robots and counts with the site filter", async () => {
    const db = freshDb();
    seed(db, "RBT-001", 500);
    seed(db, "RBT-002", 500);
    db.prepare("UPDATE robots SET site_id = ? WHERE id = ?").run("site-berlin", "RBT-001");
    db.prepare("UPDATE robots SET site_id = ? WHERE id = ?").run("site-oslo", "RBT-002");

    const sent = await send(db, "?site=site-berlin");

    assert.equal(sent.status, 200);
    assert.deepEqual(
      sent.body.robots.map((robot) => robot.id),
      ["RBT-001"],
    );
    assert.equal(sent.body.summary.total, 1);
    assert.equal(sent.body.summary.moving, 1);
  });

  it("matches q against the id or the display name, case-insensitively", async () => {
    const db = freshDb();
    seed(db, "RBT-001", 500);
    seed(db, "FORK-002", 500);
    db.prepare("UPDATE robots SET name = ? WHERE id = ?").run("Forklift Two", "FORK-002");

    const byName = await send(db, "?q=forklift");
    assert.deepEqual(
      byName.body.robots.map((robot) => robot.id),
      ["FORK-002"],
    );

    const byId = await send(db, "?q=rbt");
    assert.deepEqual(
      byId.body.robots.map((robot) => robot.id),
      ["RBT-001"],
    );

    const miss = await send(db, "?q=does-not-exist");
    assert.deepEqual(miss.body.robots, []);
    assert.equal(miss.body.summary.total, 0);
  });

  it("narrows the list by status but keeps the summary over the whole filtered fleet", async () => {
    const db = freshDb();
    seed(db, "RBT-001", 500);
    seed(db, "RBT-002", 500, { motion: "idle" });
    seed(db, "RBT-003", 500, { errorCode: "E_STUCK" });

    const sent = await send(db, "?status=fault");

    assert.equal(sent.status, 200);
    assert.deepEqual(
      sent.body.robots.map((robot) => robot.id),
      ["RBT-003"],
    );
    // The decision under test: chips stay useful while a status is selected.
    assert.equal(sent.body.summary.total, 3);
    assert.equal(sent.body.summary.fault, 1);
    assert.equal(sent.body.summary.moving, 1);
    assert.equal(sent.body.summary.idle, 1);
  });

  it("answers an unknown status with 400 invalid_query naming the allowed values", async () => {
    const sent = await send(freshDb(), "?status=nope");

    assert.equal(sent.status, 400);
    assert.equal(sent.body.error?.code, "invalid_query");
    assert.match(sent.body.error?.message ?? "", /status/);
    const details = sent.body.error?.details as { parameter: string; allowed: readonly string[] };
    assert.equal(details.parameter, "status");
    assert.deepEqual(details.allowed, ROBOT_STATUSES);
  });

  it("treats blank parameters as absent and ignores parameters it does not know", async () => {
    const db = freshDb();
    seed(db, "RBT-001", 500);

    const blank = await send(db, "?site=&q=%20%20&status=");
    assert.equal(blank.status, 200);
    assert.equal(blank.body.robots.length, 1);
    assert.equal(blank.body.summary.total, 1);

    const extra = await send(db, "?foo=bar&site=unassigned");
    assert.equal(extra.status, 200);
    assert.equal(extra.body.robots.length, 1);
  });

  it("clamps age at 0 when a report arrives from the future", async () => {
    const db = freshDb();
    // Server clock behind the recorded receive time: the delta must not go negative.
    ingestReports(db, [report("RBT-001", 1)], NOW + 5_000);

    const sent = await send(db);

    const robot = byId(sent.body, "RBT-001");
    assert.equal(robot.ageMs, 0);
    assert.equal(robot.status, "moving");
  });

  it("reports a faulted robot that went silent as offline, not fault", async () => {
    const db = freshDb();
    seed(db, "RBT-001", 11_000, { errorCode: "E_STUCK" });

    const sent = await send(db);

    assert.equal(byId(sent.body, "RBT-001").status, "offline");
    assert.equal(sent.body.summary.offline, 1);
    assert.equal(sent.body.summary.fault, 0);
  });

  it("counts samples by server receive time inside the last minute only", async () => {
    const db = freshDb();
    ingestReports(db, [report("RBT-001", 0)], NOW - 61_000); // 61 s: outside
    ingestReports(db, [report("RBT-001", 1)], NOW - 59_000); // inside
    ingestReports(db, [report("RBT-001", 2)], NOW - 30_000); // inside, and the latest
    ingestReports(db, [report("RBT-002", 1)], NOW - 100); // another robot's tick
    ingestReports(db, [report("RBT-003", 1)], NOW - 60_000); // exactly on the edge

    const sent = await send(db);

    const one = byId(sent.body, "RBT-001");
    assert.equal(one.samplesLastMinute, 2, "61 s is out, 59 s is in");
    assert.equal(one.receivedAt, NOW - 30_000);
    assert.equal(byId(sent.body, "RBT-002").samplesLastMinute, 1);
    assert.equal(byId(sent.body, "RBT-003").samplesLastMinute, 1, "the window includes its edge");
  });
});
