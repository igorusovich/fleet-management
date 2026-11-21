import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  batteryTone,
  filterRobots,
  formatAge,
  refreshStatuses,
  sortRobots,
  statusLabel,
  statusSeverity,
  summariseStatuses,
} from "../components/fleet/fleet-view";
import type { FleetRobot } from "../lib/http/fleet";

const T0 = 1_700_000_000_000;

function robot(overrides: Partial<FleetRobot> & { id: string }): FleetRobot {
  return {
    name: overrides.id,
    siteId: "unassigned",
    model: "unknown",
    status: "moving",
    battery: 80,
    charging: false,
    motion: "moving",
    x: 0,
    y: 0,
    heading: 0,
    speed: 0,
    errorCode: null,
    seq: 1,
    deviceTs: T0,
    receivedAt: T0,
    ageMs: 0,
    samplesLastMinute: 1,
    ...overrides,
  };
}

const ids = (robots: readonly FleetRobot[]): string[] => robots.map((entry) => entry.id);

describe("fleet view — filtering", () => {
  it("matches the id case-insensitively", () => {
    const fleet = [robot({ id: "RBT-001" }), robot({ id: "RBT-002" })];

    assert.deepEqual(ids(filterRobots(fleet, { query: "rbt-002" })), ["RBT-002"]);
  });

  it("matches the curated display name as well as the id", () => {
    const fleet = [
      robot({ id: "RBT-001", name: "Top Loader" }),
      robot({ id: "FORK-002", name: "Forklift Two" }),
    ];

    assert.deepEqual(ids(filterRobots(fleet, { query: "forklift" })), ["FORK-002"]);
  });

  it("treats a blank query as no filter and keeps the input order", () => {
    const fleet = [robot({ id: "RBT-002" }), robot({ id: "RBT-001" })];

    assert.deepEqual(ids(filterRobots(fleet, { query: "   " })), ["RBT-002", "RBT-001"]);
    assert.deepEqual(ids(filterRobots(fleet)), ["RBT-002", "RBT-001"]);
  });

  it("keeps exactly the robots in the selected status", () => {
    const fleet = [
      robot({ id: "RBT-001", status: "moving" }),
      robot({ id: "RBT-002", status: "fault", errorCode: "E_STUCK" }),
      robot({ id: "RBT-003", status: "fault", errorCode: "E_LIDAR" }),
    ];

    assert.deepEqual(ids(filterRobots(fleet, { status: "fault" })), ["RBT-002", "RBT-003"]);
    assert.deepEqual(ids(filterRobots(fleet, { status: "all" })), ["RBT-001", "RBT-002", "RBT-003"]);
  });

  it("ANDs the query with the status rather than ORing them", () => {
    const fleet = [
      robot({ id: "RBT-001", status: "fault" }),
      robot({ id: "RBT-002", status: "fault" }),
      robot({ id: "RBT-002-B", status: "moving" }),
    ];

    assert.deepEqual(ids(filterRobots(fleet, { query: "RBT-002", status: "fault" })), ["RBT-002"]);
  });

  it("answers no matches with an empty array, not null or a throw", () => {
    const fleet = [robot({ id: "RBT-001" })];

    assert.deepEqual(filterRobots(fleet, { query: "nothing" }), []);
    assert.deepEqual(filterRobots([], { query: "anything" }), []);
  });
});

