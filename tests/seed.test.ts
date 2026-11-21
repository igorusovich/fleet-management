import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import Database from "better-sqlite3";

import { openDatabase } from "../lib/db/client";
import { upsertRobotMetadata } from "../lib/db/telemetry";
import { buildSeedRobots, parseSeedArgs } from "../scripts/seed";

const T0 = 1_700_000_000_000;

const handles: Database.Database[] = [];
const directories: string[] = [];

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-seed-"));
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

describe("seed", () => {
  it("builds the simulator's ids with distinct curated metadata", () => {
    const robots = buildSeedRobots(20);

    assert.equal(robots.length, 20);
    assert.equal(robots[0]!.id, "RBT-001");
    assert.equal(robots[19]!.id, "RBT-020");
    assert.equal(new Set(robots.map((robot) => robot.id)).size, 20);
    assert.ok(robots.every((robot) => robot.name !== robot.id));
    assert.deepEqual(new Set(robots.map((robot) => robot.siteId)), new Set([
      "site-berlin",
      "site-rotterdam",
      "site-lyon",
    ]));
  });

  it("upserts metadata, preserves created_at, and never touches telemetry", () => {
    const db = freshDb();

    upsertRobotMetadata(db, buildSeedRobots(2), T0);
    const created = db
      .prepare("SELECT id, name, site_id, model, created_at FROM robots ORDER BY id")
      .all() as {
      id: string;
      name: string;
      site_id: string;
      model: string;
      created_at: number;
    }[];

    assert.equal(created.length, 2);
    assert.equal(created[0]!.name, "Atlas 01");
    assert.equal(created[0]!.created_at, T0);

    // Re-running with a hand-edited name updates the curation, keeps the age,
    // and leaves an existing robot's history alone.
    db.prepare(
      `INSERT INTO telemetry
         (robot_id, seq, device_ts, received_at, battery, charging, motion, x, y, heading, speed, error_code)
       VALUES ('RBT-001', 1, ?, ?, 80, 0, 'moving', 0, 0, 0, 1, NULL)`,
    ).run(T0, T0);

    upsertRobotMetadata(
      db,
      [{ id: "RBT-001", name: "Atlas Prime", siteId: "site-lyon", model: "TL-3" }],
      T0 + 5_000,
    );

    const updated = db
      .prepare("SELECT name, site_id, model, created_at FROM robots WHERE id = 'RBT-001'")
      .get() as { name: string; site_id: string; model: string; created_at: number };
    assert.deepEqual(updated, {
      name: "Atlas Prime",
      site_id: "site-lyon",
      model: "TL-3",
      created_at: T0,
    });

    const telemetry = db.prepare("SELECT count(*) AS n FROM telemetry").get() as { n: number };
    assert.equal(telemetry.n, 1);
  });

  it("parses flags: default, explicit count, help and errors", () => {
    assert.deepEqual(parseSeedArgs([]), { kind: "run", count: 20 });
    assert.deepEqual(parseSeedArgs(["--robots", "5"]), { kind: "run", count: 5 });
    assert.deepEqual(parseSeedArgs(["--help"]), { kind: "help" });
    assert.equal(parseSeedArgs(["--robots", "0"]).kind, "error");
    assert.equal(parseSeedArgs(["--robots", "201"]).kind, "error");
    assert.equal(parseSeedArgs(["--robots"]).kind, "error");
    assert.equal(parseSeedArgs(["--nope"]).kind, "error");
  });
});
