import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../lib/config";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    const config = loadConfig({});

    assert.equal(config.ingestApiKey, "dev-ingest-key");
    assert.equal(config.databasePath, "./data/fleet.db");
    assert.equal(config.retentionHours, 24);
    assert.deepEqual(config.thresholds, {
      offlineAfterMs: 10_000,
      delayedAfterMs: 3_000,
      lowBatteryPct: 20,
    });
  });

  it("reads overrides, trimming whitespace and ignoring blank values", () => {
    const config = loadConfig({
      INGEST_API_KEY: "  secret-key  ",
      DATABASE_PATH: "/tmp/fleet.db",
      OFFLINE_AFTER_MS: " 20000 ",
      DELAYED_AFTER_MS: "5000",
      LOW_BATTERY_PCT: "15.5",
      RETENTION_HOURS: "1.5",
      // A blank value is treated as absent so a commented-out export cannot
      // silently break startup.
      OFFLINE_AFTER_MS_FALLBACK: "",
    });

    assert.equal(config.ingestApiKey, "secret-key");
    assert.equal(config.databasePath, "/tmp/fleet.db");
    assert.equal(config.retentionHours, 1.5);
    assert.deepEqual(config.thresholds, {
      offlineAfterMs: 20_000,
      delayedAfterMs: 5_000,
      lowBatteryPct: 15.5,
    });
  });

  it("names the variable and the received value when a threshold is malformed", () => {
    assert.throws(
      () => loadConfig({ OFFLINE_AFTER_MS: "soon" }),
      /Invalid OFFLINE_AFTER_MS="soon"/,
    );
    assert.throws(
      () => loadConfig({ DELAYED_AFTER_MS: "1.5" }),
      /Invalid DELAYED_AFTER_MS="1.5"/,
    );
  });

  it("rejects a delayed threshold that is not below the offline threshold", () => {
    assert.throws(
      () => loadConfig({ DELAYED_AFTER_MS: "10000" }),
      /Invalid DELAYED_AFTER_MS=10000: must be smaller than OFFLINE_AFTER_MS=10000/,
    );
  });

  it("rejects an out-of-range battery threshold", () => {
    assert.throws(
      () => loadConfig({ LOW_BATTERY_PCT: "120" }),
      /Invalid LOW_BATTERY_PCT="120"/,
    );
  });

  it("returns a frozen config, including the nested thresholds", () => {
    const config = loadConfig({});

    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.thresholds));
  });

  it("never echoes the ingest key in a validation error", () => {
    assert.throws(
      () => loadConfig({ INGEST_API_KEY: "super-secret", LOW_BATTERY_PCT: "nope" }),
      (error: Error) => !error.message.includes("super-secret"),
    );
  });
});
