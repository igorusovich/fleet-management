import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type Database from "better-sqlite3";

import { openDatabase } from "../lib/db/client";
import { ingestReports } from "../lib/db/telemetry";
import { INGEST_KEY_HEADER } from "../lib/http/auth";
import { buildFleetSnapshot, type FleetResponseBody } from "../lib/http/fleet";
import { handleIngest } from "../lib/http/ingest";
import {
  STREAM_HEARTBEAT_MS,
  STREAM_RETRY_MS,
  STREAM_TICK_MS,
  handleStream,
  type SnapshotSource,
} from "../lib/http/stream";
import { FleetStream, type EventSourceLike } from "../lib/stream/client";
import { createFleetHub } from "../lib/stream/hub";
import type { TelemetryReport } from "../lib/telemetry/schema";
import type { StatusThresholds } from "../lib/telemetry/status";

const T0 = 1_700_000_000_000;
const NOW = T0 + 600_000;
const KEY = "stream-test-key";

const THRESHOLDS: StatusThresholds = {
  offlineAfterMs: 10_000,
  delayedAfterMs: 3_000,
  lowBatteryPct: 20,
};

/** Mutable server clock: tests move time without sleeping. */
let clock = NOW;

const handles: Database.Database[] = [];
const directories: string[] = [];

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-stream-"));
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

function seed(db: Database.Database, robotId: string, ageMs: number, overrides: Partial<TelemetryReport> = {}): void {
  ingestReports(db, [report(robotId, 1, overrides)], NOW - ageMs);
}

function hubFor(db: Database.Database, build?: () => FleetResponseBody) {
  return createFleetHub({
    build: build ?? (() => buildFleetSnapshot({ db, thresholds: THRESHOLDS, now: clock })),
    tickMs: STREAM_TICK_MS,
    now: () => clock,
  });
}

/** A `setInterval` that only runs when the test says so. */
class ManualTimers {
  private callback: (() => void) | undefined;
  delayMs: number | undefined;
  cleared = 0;
  readonly schedule = (callback: () => void, ms: number): unknown => {
    this.callback = callback;
    this.delayMs = ms;
    return this;
  };
  readonly cancel = (): void => {
    this.cleared += 1;
  };
  fire(): void {
    this.callback?.();
  }
}

