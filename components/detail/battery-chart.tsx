import type { AppliedWindow, HistoryPoint } from "@/lib/http/robot";
import type { StatusThresholds } from "@/lib/telemetry/status";

import {
  BATTERY_BOX,
  batteryPoints,
  chargeSpans,
  formatClock,
  formatWindow,
  thresholdY,
  valueY,
  type PlottedPoint,
} from "./detail-view";

/** One continuous stretch of the battery line. */
function BatteryRun({ points }: { points: readonly PlottedPoint[] }) {
  const first = points[0];
  if (first === undefined) return null;

  if (points.length === 1) {
    return <circle cx={first.x} cy={first.y} r={2.5} fill="var(--color-accent)" />;
  }

  const d = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");

  return (
    <path
      d={d}
      fill="none"
      stroke="var(--color-accent)"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

const GRID_VALUES = [0, 25, 50, 75, 100] as const;

/**
 * Battery over the window: charge bands behind the line, the low-battery
 * threshold as a dashed rule, and the line itself split wherever samples are
 * missing. A line drawn across a silence would invent values that never existed.
 */
export function BatteryChart({
  history,
  scope,
  thresholds,
}: {
  history: readonly HistoryPoint[];
  scope: AppliedWindow;
  thresholds: StatusThresholds;
}) {
  const { segments, empty } = batteryPoints(history, scope, thresholds);
  const spans = chargeSpans(history, scope);
  const y = valueY();
  const rule = thresholdY(thresholds.lowBatteryPct);

  const batteries = history.map((point) => point.battery);
  const lowest = batteries.length === 0 ? null : Math.min(...batteries);
  const highest = batteries.length === 0 ? null : Math.max(...batteries);

  const label = empty
    ? `Battery over the last ${formatWindow(scope.requested)}: no samples in this window.`
    : `Battery over the last ${formatWindow(scope.requested)}: between ${Math.round(
        lowest ?? 0,
      )} and ${Math.round(highest ?? 0)} percent, low-battery line at ${
        thresholds.lowBatteryPct
      } percent.`;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${BATTERY_BOX.width} ${BATTERY_BOX.height}`}
        role="img"
        aria-label={label}
        className="w-full"
      >
        <rect
          x={BATTERY_BOX.padX}
          y={BATTERY_BOX.padTop}
          width={BATTERY_BOX.width - BATTERY_BOX.padX * 2}
          height={BATTERY_BOX.height - BATTERY_BOX.padTop - BATTERY_BOX.padBottom}
          rx={6}
          fill="var(--color-canvas)"
          stroke="var(--color-line)"
        />

        {GRID_VALUES.map((value) => (
          <line
            key={value}
            x1={BATTERY_BOX.padX}
            x2={BATTERY_BOX.width - BATTERY_BOX.padX}
            y1={y(value)}
            y2={y(value)}
            stroke="var(--color-line)"
            strokeOpacity={0.5}
          />
        ))}

        {spans.map((span, index) => (
          <rect
            key={`span-${index}`}
            x={span.x}
            y={BATTERY_BOX.padTop}
            width={span.width}
            height={BATTERY_BOX.height - BATTERY_BOX.padTop - BATTERY_BOX.padBottom}
            fill="var(--color-ok)"
            opacity={0.09}
          />
        ))}

        <line
          x1={BATTERY_BOX.padX}
          x2={BATTERY_BOX.width - BATTERY_BOX.padX}
          y1={rule}
          y2={rule}
          stroke="var(--color-warn)"
          strokeOpacity={0.5}
          strokeDasharray="4 4"
        />
        <text
          x={BATTERY_BOX.width - BATTERY_BOX.padX}
          y={rule - 4}
          textAnchor="end"
          fontSize={9}
          fontFamily="monospace"
          fill="var(--color-warn)"
          opacity={0.8}
        >
          {thresholds.lowBatteryPct} %
        </text>

        {empty ? (
          <text
            x={BATTERY_BOX.width / 2}
            y={BATTERY_BOX.height / 2}
            textAnchor="middle"
            fontSize={11}
            fontFamily="monospace"
            fill="var(--color-muted)"
          >
            No samples in this window
          </text>
        ) : (
          segments.map((segment, index) => (
            <BatteryRun key={`run-${index}`} points={segment} />
          ))
        )}
      </svg>

      <figcaption className="mt-1 flex flex-wrap items-center justify-between gap-x-3 font-mono text-[10px] text-muted">
        <span className="tnum">{formatClock(scope.from)}</span>
        <span>
          last {formatWindow(scope.requested)} · charging shaded · {thresholds.lowBatteryPct} % line
        </span>
        <span className="tnum">{formatClock(scope.to)}</span>
      </figcaption>
    </figure>
  );
}
