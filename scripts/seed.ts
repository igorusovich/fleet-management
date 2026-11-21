/**
 * Curate the demo fleet's display metadata.
 *
 * The simulator owns telemetry; this seed owns how its ids are named and
 * grouped, so a fresh database does not show twenty robots called `RBT-001`
 * in `unassigned`. Running it twice is safe: names, sites and models are
 * updated, `created_at` and all telemetry are left alone.
 *
 *   npm run seed
 *   npm run seed -- --robots 5
 */

import { pathToFileURL } from "node:url";

import { config } from "../lib/config";
import { openDatabase } from "../lib/db/client";
import { upsertRobotMetadata, type RobotMetadata } from "../lib/db/telemetry";

export const DEFAULT_SEED_ROBOTS = 20;
export const MAX_SEED_ROBOTS = 200;

const NAMES = [
  "Atlas",
  "Bolt",
  "Cargo",
  "Drift",
  "Echo",
  "Flux",
  "Gauge",
  "Hopper",
  "Ion",
  "Juno",
  "Kilo",
  "Lumen",
  "Mica",
  "Nova",
  "Orbit",
  "Pilot",
  "Quarry",
  "Rover",
  "Sable",
  "Talon",
] as const;

const SITES = ["site-berlin", "site-rotterdam", "site-lyon"] as const;
const MODELS = ["TL-2", "TL-3", "AMR-1"] as const;

/**
 * The ids match the simulator's default sequence (`RBT-001`…), so seeding
 * before `npm run sim` gives the live robots their curated identities without
 * the simulator knowing anything about metadata.
 */
export function buildSeedRobots(count: number = DEFAULT_SEED_ROBOTS): RobotMetadata[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `RBT-${String(index + 1).padStart(3, "0")}`,
    name: `${NAMES[index % NAMES.length]!} ${String(index + 1).padStart(2, "0")}`,
    siteId: SITES[index % SITES.length]!,
    model: MODELS[index % MODELS.length]!,
  }));
}

export type SeedArgs =
  | { readonly kind: "run"; readonly count: number }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  let count: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === "--help" || arg === "-h") return { kind: "help" };

    if (arg === "--robots") {
      const raw = argv[index + 1];
      if (raw === undefined) {
        return { kind: "error", message: "--robots needs a count." };
      }

      const parsed = Number(raw);
      if (
        !Number.isInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_SEED_ROBOTS
      ) {
        return {
          kind: "error",
          message: `Invalid --robots ${JSON.stringify(raw)}: expected a whole number between 1 and ${MAX_SEED_ROBOTS}.`,
        };
      }

      count = parsed;
      index += 1;
      continue;
    }

    return { kind: "error", message: `Unknown argument ${JSON.stringify(arg)}.` };
  }

  return { kind: "run", count: count ?? DEFAULT_SEED_ROBOTS };
}

export function usage(): string {
  return [
    "Curate demo robot metadata (telemetry is left untouched).",
    "",
    "Usage: npm run seed -- [options]",
    "",
    "Options:",
    `  --robots N   robots to curate, 1..${MAX_SEED_ROBOTS} (default ${DEFAULT_SEED_ROBOTS})`,
    "  --help       show this message",
    "",
    "The database is DATABASE_PATH (default ./data/fleet.db).",
  ].join("\n");
}

function main(argv: readonly string[]): void {
  const parsed = parseSeedArgs(argv);

  if (parsed.kind === "help") {
    console.info(usage());
    return;
  }

  if (parsed.kind === "error") {
    console.error(`${parsed.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  const db = openDatabase(config.databasePath);
  try {
    const written = upsertRobotMetadata(db, buildSeedRobots(parsed.count));
    console.info(`seed robots=${written} database=${config.databasePath}`);
  } finally {
    db.close();
  }
}

// Importable from tests without seeding anything: `main` only runs when this
// file is the process entry point.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2));
}
