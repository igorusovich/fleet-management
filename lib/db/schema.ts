/**
 * Schema definition and migrations.
 *
 * Migrations are ordered, versioned steps applied through `PRAGMA user_version`:
 * each step runs exactly once, in a transaction, and bumps the version. That is
 * why the DDL below says `CREATE TABLE` and not `IF NOT EXISTS` — if the file
 * claims a version the tables do not match, we want a loud failure, not a
 * silently half-built database.
 *
 * Adding a column later means appending a step; never editing step 1 in place,
 * because a database that already ran it would never see the change.
 */

import type Database from "better-sqlite3";

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      -- Display metadata only. Ingest auto-registers unknown robots with the
      -- defaults below, so the fleet view works before any seed step exists.
      CREATE TABLE robots (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        site_id     TEXT NOT NULL,
        model       TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      -- Append-only history. UNIQUE (robot_id, seq) is the idempotency key: a
      -- replayed batch collides instead of duplicating.
      CREATE TABLE telemetry (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        robot_id    TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        device_ts   INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        battery     REAL NOT NULL,
        charging    INTEGER NOT NULL,
        motion      TEXT NOT NULL,
        x           REAL NOT NULL,
        y           REAL NOT NULL,
        heading     REAL NOT NULL,
        speed       REAL NOT NULL,
        error_code  TEXT,
        UNIQUE (robot_id, seq)
      );
      CREATE INDEX telemetry_robot_ts ON telemetry (robot_id, device_ts DESC);
      CREATE INDEX telemetry_ts       ON telemetry (device_ts);

      -- Read model: one row per robot, so the fleet view is a single indexed
      -- scan instead of a MAX(device_ts) group-by over the whole history.
      CREATE TABLE robot_latest (
        robot_id    TEXT PRIMARY KEY,
        seq         INTEGER NOT NULL,
        device_ts   INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        battery     REAL NOT NULL,
        charging    INTEGER NOT NULL,
        motion      TEXT NOT NULL,
        x           REAL NOT NULL,
        y           REAL NOT NULL,
        heading     REAL NOT NULL,
        speed       REAL NOT NULL,
        error_code  TEXT
      );
    `,
  },
];

/** The version a freshly migrated database reports. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Apply every migration the database has not seen yet.
 *
 * Returns the version the database is at afterwards. The DDL and the version
 * bump share one transaction: a crash halfway through leaves the previous
 * version intact, so the next open retries instead of trusting a partial schema.
 */
export function migrate(db: Database.Database): number {
  let current = Number(db.pragma("user_version", { simple: true }));

  for (const step of MIGRATIONS) {
    if (step.version <= current) continue;

    db.transaction(() => {
      db.exec(step.sql);
      // Interpolated, not bound: PRAGMA does not accept parameters. The value
      // comes from our own table of integer literals, never from input.
      db.exec(`PRAGMA user_version = ${step.version}`);
    })();

    current = step.version;
  }

  return current;
}
