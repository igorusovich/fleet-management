import type { RobotStatus } from "@/lib/telemetry/status";

import { statusLabel } from "./fleet-view";

/**
 * One status, one pill. Colour *and* text, never colour alone — the palette is
 * low-contrast by design and a dot on its own is not a status.
 *
 * Shared with task 9's detail header so both screens read the same vocabulary.
 */
const TONE: Record<RobotStatus, string> = {
  offline: "border-line text-muted",
  fault: "border-bad/40 text-bad",
  low_battery: "border-warn/40 text-warn",
  delayed: "border-warn/30 text-warn/80",
  charging: "border-accent/40 text-accent",
  moving: "border-ok/30 text-ok",
  idle: "border-line text-muted",
};

export function StatusPill({
  status,
  className = "",
}: {
  status: RobotStatus;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider ${TONE[status]} ${className}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {statusLabel(status)}
    </span>
  );
}
