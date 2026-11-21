/**
 * Environment boundary for the server side.
 *
 * Read once, validated once, frozen. A bad value fails at import with the variable
 * name and what it received, so a typo in `.env.local` is not silently papered over
 * by a default.
 *
 * Server-only: this module holds `INGEST_API_KEY`. Never import it from a client
 * component — threshold values reach the browser through the fleet API instead.
 */

type Env = Record<string, string | undefined>;

export interface Thresholds {
  /** Age of the last report after which a robot is considered gone. */
  readonly offlineAfterMs: number;
  /** Age of the last report after which a robot is considered lagging. */
  readonly delayedAfterMs: number;
  /** Battery percentage below which a robot is flagged as low. */
  readonly lowBatteryPct: number;
}

export interface Config {
  readonly ingestApiKey: string;
  readonly databasePath: string;
  readonly thresholds: Thresholds;
  readonly retentionHours: number;
}

const DEFAULTS = {
  ingestApiKey: "dev-ingest-key",
  databasePath: "./data/fleet.db",
  offlineAfterMs: 10_000,
  delayedAfterMs: 3_000,
  lowBatteryPct: 20,
  retentionHours: 24,
} as const;

/** Trimmed value, or `undefined` when the variable is absent or blank. */
function rawValue(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function readInteger(env: Env, name: string, fallback: number): number {
  const raw = rawValue(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)}: expected a positive whole number (milliseconds)`,
    );
  }
  return value;
}

function readPercentage(env: Env, name: string, fallback: number): number {
  const raw = rawValue(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)}: expected a number between 0 and 100`,
    );
  }
  return value;
}

function readPositiveNumber(env: Env, name: string, fallback: number): number {
  const raw = rawValue(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)}: expected a positive number`,
    );
  }
  return value;
}

/**
 * Parse an env object into a frozen config.
 *
 * Exported separately from the singleton so tests can exercise failure paths
 * without mutating the real `process.env`.
 */
export function loadConfig(env: Env = process.env): Config {
  const offlineAfterMs = readInteger(env, "OFFLINE_AFTER_MS", DEFAULTS.offlineAfterMs);
  const delayedAfterMs = readInteger(env, "DELAYED_AFTER_MS", DEFAULTS.delayedAfterMs);

  // Precondition of the status ladder: delayed must trigger before offline,
  // otherwise every stale robot jumps straight from fresh to offline.
  if (delayedAfterMs >= offlineAfterMs) {
    throw new Error(
      `Invalid DELAYED_AFTER_MS=${delayedAfterMs}: must be smaller than OFFLINE_AFTER_MS=${offlineAfterMs}`,
    );
  }

  return Object.freeze({
    ingestApiKey: rawValue(env, "INGEST_API_KEY") ?? DEFAULTS.ingestApiKey,
    databasePath: rawValue(env, "DATABASE_PATH") ?? DEFAULTS.databasePath,
    thresholds: Object.freeze({
      offlineAfterMs,
      delayedAfterMs,
      lowBatteryPct: readPercentage(env, "LOW_BATTERY_PCT", DEFAULTS.lowBatteryPct),
    }),
    retentionHours: readPositiveNumber(env, "RETENTION_HOURS", DEFAULTS.retentionHours),
  });
}

export const config: Config = loadConfig();
