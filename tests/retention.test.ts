import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import Database from "better-sqlite3";

import { openDatabase } from "../lib/db/client";
import { createRetentionSweeper, sweepTelemetry } from "../lib/db/retention";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

const handles: Database.Database[] = [];
const directories: string[] = [];

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-retention-"));
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

function insert(db: Database.Database, robotId: string, seq: number, receivedAt: number): void {
  db.prepare(
    `INSERT INTO telemetry
       (robot_id, seq, device_ts, received_at, battery, charging, motion, x, y, heading, speed, error_code)
     VALUES (?, ?, ?, ?, 80, 0, 'moving', 1, 2, 0, 1, NULL)`,
  ).run(robotId, seq, receivedAt, receivedAt);
}

function telemetryRows(db: Database.Database): number {
  return (db.prepare("SELECT count(*) AS n FROM telemetry").get() as { n: number }).n;
}

describe("retention sweep", () => {
  it("deletes rows older than the cutoff and keeps the boundary row", () => {
    const db = freshDb();
    const cutoff = T0 - 24 * HOUR;

    insert(db, "RBT-001", 1, cutoff - 1);
    insert(db, "RBT-001", 2, cutoff);
    insert(db, "RBT-001", 3, cutoff + 1);

    const result = sweepTelemetry(db, { now: T0, retentionHours: 24 });

    assert.equal(result.deleted, 1);
    assert.equal(telemetryRows(db), 2);
    const seqs = (
      db.prepare("SELECT seq FROM telemetry ORDER BY seq").all() as { seq: number }[]
    ).map((row) => row.seq);
    assert.deepEqual(seqs, [2, 3]);
  });

  it("reports the cutoff it used and counts an empty sweep as zero", () => {
    const db = freshDb();

    const empty = sweepTelemetry(db, { now: T0, retentionHours: 1.5 });
    assert.deepEqual(empty, { deleted: 0, cutoff: T0 - 1.5 * HOUR });
  });

  it("never sweeps the read model or robot metadata", () => {
    const db = freshDb();

    // A batch 30 h old, promoted into robot_latest by its seq.
    db.prepare(
      `INSERT INTO robots (id, name, site_id, model, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("RBT-OLD", "Old One", "site-berlin", "TL-2", T0 - 40 * HOUR);
    insert(db, "RBT-OLD", 1, T0 - 30 * HOUR);
    insert(db, "RBT-OLD", 2, T0 - 29 * HOUR);
    db.prepare(
      `INSERT INTO robot_latest
         (robot_id, seq, device_ts, received_at, battery, charging, motion, x, y, heading, speed, error_code)
       VALUES (?, 2, ?, ?, 42, 0, 'idle', 3, 4, 90, 0, NULL)`,
    ).run("RBT-OLD", T0 - 29 * HOUR, T0 - 29 * HOUR);

    const result = sweepTelemetry(db, { now: T0, retentionHours: 24 });
    assert.equal(result.deleted, 2);
    assert.equal(telemetryRows(db), 0);

    const latest = db
      .prepare("SELECT robot_id, battery FROM robot_latest")
      .all() as { robot_id: string; battery: number }[];
    assert.deepEqual(latest, [{ robot_id: "RBT-OLD", battery: 42 }]);

    const robots = db.prepare("SELECT count(*) AS n FROM robots").get() as { n: number };
    assert.equal(robots.n, 1);
  });

  it("throttles: a second call inside the interval is skipped, at it runs", () => {
    const db = freshDb();
    const sweeper = createRetentionSweeper({
      db,
      retentionHours: 24,
      minIntervalMs: 60_000,
      log: () => {},
    });

    insert(db, "RBT-001", 1, T0 - 25 * HOUR);
    assert.equal(sweeper.run(T0)?.deleted, 1);

    insert(db, "RBT-001", 2, T0 - 24 * HOUR - 1);
    assert.equal(sweeper.run(T0 + 1_000), null);
    assert.equal(sweeper.run(T0 + 59_999), null);
    assert.equal(telemetryRows(db), 1);

    assert.equal(sweeper.run(T0 + 60_000)?.deleted, 1);
    assert.equal(telemetryRows(db), 0);
  });

  it("leaves rows received after the cutoff untouched", () => {
    const db = freshDb();
    insert(db, "RBT-001", 1, T0 - 1_000);
    insert(db, "RBT-001", 2, T0);

    const result = sweepTelemetry(db, { now: T0, retentionHours: 24 });

    assert.equal(result.deleted, 0);
    assert.equal(telemetryRows(db), 2);
  });
});
