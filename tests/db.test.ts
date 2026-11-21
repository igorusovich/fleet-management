import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type Database from "better-sqlite3";

import { openDatabase } from "../lib/db/client";
import { SCHEMA_VERSION } from "../lib/db/schema";
import { getLatest, ingestReports, listLatest } from "../lib/db/telemetry";
import type { TelemetryReport } from "../lib/telemetry/schema";

const T0 = 1_700_000_000_000;

const handles: Database.Database[] = [];
const directories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-db-"));
  directories.push(dir);
  return dir;
}

/** A fresh database on a real file: WAL and reopen behaviour need a file. */
function freshDb(file = "fleet.db"): Database.Database {
  const db = openDatabase(path.join(tempDir(), file));
  handles.push(db);
  return db;
}

function track(db: Database.Database): Database.Database {
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

function count(db: Database.Database, table: "telemetry" | "robots" | "robot_latest"): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe("db layer", () => {
  it("creates the schema, pragmas and version, including missing parent directories", () => {
    const dir = tempDir();
    // `data/` is gitignored, so a fresh clone has no directory at all.
    const db = track(openDatabase(path.join(dir, "nested/deeper/fleet.db")));

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = tables.map((table) => table.name);
    for (const expected of ["robots", "telemetry", "robot_latest"]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }

    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("synchronous", { simple: true }), 1, "NORMAL");
    assert.equal(db.pragma("busy_timeout", { simple: true }), 5_000);
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  });

  it("stores a first batch and promotes the highest seq per robot", () => {
    const db = freshDb();

    const result = ingestReports(
      db,
      [
        report("RBT-001", 1, { battery: 90, x: 1 }),
        report("RBT-002", 1, { battery: 55, heading: 360 }),
        report("RBT-001", 2, { battery: 88, x: 5 }),
      ],
      T0 + 10,
    );

    assert.deepEqual(result, { accepted: 3, duplicates: 0 });
    assert.equal(count(db, "telemetry"), 3);
    assert.equal(count(db, "robot_latest"), 2);

    const one = getLatest(db, "RBT-001");
    assert.ok(one);
    assert.equal(one.seq, 2);
    assert.equal(one.battery, 88);
    assert.equal(one.x, 5);
    assert.equal(one.receivedAt, T0 + 10);
    assert.equal(one.charging, false);

    const two = getLatest(db, "RBT-002");
    assert.ok(two);
    assert.equal(two.heading, 0, "360 is the same bearing as 0");
  });

  it("counts a replayed batch as duplicates and does not refresh received_at", () => {
    const db = freshDb();
    const batch = [report("RBT-001", 1), report("RBT-002", 1)];

    ingestReports(db, batch, T0);
    const before = getLatest(db, "RBT-001");
    assert.ok(before);

    // A retried batch arrives a minute later: it must not make the robots look
    // freshly alive.
    const again = ingestReports(db, batch, T0 + 60_000);

    assert.deepEqual(again, { accepted: 0, duplicates: 2 });
    assert.equal(count(db, "telemetry"), 2);

    const afterReplay = getLatest(db, "RBT-001");
    assert.ok(afterReplay);
    assert.equal(afterReplay.receivedAt, before.receivedAt);
  });

  it("keeps a late report in history without rewinding the read model", () => {
    const db = freshDb();
    ingestReports(db, [report("RBT-001", 5, { battery: 70, x: 4 })], T0);

    const late = ingestReports(db, [report("RBT-001", 4, { battery: 12, x: -9 })], T0 + 1_000);

    assert.deepEqual(late, { accepted: 1, duplicates: 0 });
    assert.equal(count(db, "telemetry"), 2);

    const latest = getLatest(db, "RBT-001");
    assert.ok(latest);
    assert.equal(latest.seq, 5);
    assert.equal(latest.battery, 70);
    assert.equal(latest.x, 4);

    const stored = db
      .prepare("SELECT battery FROM telemetry WHERE robot_id = ? AND seq = ?")
      .get("RBT-001", 4) as { battery: number } | undefined;
    assert.ok(stored);
    assert.equal(stored.battery, 12, "history keeps the late report");
  });

  it("treats the same seq with a different payload as a duplicate", () => {
    const db = freshDb();
    ingestReports(db, [report("RBT-001", 3, { battery: 50, x: 7 })], T0);

    const dup = ingestReports(db, [report("RBT-001", 3, { battery: 11, x: 99 })], T0 + 5_000);

    assert.deepEqual(dup, { accepted: 0, duplicates: 1 });
    const latest = getLatest(db, "RBT-001");
    assert.ok(latest);
    assert.equal(latest.battery, 50, "first write wins");
    assert.equal(latest.x, 7);
    assert.equal(latest.receivedAt, T0);
  });

  it("keeps per-robot sequence counters independent", () => {
    const db = freshDb();

    ingestReports(db, [report("RBT-001", 9, { battery: 30 })], T0);
    ingestReports(db, [report("RBT-002", 2, { battery: 60 })], T0 + 1_000);

    const two = getLatest(db, "RBT-002");
    assert.ok(two);
    assert.equal(two.seq, 2, "RBT-001 being ahead does not block RBT-002");
    assert.equal(two.battery, 60);

    const advanced = ingestReports(db, [report("RBT-002", 3)], T0 + 2_000);
    assert.deepEqual(advanced, { accepted: 1, duplicates: 0 });
  });

  it("lists one row per robot, ordered by id, with the fields the API needs", () => {
    const db = freshDb();
    ingestReports(
      db,
      [
        report("RBT-003", 1, { battery: 42, errorCode: "E_STUCK" }),
        report("RBT-001", 1),
        report("RBT-002", 1, { charging: true, motion: "charging" }),
        report("RBT-001", 2),
      ],
      T0 + 250,
    );

    const rows = listLatest(db);

    assert.deepEqual(
      rows.map((row) => row.robotId),
      ["RBT-001", "RBT-002", "RBT-003"],
    );
    assert.equal(rows.length, 3);

    const faulted = rows[2];
    assert.ok(faulted);
    assert.equal(faulted.errorCode, "E_STUCK");
    assert.equal(faulted.receivedAt, T0 + 250);

    const charging = rows[1];
    assert.ok(charging);
    assert.equal(charging.charging, true);
    assert.equal(charging.motion, "charging");
  });

  it("returns null for a robot that has never reported", () => {
    const db = freshDb();
    assert.equal(getLatest(db, "RBT-404"), null);
  });

  it("persists across a reopen without re-running the migration", () => {
    const dir = tempDir();
    const file = path.join(dir, "fleet.db");

    const first = openDatabase(file);
    ingestReports(first, [report("RBT-001", 1), report("RBT-001", 2, { battery: 61 })], T0);
    first.close();

    const second = track(openDatabase(file));

    const rows = listLatest(second);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.seq, 2);
    assert.equal(rows[0]?.battery, 61);
    assert.equal(second.pragma("user_version", { simple: true }), SCHEMA_VERSION);

    const more = ingestReports(second, [report("RBT-001", 3)], T0 + 1_000);
    assert.deepEqual(more, { accepted: 1, duplicates: 0 });
    assert.equal(count(second, "telemetry"), 3);
  });

  it("lets a second connection read a committed batch", () => {
    const dir = tempDir();
    const file = path.join(dir, "fleet.db");
    const writer = track(openDatabase(file));
    const reader = track(openDatabase(file));

    ingestReports(writer, [report("RBT-001", 1)], T0);
    assert.equal(listLatest(reader).length, 1, "reader sees the committed row");

    ingestReports(writer, [report("RBT-002", 1)], T0 + 1_000);
    assert.equal(listLatest(reader).length, 2);
  });

  it("auto-registers unknown robots and never overwrites a curated name", () => {
    const db = freshDb();
    ingestReports(db, [report("RBT-009", 1)], T0);

    const created = db
      .prepare("SELECT name, site_id, model, created_at FROM robots WHERE id = ?")
      .get("RBT-009") as
      | { name: string; site_id: string; model: string; created_at: number }
      | undefined;
    assert.ok(created);
    assert.equal(created.name, "RBT-009");
    assert.equal(created.site_id, "unassigned");
    assert.equal(created.model, "unknown");
    assert.equal(created.created_at, T0);

    // Task 10 can enrich metadata later; the next telemetry tick must not undo it.
    db.prepare("UPDATE robots SET name = ?, site_id = ? WHERE id = ?").run(
      "Top Loader",
      "site-berlin",
      "RBT-009",
    );
    ingestReports(db, [report("RBT-009", 2)], T0 + 1_000);

    assert.equal(count(db, "robots"), 1);
    const curated = db.prepare("SELECT name FROM robots WHERE id = ?").get("RBT-009") as {
      name: string;
    };
    assert.equal(curated.name, "Top Loader");
  });

  it("accepts an empty batch without opening a transaction", () => {
    const db = freshDb();
    assert.deepEqual(ingestReports(db, [], T0), { accepted: 0, duplicates: 0 });
    assert.equal(count(db, "telemetry"), 0);
  });
});
