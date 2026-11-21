"use client";

import { useEffect, useMemo, useState } from "react";

import type { FleetStreamState } from "@/lib/stream/client";

import {
  SORT_OPTIONS,
  STATUS_ORDER,
  filterRobots,
  formatAge,
  refreshStatuses,
  sortRobots,
  summariseStatuses,
  statusLabel,
  type SortOrder,
  type StatusFilter,
} from "./fleet-view";
import { RobotCard } from "./robot-card";
import { useFleetStream } from "./use-fleet-stream";

const CONNECTION: Record<FleetStreamState, { label: string; tone: string }> = {
  idle: { label: "idle", tone: "border-line text-muted" },
  connecting: { label: "connecting", tone: "border-warn/30 text-warn" },
  live: { label: "live · 1 s", tone: "border-ok/30 text-ok" },
  reconnecting: { label: "reconnecting", tone: "border-warn/30 text-warn" },
  polling: { label: "polling · 5 s", tone: "border-warn/30 text-warn" },
  stopped: { label: "stopped", tone: "border-line text-muted" },
};

/**
 * A one-second clock for the age labels.
 *
 * Ages are computed here rather than taken from the frame's `ageMs`, which is
 * frozen when the snapshot is built: if the socket stalls, a payload age stops
 * growing and a dead screen would look alive.
 *
 * The first value is `null`, set on mount: reading `Date.now()` during render is
 * what Next blocks at prerender time, and the server has no frame to date yet.
 */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // No synchronous first read: until the first tick the screen dates itself
    // from the frame's own generatedAt, which is at most a second old.
    const handle = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(handle);
  }, []);

  return now;
}

function ConnectionBadge({
  state,
  error,
}: {
  state: FleetStreamState;
  error: string | null;
}) {
  const connection = CONNECTION[state];

  return (
    <span
      title={error ?? undefined}
      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-[11px] ${connection.tone}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {connection.label}
      {error === null ? null : (
        <span className="text-muted" aria-hidden="true">
          !
        </span>
      )}
    </span>
  );
}

function FilterChip({
  label,
  count,
  pressed,
  onClick,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        pressed
          ? "border-accent/60 bg-accent/10 text-ink"
          : "border-line bg-surface text-muted hover:border-accent/30 hover:text-ink"
      }`}
    >
      <span className="tnum">{count}</span>
      <span>{label}</span>
    </button>
  );
}

function SkeletonGrid() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <li
          key={index}
          className="h-44 animate-pulse rounded-xl border border-line bg-surface"
        />
      ))}
    </ul>
  );
}

function EmptyFleet() {
  return (
    <section className="rounded-xl border border-dashed border-line bg-surface/40 px-6 py-12 text-center">
      <p className="text-sm font-medium">No robots yet</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">
        Telemetry has not arrived. Start the simulator and robots appear here within a
        second.
      </p>
      <code className="mt-4 inline-block rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[11px] text-accent">
        npm run sim -- --robots 5
      </code>
    </section>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <section className="rounded-xl border border-dashed border-line bg-surface/40 px-6 py-12 text-center">
      <p className="text-sm font-medium">No robots match</p>
      <p className="mt-1 text-sm text-muted">
        The fleet has robots, but none fit this search and status.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-4 rounded-lg border border-line bg-raised px-3 py-1.5 text-sm transition-colors hover:border-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Clear filters
      </button>
    </section>
  );
}

export function FleetScreen() {
  const { snapshot, state, error } = useFleetStream();
  const now = useNow();

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortOrder>("severity");

  // Before the mount effect runs there is no frame either, so the snapshot's own
  // build time is a safe stand-in for the first paint.
  const clock = now ?? snapshot?.generatedAt ?? 0;

  // Statuses are re-derived here, every tick, with the server's own rule. The
  // frame's statuses are only as fresh as the frame; a stalled socket would
  // otherwise keep every card "moving" while its age climbed.
  const robots = useMemo(
    () =>
      snapshot === null ? [] : refreshStatuses(snapshot.robots, clock, snapshot.thresholds),
    [snapshot, clock],
  );
  const summary = useMemo(() => summariseStatuses(robots), [robots]);

  const visible = useMemo(
    () => sortRobots(filterRobots(robots, { query, status }), sort),
    [robots, query, status, sort],
  );

  const total = snapshot?.summary.total ?? 0;
  const lastUpdate = snapshot === null ? null : formatAge(Math.max(0, clock - snapshot.generatedAt));
  const robotWord = total === 1 ? "robot" : "robots";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Fleet</h1>
          <p className="mt-1 text-sm text-muted">
            {snapshot === null
              ? "Waiting for the first frame…"
              : `${total} ${robotWord} · updated ${lastUpdate}`}
          </p>
        </div>
        <ConnectionBadge state={state} error={error} />
      </div>

      {snapshot === null ? null : (
        <>
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="Filter by status"
          >
            <FilterChip
              label="all"
              count={total}
              pressed={status === "all"}
              onClick={() => setStatus("all")}
            />
            {STATUS_ORDER.map((value) => (
              <FilterChip
                key={value}
                label={statusLabel(value)}
                count={summary[value]}
                pressed={status === value}
                onClick={() => setStatus(value)}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="fleet-search" className="sr-only">
              Search robots by id or name
            </label>
            <input
              id="fleet-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search id or name…"
              className="h-9 w-full max-w-xs rounded-lg border border-line bg-surface px-3 text-sm placeholder:text-muted/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />

            <label htmlFor="fleet-sort" className="sr-only">
              Sort robots
            </label>
            <select
              id="fleet-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortOrder)}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <span className="tnum ml-auto font-mono text-[11px] text-muted">
              {visible.length} of {total}
            </span>
          </div>
        </>
      )}

      {snapshot === null ? (
        <SkeletonGrid />
      ) : total === 0 ? (
        <EmptyFleet />
      ) : visible.length === 0 ? (
        <NoMatches
          onClear={() => {
            setQuery("");
            setStatus("all");
          }}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((robot) => (
            <li key={robot.id} className="min-w-0">
              <RobotCard
                robot={robot}
                now={clock}
                lowBatteryPct={snapshot.thresholds.lowBatteryPct}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