describe("fleet view — sorting", () => {
  it("orders by severity: offline, fault, low battery, delayed, charging, moving, idle", () => {
    const fleet = [
      robot({ id: "IDLE", status: "idle" }),
      robot({ id: "MOVE", status: "moving" }),
      robot({ id: "CHG", status: "charging" }),
      robot({ id: "DELAY", status: "delayed" }),
      robot({ id: "LOW", status: "low_battery" }),
      robot({ id: "FAULT", status: "fault" }),
      robot({ id: "OFF", status: "offline" }),
    ];

    assert.deepEqual(ids(sortRobots(fleet, "severity")), [
      "OFF",
      "FAULT",
      "LOW",
      "DELAY",
      "CHG",
      "MOVE",
      "IDLE",
    ]);
    assert.equal(statusSeverity("offline"), 0);
    assert.ok(statusSeverity("fault") < statusSeverity("moving"));
  });

  it("breaks severity ties by battery, then by id", () => {
    const fleet = [
      robot({ id: "B", status: "moving", battery: 20 }),
      robot({ id: "A", status: "moving", battery: 20 }),
      robot({ id: "C", status: "moving", battery: 70 }),
      robot({ id: "Z", status: "fault", battery: 99, errorCode: "E_STUCK" }),
    ];

    assert.deepEqual(ids(sortRobots(fleet, "severity")), ["Z", "A", "B", "C"]);
  });

  it("sorts battery ascending regardless of status", () => {
    const fleet = [
      robot({ id: "RBT-001", battery: 90, status: "moving" }),
      robot({ id: "RBT-002", battery: 10, status: "offline" }),
      robot({ id: "RBT-003", battery: 50, status: "fault" }),
    ];

    assert.deepEqual(ids(sortRobots(fleet, "battery")), ["RBT-002", "RBT-003", "RBT-001"]);
  });

  it("sorts by id, not by display name", () => {
    const fleet = [
      robot({ id: "RBT-010", name: "Aardvark" }),
      robot({ id: "RBT-002", name: "Zebra" }),
      robot({ id: "RBT-001", name: "Mule" }),
    ];

    assert.deepEqual(ids(sortRobots(fleet, "id")), ["RBT-001", "RBT-002", "RBT-010"]);
  });

  it("never mutates the snapshot it was given", () => {
    const fleet = [
      robot({ id: "RBT-002", status: "idle" }),
      robot({ id: "RBT-001", status: "fault" }),
    ];
    const before = ids(fleet);

    const sorted = sortRobots(fleet, "severity");
    const filtered = filterRobots(fleet, { status: "fault" });

    assert.deepEqual(ids(fleet), before, "the input array keeps its order");
    assert.notEqual(sorted, fleet, "sorting returns a new array");
    assert.notEqual(filtered, fleet, "filtering returns a new array");
  });
});

describe("fleet view — display helpers", () => {
  it("formats ages from just now up to hours", () => {
    assert.equal(formatAge(0), "just now");
    assert.equal(formatAge(999), "just now");
    assert.equal(formatAge(1_000), "1s ago");
    assert.equal(formatAge(3_400), "3s ago");
    assert.equal(formatAge(64_000), "1m 4s ago");
    assert.equal(formatAge(120_000), "2m ago");
    assert.equal(formatAge(3_661_000), "1h 1m ago");
    assert.equal(formatAge(-5), "just now", "a device clock ahead cannot read negative");
  });

  it("uses the frame's low-battery threshold and labels low_battery for humans", () => {
    assert.equal(batteryTone(15, 20), "low");
    assert.equal(batteryTone(20, 20), "ok", "the threshold itself is not low");
    assert.equal(statusLabel("low_battery"), "low battery");
    assert.equal(statusLabel("offline"), "offline");
  });
});

describe("fleet view — status freshness", () => {
  const thresholds = { offlineAfterMs: 10_000, delayedAfterMs: 3_000, lowBatteryPct: 20 };

  it("walks a stale moving robot to delayed, then offline, on the local clock", () => {
    const fleet = [robot({ id: "RBT-001", status: "moving", receivedAt: T0 })];

    assert.equal(refreshStatuses(fleet, T0 + 1_000, thresholds)[0]!.status, "moving");
    assert.equal(refreshStatuses(fleet, T0 + 3_001, thresholds)[0]!.status, "delayed");
    assert.equal(refreshStatuses(fleet, T0 + 10_001, thresholds)[0]!.status, "offline");
    assert.equal(fleet[0]!.status, "moving", "the frame itself is never mutated");
  });

  it("keeps fault under the threshold and lets offline outrank it past it", () => {
    const fleet = [
      robot({ id: "RBT-001", status: "fault", errorCode: "E_STUCK", receivedAt: T0 }),
    ];

    assert.equal(refreshStatuses(fleet, T0 + 1_000, thresholds)[0]!.status, "fault");
    assert.equal(refreshStatuses(fleet, T0 + 10_001, thresholds)[0]!.status, "offline");
  });

  it("recounts the chips from the refreshed statuses", () => {
    const fleet = [
      robot({ id: "RBT-001", status: "moving", receivedAt: T0 }),
      robot({ id: "RBT-002", status: "moving", receivedAt: T0 - 20_000 }),
    ];

    assert.deepEqual(summariseStatuses(refreshStatuses(fleet, T0, thresholds)), {
      total: 2,
      moving: 1,
      idle: 0,
      charging: 0,
      low_battery: 0,
      fault: 0,
      delayed: 0,
      offline: 1,
    });
  });
});