function streamResponse(hub: SnapshotSource, timers: ManualTimers, signal?: AbortSignal): Response {
  return handleStream(new Request("http://localhost/api/stream", { signal }), {
    hub,
    now: () => clock,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
}

/** Reads `\n\n`-delimited SSE frames out of a response body. */
class FrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(response: Response) {
    const body = response.body;
    assert.ok(body, "expected a streaming body");
    this.reader = body.getReader();
  }

  async next(): Promise<string> {
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        return frame;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("the stream ended before a complete frame arrived");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  /** Wait for the stream to close, ignoring any frames still buffered. */
  async end(): Promise<void> {
    for (;;) {
      const { done } = await this.reader.read();
      if (done) return;
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }
}

function fieldOf(frame: string, name: string): string | undefined {
  const line = frame.split("\n").find((entry) => entry.startsWith(`${name}:`));
  return line?.slice(name.length + 1).trim();
}

function eventOf(frame: string): string | undefined {
  return fieldOf(frame, "event");
}

function dataOf<T = unknown>(frame: string): T {
  const data = fieldOf(frame, "data");
  assert.ok(data !== undefined, `frame has no data line: ${JSON.stringify(frame)}`);
  return JSON.parse(data) as T;
}

function post(reports: TelemetryReport[]): Request {
  return new Request("http://localhost/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", [INGEST_KEY_HEADER]: KEY },
    body: JSON.stringify({ reports }),
  });
}

function fleetBody(overrides: Partial<FleetResponseBody> = {}): FleetResponseBody {
  return {
    generatedAt: NOW,
    thresholds: THRESHOLDS,
    summary: {
      total: 0,
      moving: 0,
      idle: 0,
      charging: 0,
      low_battery: 0,
      fault: 0,
      delayed: 0,
      offline: 0,
    },
    robots: [],
    ...overrides,
  };
}

describe("GET /api/stream", () => {
  it("opens with retry and hello, advertised as an unbuffered event stream", async () => {
    clock = NOW;
    const timers = new ManualTimers();
    const response = streamResponse(hubFor(freshDb()), timers);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.equal(timers.delayMs, STREAM_TICK_MS, "the tick is scheduled on open");

    const frames = new FrameReader(response);
    assert.equal(await frames.next(), `retry: ${STREAM_RETRY_MS}`);

    const hello = await frames.next();
    assert.equal(eventOf(hello), "hello");
    assert.deepEqual(dataOf(hello), {
      tickMs: STREAM_TICK_MS,
      heartbeatMs: STREAM_HEARTBEAT_MS,
      retryMs: STREAM_RETRY_MS,
      thresholds: THRESHOLDS,
      generatedAt: NOW,
    });

    await frames.cancel();
  });

  it("follows hello with a fleet frame identical to the GET /api/fleet body", async () => {
    clock = NOW;
    const db = freshDb();
    seed(db, "RBT-001", 500, { battery: 42 });
    seed(db, "RBT-002", 11_000);

    const frames = new FrameReader(streamResponse(hubFor(db), new ManualTimers()));
    await frames.next(); // retry
    await frames.next(); // hello

    const fleet = await frames.next();
    assert.equal(eventOf(fleet), "fleet");
    assert.deepEqual(
      dataOf(fleet),
      buildFleetSnapshot({ db, thresholds: THRESHOLDS, now: NOW }),
    );

    await frames.cancel();
  });

  it("tags every fleet frame with its snapshot's generatedAt as the event id", async () => {
    clock = NOW;
    const frames = new FrameReader(streamResponse(hubFor(freshDb()), new ManualTimers()));
    await frames.next();
    await frames.next();

    const fleet = await frames.next();
    assert.equal(fieldOf(fleet, "id"), String(NOW));
    assert.equal(dataOf<FleetResponseBody>(fleet).generatedAt, NOW);

    await frames.cancel();
  });

  it("emits a new frame on every tick, dated by the server clock", async () => {
    clock = NOW;
    const timers = new ManualTimers();
    const frames = new FrameReader(streamResponse(hubFor(freshDb()), timers));
    await frames.next();
    await frames.next();
    assert.equal(dataOf<FleetResponseBody>(await frames.next()).generatedAt, NOW);

    clock = NOW + 1_000;
    timers.fire();
    assert.equal(dataOf<FleetResponseBody>(await frames.next()).generatedAt, NOW + 1_000);

    clock = NOW + 2_000;
    timers.fire();
    assert.equal(dataOf<FleetResponseBody>(await frames.next()).generatedAt, NOW + 2_000);

    await frames.cancel();
  });

  it("walks a silent robot moving → delayed → offline with no writes at all", async () => {
    clock = NOW;
    const db = freshDb();
    seed(db, "RBT-001", 500);

    const timers = new ManualTimers();
    const frames = new FrameReader(streamResponse(hubFor(db), timers));
    await frames.next();
    await frames.next();

    const first = dataOf<FleetResponseBody>(await frames.next());
    assert.equal(first.robots[0]?.status, "moving");

    // Nothing is posted; only the clock moves.
    clock = NOW + 3_500;
    timers.fire();
    const second = dataOf<FleetResponseBody>(await frames.next());
    assert.equal(second.robots[0]?.status, "delayed");
    assert.equal(second.robots[0]?.ageMs, 4_000);

    clock = NOW + 10_500;
    timers.fire();
    const third = dataOf<FleetResponseBody>(await frames.next());
    assert.equal(third.robots[0]?.status, "offline");
    assert.equal(third.summary.offline, 1);

    await frames.cancel();
  });

  it("serves two connections from one build within a tick", async () => {
    clock = NOW;
    let builds = 0;
    const db = freshDb();
    seed(db, "RBT-001", 500);
    const hub = hubFor(db, () => {
      builds += 1;
      return buildFleetSnapshot({ db, thresholds: THRESHOLDS, now: clock });
    });

    const one = new FrameReader(streamResponse(hub, new ManualTimers()));
    const two = new FrameReader(streamResponse(hub, new ManualTimers()));
    for (const frames of [one, two]) {
      await frames.next();
      await frames.next();
    }

    const first = dataOf<FleetResponseBody>(await one.next());
    const second = dataOf<FleetResponseBody>(await two.next());
    assert.equal(builds, 1, "one query per tick, not one per connection");
    assert.equal(first.generatedAt, second.generatedAt);
    assert.deepEqual(first, second);

    await one.cancel();
    await two.cancel();
  });

  it("rebuilds immediately after invalidate, so an accepted report shows up next frame", async () => {
    clock = NOW;
    const db = freshDb();
    let builds = 0;
    const hub = hubFor(db, () => {
      builds += 1;
      return buildFleetSnapshot({ db, thresholds: THRESHOLDS, now: clock });
    });

    assert.equal(hub.snapshot().summary.total, 0);
    assert.equal(hub.snapshot().summary.total, 0);
    assert.equal(builds, 1, "the second read inside the tick is cached");

    ingestReports(db, [report("RBT-001", 1)], NOW);
    hub.invalidate();
    assert.equal(hub.snapshot().summary.total, 1, "no waiting for the tick to expire");
    assert.equal(builds, 2);
  });

  it("writes a ping comment when a tick interval outruns the heartbeat", async () => {
    clock = NOW;
    const timers = new ManualTimers();
    const response = handleStream(new Request("http://localhost/api/stream"), {
      hub: hubFor(freshDb()),
      now: () => clock,
      tickMs: 60_000,
      heartbeatMs: STREAM_HEARTBEAT_MS,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    const frames = new FrameReader(response);
    await frames.next();
    await frames.next();
    await frames.next(); // opening snapshot

    clock = NOW + STREAM_HEARTBEAT_MS;
    timers.fire();
    assert.equal(await frames.next(), ": ping");

    await frames.cancel();
  });

  it("reports a failing snapshot as an error frame and closes", async () => {
    clock = NOW;
    const timers = new ManualTimers();
    const broken: SnapshotSource = {
      snapshot() {
        throw new Error("database is gone");
      },
    };

    const frames = new FrameReader(streamResponse(broken, timers));
    await frames.next(); // retry
    const error = await frames.next();
    assert.equal(eventOf(error), "error");
    assert.deepEqual(dataOf(error), { message: "database is gone" });

    await frames.end();
    assert.equal(timers.cleared, 0, "no tick was ever scheduled");
  });

  it("closes and cancels the tick when the client aborts", async () => {
    clock = NOW;
    const timers = new ManualTimers();
    const controller = new AbortController();
    const frames = new FrameReader(streamResponse(hubFor(freshDb()), timers, controller.signal));
    await frames.next();
    await frames.next();
    await frames.next();

    controller.abort();
    await frames.end();
    assert.equal(timers.cleared, 1, "the timer dies with the connection");

    // A late tick from the cleared timer must not enqueue into a closed stream.
    timers.fire();
  });

  it("invalidates the hub only when ingest actually stored a report", async () => {
    const db = freshDb();
    const accepted: unknown[] = [];
    const deps = {
      db,
      expectedKey: KEY,
      now: NOW,
      log: (): void => {},
      onAccepted: (stored: unknown): void => {
        accepted.push(stored);
      },
    };

    const first = await handleIngest(post([report("RBT-001", 1)]), deps);
    assert.equal(first.status, 200);
    assert.deepEqual(accepted, [{ accepted: 1, duplicates: 0 }]);

    // A replay changes nothing readable, so the cached snapshot stays valid.
    const replay = await handleIngest(post([report("RBT-001", 1)]), deps);
    assert.equal(replay.status, 200);
    assert.equal(accepted.length, 1);
  });
});

/** Let the client's promise chain drain without depending on real timers. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

type Listener = (event: { data?: unknown }) => void;

class FakeEventSource implements EventSourceLike {
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    this.dispatch(type, data === undefined ? {} : { data: JSON.stringify(data) });
  }

  emitRaw(type: string, data: string): void {
    this.dispatch(type, { data });
  }

  fail(): void {
    this.dispatch("error", {});
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** A fake `setInterval`: fires only when the test asks, and clears for real. */
class ManualInterval {
  delayMs: number | undefined;
  cleared = 0;
  private callback: (() => void) | undefined;
  readonly set = (callback: () => void, ms: number): unknown => {
    this.callback = callback;
    this.delayMs = ms;
    return this;
  };
  readonly clear = (): void => {
    this.cleared += 1;
    this.callback = undefined;
  };
  fire(): void {
    this.callback?.();
  }
}

function fakeFetch(body: unknown, urls: string[]): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return impl as unknown as typeof fetch;
}

describe("FleetStream", () => {
  it("polls /api/fleet and keeps a schedule when there is no EventSource", async () => {
    const snapshots: FleetResponseBody[] = [];
    const urls: string[] = [];
    const interval = new ManualInterval();
    const body = fleetBody();

    const stream = new FleetStream({
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      eventSourceFactory: () => undefined,
      fetchImpl: fakeFetch(body, urls),
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
    });

    stream.start();
    await flush();

    assert.equal(stream.state, "polling");
    assert.deepEqual(urls, ["/api/fleet"]);
    assert.deepEqual(snapshots, [body]);
    assert.equal(interval.delayMs, 5_000);

    stream.stop();
    assert.equal(interval.cleared, 1);
  });

  it("goes live on hello and delivers fleet frames as snapshots", () => {
    const snapshots: FleetResponseBody[] = [];
    const source = new FakeEventSource("/api/stream");
    const stream = new FleetStream({
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      eventSourceFactory: () => source,
    });

    stream.start();
    assert.equal(stream.state, "connecting");

    source.emit("hello", { tickMs: 1_000 });
    assert.equal(stream.state, "live");

    const body = fleetBody();
    source.emit("fleet", body);
    assert.deepEqual(snapshots, [body]);
    assert.equal(source.url, "/api/stream");
  });

  it("polls while the socket reconnects and stops polling once a frame arrives", async () => {
    const snapshots: FleetResponseBody[] = [];
    const urls: string[] = [];
    const interval = new ManualInterval();
    const source = new FakeEventSource("/api/stream");
    const stream = new FleetStream({
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      eventSourceFactory: () => source,
      fetchImpl: fakeFetch(fleetBody(), urls),
      setIntervalImpl: interval.set,
      clearIntervalImpl: interval.clear,
    });

    stream.start();
    source.emit("hello");
    assert.equal(stream.state, "live");

    source.fail();
    assert.equal(stream.state, "reconnecting");
    await flush();
    assert.deepEqual(urls, ["/api/fleet"], "the screen keeps updating through the gap");
    assert.equal(snapshots.length, 1);

    source.emit("fleet", fleetBody());
    assert.equal(stream.state, "live");
    assert.equal(interval.cleared, 1);

    interval.fire();
    await flush();
    assert.deepEqual(urls, ["/api/fleet"], "the poll timer is gone once the socket is back");
  });

  it("reports a malformed frame and keeps the stream usable", () => {
    const snapshots: FleetResponseBody[] = [];
    const errors: unknown[] = [];
    const source = new FakeEventSource("/api/stream");
    const stream = new FleetStream({
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: (error) => errors.push(error),
      eventSourceFactory: () => source,
    });

    stream.start();
    source.emit("hello");

    source.emitRaw("fleet", "{not json");
    assert.equal(errors.length, 1);
    assert.equal(snapshots.length, 0);

    source.emitRaw("fleet", JSON.stringify({ nonsense: true }));
    assert.equal(errors.length, 2, "a body without robots is rejected, not rendered");

    const body = fleetBody();
    source.emit("fleet", body);
    assert.deepEqual(snapshots, [body]);
  });

  it("closes the socket and stops delivering after stop()", () => {
    const snapshots: FleetResponseBody[] = [];
    const source = new FakeEventSource("/api/stream");
    const stream = new FleetStream({
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      eventSourceFactory: () => source,
    });

    stream.start();
    source.emit("hello");
    stream.stop();

    assert.equal(stream.state, "stopped");
    assert.equal(source.closed, true);

    source.emit("fleet", fleetBody());
    assert.equal(snapshots.length, 0, "a late frame is ignored after stop");
  });
});
