import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type Database from "better-sqlite3";

import { openDatabase } from "../lib/db/client";
import { getLatest, listLatest } from "../lib/db/telemetry";
import { MAX_BODY_BYTES, handleIngest, type IngestDeps } from "../lib/http/ingest";
import type { TelemetryReport } from "../lib/telemetry/schema";

const T0 = 1_700_000_000_000;
const KEY = "test-ingest-key";
const URL = "http://localhost/api/ingest";

const handles: Database.Database[] = [];
const directories: string[] = [];

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-ingest-"));
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

function deps(db: Database.Database, overrides: Partial<IngestDeps> = {}): IngestDeps {
  return { db, expectedKey: KEY, now: T0, log: () => {}, ...overrides };
}

/** Build a POST. `key: null` omits the header; `raw` bypasses JSON.stringify. */
function post(
  body: unknown,
  options: { key?: string | null; raw?: string } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = options.key === undefined ? KEY : options.key;
  if (key !== null) headers["x-ingest-key"] = key;

  return new Request(URL, {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

interface Sent {
  status: number;
  json: unknown;
}

async function send(
  db: Database.Database,
  request: Request,
  overrides: Partial<IngestDeps> = {},
): Promise<Sent> {
  const response = await handleIngest(request, deps(db, overrides));
  return { status: response.status, json: await response.json() };
}

interface OkBody {
  accepted: number;
  duplicates: number;
  rejected: { index: number; reason: string }[];
}

interface ErrBody {
  error: { code: string; message: string; details?: unknown };
}

const ok = (sent: Sent): OkBody => sent.json as OkBody;
const err = (sent: Sent): ErrBody => sent.json as ErrBody;

describe("POST /api/ingest", () => {
  it("rejects a missing key before parsing the body", async () => {
    const db = freshDb();

    // Deliberately unparseable: a 401 here proves the key gate runs first.
    const sent = await send(db, post(null, { key: null, raw: "{not json" }));

    assert.equal(sent.status, 401);
    assert.equal(err(sent).error.code, "unauthorized");
    assert.equal(listLatest(db).length, 0);
  });

  it("rejects a wrong key and stores nothing", async () => {
    const db = freshDb();

    const sent = await send(db, post(report("RBT-001", 1), { key: "wrong-key" }));

    assert.equal(sent.status, 401);
    assert.equal(err(sent).error.code, "unauthorized");
    assert.equal(listLatest(db).length, 0);
  });

  it("never treats an empty configured key as 'no auth'", async () => {
    const db = freshDb();

    const blank = await send(db, post(report("RBT-001", 1)), { expectedKey: "" });
    const matching = await send(db, post(report("RBT-001", 1), { key: "" }), { expectedKey: "" });

    assert.equal(blank.status, 401);
    assert.equal(matching.status, 401);
    assert.equal(listLatest(db).length, 0);
  });

  it("accepts a single unwrapped report and strips unknown fields", async () => {
    const db = freshDb();

    // A chatty device with extra fields must not break ingest, and 360 is 0.
    const sent = await send(db, post({ ...report("RBT-001", 7, { heading: 360 }), firmware: "9.1" }));

    assert.equal(sent.status, 200);
    assert.deepEqual(ok(sent), { accepted: 1, duplicates: 0, rejected: [] });

    const latest = getLatest(db, "RBT-001");
    assert.ok(latest);
    assert.equal(latest.seq, 7);
    assert.equal(latest.heading, 0, "360 is stored as 0");
  });

  it("accepts a batch and reports accepted and duplicate counts", async () => {
    const db = freshDb();

    const sent = await send(
      db,
      post({
        reports: [report("RBT-001", 1), report("RBT-002", 1), report("RBT-001", 2)],
      }),
    );

    assert.equal(sent.status, 200);
    assert.deepEqual(ok(sent), { accepted: 3, duplicates: 0, rejected: [] });
    assert.equal(listLatest(db).length, 2);
  });

  it("answers malformed JSON with 400 invalid_json", async () => {
    const db = freshDb();

    const sent = await send(db, post(null, { raw: '{"reports": [' }));

    assert.equal(sent.status, 400);
    assert.equal(err(sent).error.code, "invalid_json");
    assert.equal(listLatest(db).length, 0);
  });

  it("answers an oversized body with 413 before parsing it", async () => {
    const db = freshDb();

    // Not valid JSON either: the 413 proves the size gate runs before the parser.
    const sent = await send(db, post(null, { raw: "x".repeat(MAX_BODY_BYTES + 1) }));

    assert.equal(sent.status, 413);
    assert.equal(err(sent).error.code, "payload_too_large");
    assert.equal(listLatest(db).length, 0);
  });

  it("answers a body that is neither a report nor an envelope with 400 invalid_body", async () => {
    const db = freshDb();

    const array = await send(db, post([report("RBT-001", 1)]));
    const empty = await send(db, post({}));

    assert.equal(array.status, 400);
    assert.equal(err(array).error.code, "invalid_body");
    assert.equal(empty.status, 400);
    assert.equal(err(empty).error.code, "invalid_body");
    assert.equal(listLatest(db).length, 0);
  });

  it("answers an empty reports array with 400 empty_batch", async () => {
    const db = freshDb();

    const sent = await send(db, post({ reports: [] }));

    assert.equal(sent.status, 400);
    assert.equal(err(sent).error.code, "empty_batch");
  });

  it("answers more than 500 reports with 400 batch_too_large", async () => {
    const db = freshDb();
    const reports = Array.from({ length: 501 }, (_, index) => report("RBT-001", index));

    const sent = await send(db, post({ reports }));

    assert.equal(sent.status, 400);
    assert.equal(err(sent).error.code, "batch_too_large");
    assert.deepEqual(err(sent).error.details, { received: 501, limit: 500 });
    assert.equal(listLatest(db).length, 0);
  });

  it("keeps the good reports when one report in the batch is invalid", async () => {
    const db = freshDb();

    const sent = await send(
      db,
      post({
        reports: [
          report("RBT-001", 1),
          report("RBT-002", 1, { battery: 150 }),
          report("RBT-003", 1),
        ],
      }),
    );

    assert.equal(sent.status, 200);
    const body = ok(sent);
    assert.equal(body.accepted, 2);
    assert.equal(body.duplicates, 0);
    assert.equal(body.rejected.length, 1);
    assert.equal(body.rejected[0]?.index, 1);
    assert.match(body.rejected[0]?.reason ?? "", /battery/);

    assert.deepEqual(
      listLatest(db).map((row) => row.robotId),
      ["RBT-001", "RBT-003"],
    );
  });

  it("answers an entirely invalid batch with 400 invalid_reports and stores nothing", async () => {
    const db = freshDb();

    const sent = await send(
      db,
      post({
        reports: [
          report("bad robot", 1),
          report("RBT-001", -1),
        ],
      }),
    );

    assert.equal(sent.status, 400);
    assert.equal(err(sent).error.code, "invalid_reports");
    const details = err(sent).error.details as { rejected: { index: number; reason: string }[] };
    assert.deepEqual(
      details.rejected.map((entry) => entry.index),
      [0, 1],
    );
    assert.equal(listLatest(db).length, 0);
  });

  it("counts a replayed batch as duplicates and does not refresh received_at", async () => {
    const db = freshDb();
    const body = { reports: [report("RBT-001", 1), report("RBT-002", 1)] };

    await send(db, post(body));
    const replay = await send(db, post(body), { now: T0 + 60_000 });

    assert.equal(replay.status, 200);
    assert.deepEqual(ok(replay), { accepted: 0, duplicates: 2, rejected: [] });

    const latest = getLatest(db, "RBT-001");
    assert.ok(latest);
    assert.equal(latest.receivedAt, T0, "a retry is not a sign of life");
  });

  it("stores an out-of-order report without rewinding the read model", async () => {
    const db = freshDb();

    await send(db, post(report("RBT-001", 5, { battery: 70 })));
    const late = await send(db, post(report("RBT-001", 4, { battery: 12 })), { now: T0 + 1_000 });

    assert.equal(late.status, 200);
    assert.equal(ok(late).accepted, 1);

    const latest = getLatest(db, "RBT-001");
    assert.ok(latest);
    assert.equal(latest.seq, 5);
    assert.equal(latest.battery, 70);
  });
});
