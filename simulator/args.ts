/**
 * The simulator's settings: flags over `SIM_*` over code defaults.
 *
 * Returns errors instead of exiting, so the gate can assert exactly what a bad
 * invocation says; `cli.ts` is the only place that decides an error means exit 1.
 *
 * Precedence is deliberate. Flags make a one-off experiment possible without
 * editing a file (`npm run sim -- --robots 3 --interval 500`), the `SIM_*`
 * variables match `.env.example` so a developer's usual fleet survives restarts,
 * and the defaults let a fresh clone run with no configuration at all.
 */

type Env = Record<string, string | undefined>;

export interface SimConfig {
  readonly robots: number;
  readonly intervalMs: number;
  readonly url: string;
  readonly key: string;
  readonly seed: number;
  /** Fraction of reports to omit, 0–1. */
  readonly dropRate: number;
}

/** Mirrors `.env.example` and `lib/config.ts` where they overlap. */
export const DEFAULTS: SimConfig = Object.freeze({
  robots: 20,
  intervalMs: 1000,
  url: "http://localhost:3000/api/ingest",
  key: "dev-ingest-key",
  seed: 42,
  dropRate: 0.02,
});

/** One batch is capped at 500 reports by the ingest endpoint; 200 leaves headroom. */
export const MAX_ROBOTS = 200;
export const MIN_INTERVAL_MS = 100;
export const MAX_INTERVAL_MS = 60_000;

/** flag → environment variable */
const OPTION_ENV = {
  "--robots": "SIM_ROBOTS",
  "--interval": "SIM_INTERVAL_MS",
  "--url": "SIM_URL",
  "--key": "INGEST_API_KEY",
  "--seed": "SIM_SEED",
  "--drop-rate": "SIM_DROP_RATE",
} as const;

type OptionFlag = keyof typeof OPTION_ENV;

export type ParsedArgs =
  | { readonly kind: "run"; readonly config: SimConfig }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export function usage(): string {
  return [
    "Usage: npm run sim -- [options]",
    "",
    "  --robots <n>        robots in the fleet           (default 20, max 200)",
    "  --interval <ms>     tick interval                 (default 1000)",
    "  --url <url>         ingest endpoint               (default http://localhost:3000/api/ingest)",
    "  --key <key>         x-ingest-key value            (default INGEST_API_KEY, else dev-ingest-key)",
    "  --seed <n>          RNG seed                      (default 42)",
    "  --drop-rate <0..1>  fraction of reports omitted    (default 0.02)",
    "  --help              show this message",
    "",
    "Environment: SIM_ROBOTS, SIM_INTERVAL_MS, SIM_URL, SIM_SEED, SIM_DROP_RATE, INGEST_API_KEY.",
    "Flags win over environment variables, which win over the defaults.",
  ].join("\n");
}

interface NumberRule {
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
}

function readNumber(
  flag: OptionFlag,
  raw: string | undefined,
  fallback: number,
  rule: NumberRule,
): { value: number } | { error: string } {
  if (raw === undefined) return { value: fallback };

  const described = `${flag} ${JSON.stringify(raw)}`;
  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return { error: `invalid ${described}: expected a number` };
  }
  if (rule.integer && !Number.isInteger(value)) {
    return { error: `invalid ${described}: expected a whole number` };
  }
  if (value < rule.min || value > rule.max) {
    const expected =
      rule.integer
        ? `a whole number between ${rule.min} and ${rule.max}`
        : `a number between ${rule.min} and ${rule.max}`;
    return { error: `invalid ${described}: expected ${expected}` };
  }

  return { value };
}

export function parseArgs(argv: readonly string[], env: Env = process.env): ParsedArgs {
  const flags = new Map<OptionFlag, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (!arg.startsWith("--")) {
      return { kind: "error", message: `unexpected argument ${JSON.stringify(arg)}` };
    }

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!(name in OPTION_ENV)) return { kind: "error", message: `unknown option ${name}` };

    const flag = name as OptionFlag;
    let value = equals === -1 ? undefined : arg.slice(equals + 1);

    if (value === undefined) {
      const next = argv[index + 1];
      // Treat a following flag as a missing value rather than swallowing it.
      if (next === undefined || next.startsWith("--")) {
        return { kind: "error", message: `${flag} needs a value` };
      }
      value = next;
      index += 1;
    }

    if (value.trim() === "") return { kind: "error", message: `${flag} needs a value` };
    flags.set(flag, value.trim());
  }

  /** Flag value, else the matching environment variable, else undefined. */
  const raw = (flag: OptionFlag): string | undefined => {
    const fromFlag = flags.get(flag);
    if (fromFlag !== undefined) return fromFlag;
    const fromEnv = env[OPTION_ENV[flag]];
    return fromEnv === undefined || fromEnv.trim() === "" ? undefined : fromEnv.trim();
  };

  const robots = readNumber("--robots", raw("--robots"), DEFAULTS.robots, {
    min: 1,
    max: MAX_ROBOTS,
    integer: true,
  });
  if ("error" in robots) return { kind: "error", message: robots.error };

  const intervalMs = readNumber("--interval", raw("--interval"), DEFAULTS.intervalMs, {
    min: MIN_INTERVAL_MS,
    max: MAX_INTERVAL_MS,
    integer: true,
  });
  if ("error" in intervalMs) return { kind: "error", message: intervalMs.error };

  const seed = readNumber("--seed", raw("--seed"), DEFAULTS.seed, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
  });
  if ("error" in seed) return { kind: "error", message: seed.error };

  const dropRate = readNumber("--drop-rate", raw("--drop-rate"), DEFAULTS.dropRate, {
    min: 0,
    max: 1,
    integer: false,
  });
  if ("error" in dropRate) return { kind: "error", message: dropRate.error };

  const urlRaw = raw("--url");
  let url = DEFAULTS.url;
  if (urlRaw !== undefined) {
    try {
      const parsed = new URL(urlRaw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
      url = parsed.toString();
    } catch {
      return {
        kind: "error",
        message: `invalid --url ${JSON.stringify(urlRaw)}: expected an http(s) URL`,
      };
    }
  }

  return {
    kind: "run",
    config: Object.freeze({
      robots: robots.value,
      intervalMs: intervalMs.value,
      url,
      key: raw("--key") ?? DEFAULTS.key,
      seed: seed.value,
      dropRate: dropRate.value,
    }),
  };
}
