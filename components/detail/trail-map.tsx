import type { AppliedWindow, RobotResponseBody, TrailPoint } from "@/lib/http/robot";
import type { StatusThresholds } from "@/lib/telemetry/status";

import {
  TRAIL_BOX,
  formatHeading,
  gridStep,
  maxGapMs,
  projectPoint,
  projectTrail,
  splitAtGaps,
  trailBounds,
  type Bounds,
} from "./detail-view";

function ticks(min: number, max: number, step: number): number[] {
  const first = Math.ceil(min / step) * step;
  const values: number[] = [];

  for (let value = first; value <= max + 1e-9; value += step) values.push(value);
  return values;
}

/**
 * The trail on a site grid, split at gaps the same way the chart is, with the
 * current position and heading drawn on top.
 *
 * The arrow is a triangle pointing north rotated by the bearing: on this map
 * north is up, so 0° stays up and 90° points east (right), matching the axes.
 */
export function TrailMap({
  trail,
  scope,
  state,
  thresholds,
}: {
  trail: readonly TrailPoint[];
  scope: AppliedWindow;
  state: RobotResponseBody["state"];
  thresholds: StatusThresholds;
}) {
  const bounds: Bounds = trailBounds([...trail, { x: state.x, y: state.y }]);
  const step = gridStep(bounds);
  const runs = splitAtGaps(trail, maxGapMs(scope.bucketMs, thresholds.offlineAfterMs));
  const current = projectPoint({ x: state.x, y: state.y }, bounds);
  const heading = ((state.heading % 360) + 360) % 360;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${TRAIL_BOX.width} ${TRAIL_BOX.height}`}
        role="img"
        aria-label={`Trail over the last ${scope.requested} on a ${step} metre grid, currently at ${current.x.toFixed(
          0,
        )},${current.y.toFixed(0)} in the plot.`}
        className="w-full"
      >
        <rect
          x={1}
          y={1}
          width={TRAIL_BOX.width - 2}
          height={TRAIL_BOX.height - 2}
          rx={8}
          fill="var(--color-canvas)"
          stroke="var(--color-line)"
        />

        {ticks(bounds.minX, bounds.maxX, step).map((value) => {
          const top = projectPoint({ x: value, y: bounds.minY }, bounds);
          const bottom = projectPoint({ x: value, y: bounds.maxY }, bounds);
          return (
            <line
              key={`x-${value}`}
              x1={top.x}
              y1={top.y}
              x2={bottom.x}
              y2={bottom.y}
              stroke="var(--color-line)"
              strokeOpacity={0.55}
            />
          );
        })}

        {ticks(bounds.minY, bounds.maxY, step).map((value) => {
          const left = projectPoint({ x: bounds.minX, y: value }, bounds);
          const right = projectPoint({ x: bounds.maxX, y: value }, bounds);
          return (
            <line
              key={`y-${value}`}
              x1={left.x}
              y1={left.y}
              x2={right.x}
              y2={right.y}
              stroke="var(--color-line)"
              strokeOpacity={0.55}
            />
          );
        })}

        {runs.map((run, index) => {
          if (run.length === 1) {
            const dot = projectPoint(run[0]!, bounds);
            return (
              <circle
                key={`run-${index}`}
                cx={dot.x}
                cy={dot.y}
                r={2}
                fill="var(--color-accent)"
                opacity={0.7}
              />
            );
          }

          const points = projectTrail(run, bounds)
            .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
            .join(" ");

          return (
            <polyline
              key={`run-${index}`}
              points={points}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={1.5}
              strokeOpacity={0.75}
              strokeLinejoin="round"
            />
          );
        })}

        <circle cx={current.x} cy={current.y} r={3.6} fill="var(--color-accent)" />
        <path
          d={`M ${current.x} ${current.y - 9} L ${current.x + 4.5} ${current.y + 3} L ${
            current.x - 4.5
          } ${current.y + 3} Z`}
          transform={`rotate(${heading} ${current.x} ${current.y})`}
          fill="var(--color-accent)"
          opacity={0.85}
        />
      </svg>

      <figcaption className="mt-1 flex flex-wrap items-center justify-between gap-x-3 font-mono text-[10px] text-muted">
        <span>{step} m grid</span>
        <span>{formatHeading(state.heading)}</span>
        <span>{runs.length > 1 ? `${runs.length - 1} gap${runs.length > 2 ? "s" : ""}` : "continuous"}</span>
      </figcaption>
    </figure>
  );
}
