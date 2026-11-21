import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULTS, MAX_ROBOTS, parseArgs, usage } from "../simulator/args";
import {
  CHARGE_PCT_PER_S,
  DOCK_AT_PCT,
  DRAIN_PCT_PER_M,
  RESUME_AT_PCT,
  WAYPOINT_BOUNDS_M,
  advanceRobot,
  createFleet,
  tickFleet,
  toReport,
  type Robot,
} from "../simulator/robot";
import { reportSchema } from "../lib/telemetry/schema";

const T0 = 1_700_000_000_000;

function first(fleet: readonly Robot[]): Robot {
  const robot = fleet[0];
  assert.ok(robot, "expected a robot in the fleet");
  return robot;
}

/** Run N one-second ticks that never drop, returning every report. */
function runTicks(fleet: Robot[], ticks: number): ReturnType<typeof tickFleet>["reports"] {
  const reports: ReturnType<typeof tickFleet>["reports"] = [];
  for (let index = 0; index < ticks; index += 1) {
    reports.push(
      ...tickFleet(fleet, { dtSeconds: 1, now: T0 + index * 1_000, dropRate: 0 }).reports,
    );
  }
  return reports;
}

describe("simulator fleet model", () => {
  it("builds ids RBT-001… with fresh, distinct state", () => {
    const fleet = createFleet({ robots: 3, seed: 7 });

    assert.deepEqual(
      fleet.map((robot) => robot.id),
      ["RBT-001", "RBT-002", "RBT-003"],
    );
    for (const robot of fleet) {
      assert.equal(robot.seq, 0);
      assert.equal(robot.mode, "cruising");
      assert.equal(robot.faultCode, null);
      assert.ok(robot.battery >= 55 && robot.battery <= 95, `battery ${robot.battery}`);
    }
  });

  it("replays identically from the same seed and differs from another", () => {
    const run = (seed: number) => runTicks(createFleet({ robots: 4, seed }), 50);

    assert.deepEqual(run(99), run(99));
    assert.notDeepEqual(run(99), run(100));
  });

  it("advances seq once per tick per robot, even when the report is dropped", () => {
    const fleet = createFleet({ robots: 2, seed: 4 });
    runTicks(fleet, 10);
    assert.deepEqual(
      fleet.map((robot) => robot.seq),
      [10, 10],
    );

    const dropped = tickFleet(fleet, { dtSeconds: 1, now: T0, dropRate: 1 });
    assert.equal(dropped.reports.length, 0);
    assert.equal(dropped.dropped, 2);
    assert.deepEqual(
      fleet.map((robot) => robot.seq),
      [11, 11],
      "the robot sampled; only the report was lost",
    );
  });

  it("starts seq at the given base, so a restart is not a replay", () => {
    const fleet = createFleet({ robots: 2, seed: 2, seqBase: 5_000 });
    assert.deepEqual(
      fleet.map((robot) => robot.seq),
      [5_000, 5_000],
    );

    const { reports } = tickFleet(fleet, { dtSeconds: 1, now: T0, dropRate: 0 });
    assert.deepEqual(
      reports.map((report) => report.seq),
      [5_001, 5_001],
    );
  });

  it("only ever emits reports the ingest schema accepts", () => {
    const fleet = createFleet({ robots: 5, seed: 21 });

    for (const report of runTicks(fleet, 300)) {
      const parsed = reportSchema.safeParse(report);
      assert.ok(
        parsed.success,
        parsed.success ? "" : `rejected report: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
  });

  it("keeps battery inside 0..100 for 5 000 ticks", () => {
    const fleet = createFleet({ robots: 2, seed: 8 });
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < 5_000; index += 1) {
      for (const robot of fleet) {
        advanceRobot(robot, 1);
        minimum = Math.min(minimum, robot.battery);
        maximum = Math.max(maximum, robot.battery);
      }
    }

    assert.ok(minimum >= 0, `battery fell to ${minimum}`);
    assert.ok(maximum <= 100, `battery rose to ${maximum}`);
  });

  it("drains battery in proportion to the distance actually travelled", () => {
    const robot = first(createFleet({ robots: 1, seed: 11 }));
    robot.battery = 90;

    let distance = 0;
    let previousX = robot.x;
    let previousY = robot.y;

    for (let index = 0; index < 60; index += 1) {
      advanceRobot(robot, 1);
      distance += Math.hypot(robot.x - previousX, robot.y - previousY);
      previousX = robot.x;
      previousY = robot.y;
    }

    const lost = 90 - robot.battery;
    assert.ok(distance > 0, "the robot should have moved");
    assert.ok(
      Math.abs(lost - distance * DRAIN_PCT_PER_M) < 1e-9,
      `lost ${lost} for ${distance} m`,
    );
  });

  it("heads for the dock below 18 % and charges once there", () => {
    const robot = first(createFleet({ robots: 1, seed: 3 }));
    robot.battery = DOCK_AT_PCT - 0.5;

    advanceRobot(robot, 1, { faultRate: 0 });
    assert.equal(robot.mode, "returning");
    const homeward = toReport(robot, T0);
    assert.equal(homeward.motion, "moving", "returning is still moving");
    assert.equal(homeward.charging, false, "not on the dock yet");

    robot.x = 0;
    robot.y = 0;
    advanceRobot(robot, 1, { faultRate: 0 });
    assert.equal(robot.mode, "charging");
    const docked = toReport(robot, T0);
    assert.equal(docked.motion, "charging");
    assert.equal(docked.charging, true);
    assert.equal(docked.speed, 0);
  });

  it("leaves the dock at 95 % and charges at the documented rate", () => {
    const robot = first(createFleet({ robots: 1, seed: 6 }));
    robot.mode = "charging";
    robot.battery = RESUME_AT_PCT - CHARGE_PCT_PER_S / 2;

    advanceRobot(robot, 1, { faultRate: 0 });

    assert.equal(robot.mode, "cruising");
    assert.ok(robot.battery >= RESUME_AT_PCT, `battery ${robot.battery}`);
    assert.equal(toReport(robot, T0).charging, false);
  });

  it("keeps positions inside the site bounds for 5 000 ticks", () => {
    const fleet = createFleet({ robots: 3, seed: 12 });
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < 5_000; index += 1) {
      for (const robot of fleet) {
        advanceRobot(robot, 1);
        minX = Math.min(minX, robot.x);
        maxX = Math.max(maxX, robot.x);
        minY = Math.min(minY, robot.y);
        maxY = Math.max(maxY, robot.y);
      }
    }

    assert.ok(minX >= -WAYPOINT_BOUNDS_M && maxX <= WAYPOINT_BOUNDS_M, `x ${minX}..${maxX}`);
    assert.ok(minY >= -WAYPOINT_BOUNDS_M && maxY <= WAYPOINT_BOUNDS_M, `y ${minY}..${maxY}`);
  });

  it("always reports a finite heading in [0, 360)", () => {
    const fleet = createFleet({ robots: 3, seed: 13 });

    for (let index = 0; index < 2_000; index += 1) {
      for (const robot of fleet) {
        advanceRobot(robot, 1);
        const { heading } = toReport(robot, T0);
        assert.ok(Number.isFinite(heading), `heading ${heading}`);
        assert.ok(heading >= 0 && heading < 360, `heading ${heading}`);
      }
    }
  });

  it("holds a fault for its whole episode, then resumes", () => {
    const robot = first(createFleet({ robots: 1, seed: 15 }));
    robot.faultCode = "E_LIDAR";
    robot.faultTicks = 3;

    const reports = [];
    for (let index = 0; index < 6; index += 1) {
      advanceRobot(robot, 1, { faultRate: 0 });
      reports.push(toReport(robot, T0));
    }

    const faulted = reports.filter((report) => report.motion === "error");
    assert.equal(faulted.length, 3, "three ticks of episode, three error reports");
    assert.ok(faulted.every((report) => report.errorCode === "E_LIDAR"));
    assert.ok(faulted.every((report) => report.speed === 0));
    assert.ok(reports.slice(3).every((report) => report.errorCode === null));
    assert.ok(reports.slice(3).every((report) => report.motion !== "error"));
  });

  it("drops by rate without turning loss into a duplicate", () => {
    const fleet = createFleet({ robots: 3, seed: 17 });

    const kept = tickFleet(fleet, { dtSeconds: 1, now: T0, dropRate: 0 });
    assert.equal(kept.reports.length, 3);
    assert.equal(kept.dropped, 0);

    const none = tickFleet(fleet, { dtSeconds: 1, now: T0, dropRate: 1 });
    assert.equal(none.reports.length, 0);
    assert.equal(none.dropped, 3);
    assert.deepEqual(
      fleet.map((robot) => robot.seq),
      [2, 2, 2],
    );
  });
});

describe("simulator arguments", () => {
  it("uses the documented defaults with no flags and no environment", () => {
    const parsed = parseArgs([], {});
    assert.equal(parsed.kind, "run");
    if (parsed.kind !== "run") return;
    assert.deepEqual(parsed.config, DEFAULTS);
  });

  it("lets flags override SIM_* variables, which override the defaults", () => {
    const fromEnv = parseArgs([], {
      SIM_ROBOTS: "5",
      SIM_INTERVAL_MS: "500",
      SIM_URL: "http://localhost:3100/api/ingest",
      INGEST_API_KEY: "env-key",
      SIM_SEED: "7",
      SIM_DROP_RATE: "0.5",
    });
    assert.equal(fromEnv.kind, "run");
    if (fromEnv.kind !== "run") return;
    assert.equal(fromEnv.config.robots, 5);
    assert.equal(fromEnv.config.intervalMs, 500);
    assert.equal(fromEnv.config.url, "http://localhost:3100/api/ingest");
    assert.equal(fromEnv.config.key, "env-key");
    assert.equal(fromEnv.config.seed, 7);
    assert.equal(fromEnv.config.dropRate, 0.5);

    const fromFlags = parseArgs(["--robots", "2", "--interval=250", "--key", "flag-key"], {
      SIM_ROBOTS: "5",
      INGEST_API_KEY: "env-key",
    });
    assert.equal(fromFlags.kind, "run");
    if (fromFlags.kind !== "run") return;
    assert.equal(fromFlags.config.robots, 2);
    assert.equal(fromFlags.config.intervalMs, 250);
    assert.equal(fromFlags.config.key, "flag-key");
    assert.equal(fromFlags.config.url, DEFAULTS.url);

    assert.equal(parseArgs(["--help"], {}).kind, "help");
    assert.match(usage(), /--robots/);
  });

  it("rejects bad flags with a message naming the flag", () => {
    const errorOf = (argv: readonly string[]): string => {
      const parsed = parseArgs(argv, {});
      assert.equal(parsed.kind, "error", `expected ${argv.join(" ")} to fail`);
      return parsed.kind === "error" ? parsed.message : "";
    };

    assert.match(errorOf(["--robots", "0"]), new RegExp(`--robots.*between 1 and ${MAX_ROBOTS}`));
    assert.match(errorOf(["--robots", "2.5"]), /whole number/);
    assert.match(errorOf(["--interval", "soon"]), /--interval/);
    assert.match(errorOf(["--drop-rate", "2"]), /between 0 and 1/);
    assert.match(errorOf(["--url", "ftp://example.com"]), /http\(s\) URL/);
    assert.match(errorOf(["--key", ""]), /--key/);
    assert.match(errorOf(["--nope"]), /unknown option --nope/);
    assert.match(errorOf(["--robots"]), /needs a value/);
  });
});
