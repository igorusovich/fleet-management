"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ageOf, batteryTone, formatAge } from "@/components/fleet/fleet-view";
import { StatusPill } from "@/components/fleet/status-pill";

import { BatteryChart } from "./battery-chart";
import {
  DEFAULT_CHOICE,
  WINDOW_CHOICES,
  formatDistance,
  formatEventTime,
  formatHeading,
  formatWindow,
  type WindowChoice,
} from "./detail-view";
import { EventLog } from "./event-log";
import { TrailMap } from "./trail-map";
import { useRobotDetail } from "./use-robot-detail";

/**
 * The detail clock. Same rule as the fleet cards: the first value is `null` and
 * arrives on the interval, because reading `Date.now()` during render is what
 * Next blocks at prerender time. Until then the payload's `generatedAt` dates
 * the page, which is at most a poll old.
 */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(handle);
  }, []);

  return now;
}

function Kpi({
  label,
  value,
  note,
  tone = "text-ink",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`tnum mt-1 truncate text-sm font-medium ${tone}`}>{value}</p>
      {note === undefined ? null : <p className="mt-0.5 text-[11px] text-muted">{note}</p>}
    </div>
  );
}

/** Also the page's Suspense fallback: the shape of the data, prerendered. */
export function RobotDetailSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <div className="h-8 w-64 animate-pulse rounded-lg border border-line bg-surface" />
      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-16 animate-pulse rounded-lg border border-line bg-surface" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="h-64 animate-pulse rounded-xl border border-line bg-surface" />
        <div className="h-64 animate-pulse rounded-xl border border-line bg-surface" />
      </div>
    </div>
  );
}

function NotFound({ id }: { id: string }) {
  return (
    <section className="rounded-xl border border-dashed border-line bg-surface/40 px-6 py-12 text-center">
      <p className="text-sm font-medium">Robot not found</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">
        No robot <span className="font-mono text-ink">{id}</span> has reported. It may have been
        removed, or the link may be wrong.
      </p>
      <Link
        href="/"
        className="mt-4 inline-block rounded-lg border border-line bg-raised px-3 py-1.5 text-sm transition-colors hover:border-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Back to the fleet
      </Link>
    </section>
  );
}

function Unreachable({ id, failure }: { id: string; failure: string | null }) {
  return (
    <section className="rounded-xl border border-warn/30 bg-warn/5 px-6 py-10 text-center">
      <p className="text-sm font-medium">Can&apos;t load {id}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">
        The telemetry API did not answer. Retrying every 5 s.
        {failure === null ? null : <span className="mt-2 block font-mono text-[11px]">{failure}</span>}
      </p>
    </section>
  );
}

export function RobotDetailScreen() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";

  const [windowName, setWindowName] = useState<WindowChoice>(DEFAULT_CHOICE);
  const detail = useRobotDetail(id, windowName);
  const now = useNow();

  // Navigating between robots reuses this component: a payload for the previous
  // id must not paint under the new header, so only a matching payload counts.
  const data = detail.data !== null && detail.data.robot.id === id ? detail.data : null;
  const state = data === null ? detail.state : "ready";
  const failure = detail.failure;

  const clock = now ?? data?.generatedAt ?? 0;
  const updating = data !== null && data.window.requested !== windowName;

  if (state === "not_found") return <NotFound id={id} />;
  if (state === "error") return <Unreachable id={id} failure={failure} />;
  if (data === null) return <RobotDetailSkeleton />;

  const robot = data.robot;
  const current = data.state;
  const tone = batteryTone(current.battery, data.thresholds.lowBatteryPct);
  const updated = formatAge(ageOf({ receivedAt: data.generatedAt }, clock));

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="font-mono text-[11px]">
        <Link
          href="/"
          className="rounded text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          ← Fleet
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{robot.name}</h1>
            <StatusPill status={current.status} />
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted">
            {robot.id} · {robot.siteId} · {robot.model}
          </p>
        </div>
        <p className="tnum font-mono text-[11px] text-muted">
          updated {updated} · refresh 5 s
        </p>
      </header>

      {failure === null ? null : (
        <p
          role="status"
          className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 font-mono text-[11px] text-warn"
        >
          Can&apos;t refresh · showing data from {updated}
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label="Battery"
          value={`${Math.round(current.battery)} %`}
          note={current.charging ? "charging" : "not charging"}
          tone={tone === "low" ? "text-warn" : "text-ink"}
        />
        <Kpi label="Speed" value={`${current.speed.toFixed(1)} m/s`} note={current.motion} />
        <Kpi label="Heading" value={formatHeading(current.heading)} />
        <Kpi
          label="Last report"
          value={formatAge(ageOf(current, clock))}
          note={formatEventTime(current.receivedAt)}
        />
        <Kpi label="Sequence" value={String(current.seq)} />
        <Kpi
          label="Error code"
          value={current.errorCode ?? "none"}
          tone={current.errorCode === null ? "text-muted" : "text-bad"}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">
              Battery · last {formatWindow(data.window.requested)}
            </h2>
            <div role="group" aria-label="Time window" className="flex items-center gap-1">
              {WINDOW_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={choice === windowName}
                  onClick={() => setWindowName(choice)}
                  className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    choice === windowName
                      ? "border-accent/60 bg-accent/10 text-ink"
                      : "border-line bg-raised text-muted hover:border-accent/30 hover:text-ink"
                  }`}
                >
                  {choice}
                </button>
              ))}
              {updating ? <span className="ml-1 font-mono text-[10px] text-muted">updating…</span> : null}
            </div>
          </div>

          <BatteryChart
            history={data.history}
            scope={data.window}
            thresholds={data.thresholds}
          />
        </section>

        <section className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">Trail · site plan</h2>
            <span className="font-mono text-[10px] text-muted">
              last {formatWindow(data.window.requested)}
            </span>
          </div>

          <TrailMap
            trail={data.trail}
            scope={data.window}
            state={current}
            thresholds={data.thresholds}
          />

          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line pt-3">
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-wider text-muted">
                Travelled
              </dt>
              <dd className="tnum text-sm">{formatDistance(data.stats.distanceM)}</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-wider text-muted">
                Avg battery
              </dt>
              <dd className="tnum text-sm">
                {data.stats.avgBattery === null ? "—" : `${Math.round(data.stats.avgBattery)} %`}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-wider text-muted">Reports</dt>
              <dd className="tnum text-sm">{data.stats.reports}</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-wider text-muted">Gaps</dt>
              <dd className="tnum text-sm">{data.stats.gapCount}</dd>
            </div>
          </dl>
        </section>
      </div>

      <EventLog events={data.events} />
    </div>
  );
}
