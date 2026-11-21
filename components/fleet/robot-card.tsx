import Link from "next/link";

import type { FleetRobot } from "@/lib/http/fleet";

import { ageOf, batteryTone, formatAge } from "./fleet-view";
import { StatusPill } from "./status-pill";

function coordinate(value: number): string {
  const text = value.toFixed(2);
  // Avoid the "-0.00" that toFixed produces for tiny negative values.
  return text === "-0.00" ? "0.00" : text;
}

function motionLine(robot: FleetRobot): string {
  if (robot.status === "fault" && robot.errorCode !== null) {
    return `fault · ${robot.errorCode}`;
  }
  if (robot.charging) return "charging";
  if (robot.motion === "moving") return `moving · ${robot.speed.toFixed(1)} m/s`;
  return robot.motion;
}

function batteryBarClass(robot: FleetRobot, lowBatteryPct: number): string {
  if (robot.status === "offline") return "bg-muted/50";
  if (batteryTone(robot.battery, lowBatteryPct) === "low") return "bg-warn";
  if (robot.status === "charging") return "bg-ok";
  return "bg-accent";
}

export function RobotCard({
  robot,
  now,
  lowBatteryPct,
}: {
  robot: FleetRobot;
  now: number;
  lowBatteryPct: number;
}) {
  const offline = robot.status === "offline";
  const batteryWidth = `${Math.max(0, Math.min(100, robot.battery))}%`;
  // Offline cards lose their border and bar, never their text.
  const border = offline ? "border-line/60" : "border-line";

  return (
    <Link
      href={`/robots/${robot.id}`}
      className={`group flex h-full flex-col gap-3 rounded-xl border ${border} bg-surface p-4 transition-colors hover:border-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    >
      <div className="flex items-start justify-between gap-2">
        <StatusPill status={robot.status} />
        <span className="tnum font-mono text-[11px] text-muted">
          {Math.round(robot.battery)}%
        </span>
      </div>

      <div className="min-w-0">
        <p className="truncate text-sm font-medium tracking-tight">{robot.name}</p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
          {robot.name === robot.id ? robot.id : `${robot.id} · ${robot.siteId}`} · {robot.model}
        </p>
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-raised"
        role="img"
        aria-label={`Battery ${Math.round(robot.battery)} percent`}
      >
        <div className={`h-full rounded-full ${batteryBarClass(robot, lowBatteryPct)}`} style={{ width: batteryWidth }} />
      </div>

      <dl className="mt-auto grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
        <div className="col-span-2 flex items-baseline justify-between gap-2">
          <dt className="sr-only">Motion</dt>
          <dd className={offline ? "text-muted" : "text-ink/90"}>{motionLine(robot)}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-muted">x</dt>
          <dd className="tnum">{coordinate(robot.x)}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-muted">y</dt>
          <dd className="tnum">{coordinate(robot.y)}</dd>
        </div>
      </dl>

      <p className="flex items-baseline justify-between gap-2 border-t border-line/60 pt-2 font-mono text-[10.5px] text-muted">
        <span className="tnum">updated {formatAge(ageOf(robot, now))}</span>
        <span className="tnum">seq {robot.seq}</span>
      </p>
    </Link>
  );
}
