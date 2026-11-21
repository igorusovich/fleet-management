/**
 * The single database handle for the server.
 *
 * Server-only. Never import this (or anything under `lib/db`) from a client
 * component: `better-sqlite3` is compiled C++ and a browser bundle cannot hold
 * it. Routes, route handlers and tests are the only legitimate callers.
 *
 * The handle is cached on `globalThis` rather than in a module variable because
 * Next's dev server re-evaluates modules on hot reload; a module-level singleton
 * would leave one open connection behind per reload until the file handle limit
 * runs out.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { config } from "../config";
import { migrate } from "./schema";

/** How long a blocked reader waits before giving up with SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5_000;

function isInMemory(filename: string): boolean {
  return filename === ":memory:" || filename.startsWith("file::memory:");
}

/**
 * Open (or create) a database and bring it to the current schema.
 *
 * Exported separately from `getDb` so tests can point at a temp file and so the
 * path stays an argument rather than a hidden global.
 */
export function openDatabase(filename: string = config.databasePath): Database.Database {
  if (!isInMemory(filename)) {
    // `/data/` is gitignored, so it does not exist on a fresh clone; the SQLite
    // driver will not create parent directories for us.
    mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }

  const db = new Database(filename);

  // Readers must not block the 1 Hz writer, and must not fail while it writes.
  // WAL is persisted in the file, but setting it makes a fresh file start right.
  // It returns a row ("wal", or "memory" for :memory:), so this is pragma(), not
  // exec() — exec() would throw on the result.
  db.pragma("journal_mode = WAL", { simple: true });
  db.pragma("synchronous = NORMAL");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("foreign_keys = ON");

  migrate(db);

  return db;
}

interface DatabaseScope {
  fleetDatabase?: Database.Database;
}

const scope = globalThis as DatabaseScope;

/** The process-wide handle, opened on first use. */
export function getDb(): Database.Database {
  const existing = scope.fleetDatabase;
  if (existing?.open) return existing;

  const db = openDatabase(config.databasePath);
  scope.fleetDatabase = db;
  return db;
}

/** Close and forget the shared handle. Used by tests and on shutdown. */
export function closeDb(): void {
  const db = scope.fleetDatabase;
  if (!db) return;
  if (db.open) db.close();
  delete scope.fleetDatabase;
}
