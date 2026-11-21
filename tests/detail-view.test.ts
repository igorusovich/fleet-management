import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppliedWindow, HistoryPoint } from "../lib/http/robot";
import {
  BATTERY_BOX,
  DEFAULT_CHOICE,
  TRAIL_BOX,
  WINDOW_CHOICES,
  batteryPoints,
  chargeSpans,
  eventLabel,
  formatClock,
  formatDistance,
  formatEventTime,
  formatWindow,
  linearScale,
  maxGapMs,
  projectTrail,
  speedMax,
  splitAtGaps,
  trailBounds,
} from "../components/detail/detail-view";
import type { StatusThresholds } from "../lib/telemetry/status";

/**
 * The chart is only as honest as its geometry: where a bucket lands, where the
 * line breaks, where a charge band starts. All of that is pure, so it is tested
 * here without a DOM — the components themselves are checked by the build and a
 * browser pass.
 */

const NOW = 1_700_000_000_000;
const SECOND = 1_000;

const THRESHOLDS: StatusThresholds = {
  offlineAfterMs: 10_000,
  delayedAfterMs: 3_000,
  lowBatteryPct: 20,
};

function scopeOf(requested: AppliedWindow["requested"], bucketMs: number): AppliedWindow {
  const ms = requested === "5m" ? 300_000 : requested === "15m" ? 900_000 : 3_600_000;
  return { requested, ms, bucketMs, from: NOW - ms, to: NOW };
}

const WINDOW = scopeOf("15m", 5_000);

function point(t: number, battery: number, overrides: Partial<HistoryPoint> = {}): HistoryPoint {
  return { t, battery, speed: 0.6, charging: false, ...overrides };
}

describe("linearScale", () => {
  it("maps domain endpoints to range endpoints and interpolates between them", () => {
    const scale = linearScale([0, 10], [0, 100]);

    assert.equal(scale(0), 0);
    assert.equal(scale(10), 100);
    assert.equal(scale(5), 50);

    const flipped = linearScale([0, 100], [180, 20]);
    assert.equal(flipped(0), 180);
    assert.equal(flipped(100), 20);
    assert.equal(flipped(50), 100);
  });

  it("maps a zero-span domain to the middle of the range instead of dividing by zero", () => {
    const scale = linearScale([42, 42], [0, 100]);

    const value = scale(42);
    assert.ok(Number.isFinite(value));
    assert.equal(value, 50);
    assert.equal(scale(999), 50);
  });
});

describe("batteryPoints", () => {
  it("maps time left to right and battery upside down, inside the plot box", () => {
    // One bucket apart, so these are one continuous line rather than three dots.
    const history = [
      point(WINDOW.from, 100),
      point(WINDOW.from + WINDOW.bucketMs, 50),
      point(WINDOW.from + 2 * WINDOW.bucketMs, 0),
    ];

    const { segments, empty } = batteryPoints(history, WINDOW, THRESHOLDS);
    assert.equal(empty, false);
    assert.equal(segments.length, 1);

    const [first, middle, last] = segments[0] ?? [];
    assert.ok(first !== undefined && middle !== undefined && last !== undefined);

    const width = BATTERY_BOX.width - BATTERY_BOX.padX * 2;
    const expectedLastX = BATTERY_BOX.padX + ((2 * WINDOW.bucketMs) / WINDOW.ms) * width;

    assert.equal(first.x, BATTERY_BOX.padX);
    assert.ok(Math.abs(last.x - expectedLastX) < 1e-6);
    assert.equal(first.y, BATTERY_BOX.padTop);
    assert.equal(last.y, BATTERY_BOX.height - BATTERY_BOX.padBottom);
    assert.ok(first.x < middle.x && middle.x < last.x);
    assert.ok(first.y < middle.y && middle.y < last.y);

    // The right edge maps to the end of the window, not to the last sample.
    const atRight = batteryPoints([point(WINDOW.to, 50)], WINDOW, THRESHOLDS);
    assert.equal(atRight.segments[0]?.[0]?.x, BATTERY_BOX.width - BATTERY_BOX.padX);
  });

  it("reports an empty window as empty rather than a degenerate line", () => {
    const plot = batteryPoints([], WINDOW, THRESHOLDS);

    assert.equal(plot.empty, true);
    assert.deepEqual(plot.segments, []);
  });

  it("breaks the line where the silence exceeds the gap rule", () => {
    // 15 m → 5 s buckets, so the gap rule is the 10 s offline threshold.
    assert.equal(maxGapMs(5_000, 10_000), 10_000);
    // 1 h → 30 s buckets: adjacent points are 30 s apart by construction, and
    // treating that as a gap would leave nothing but dots.
    assert.equal(maxGapMs(30_000, 10_000), 45_000);

    const runs = splitAtGaps(
      [point(NOW - 30 * SECOND, 60), point(NOW - 25 * SECOND, 59), point(NOW - 5 * SECOND, 55)],
      maxGapMs(WINDOW.bucketMs, THRESHOLDS.offlineAfterMs),
    );

    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.length, 2);
    assert.equal(runs[1]!.length, 1, "a lone bucket after the silence is its own dot");

    const hourly = scopeOf("1h", 30_000);
    const hourlyRuns = splitAtGaps(
      [point(NOW - 60 * SECOND, 60), point(NOW - 30 * SECOND, 59), point(NOW, 58)],
      maxGapMs(hourly.bucketMs, THRESHOLDS.offlineAfterMs),
    );
    assert.equal(hourlyRuns.length, 1, "contiguous 30 s buckets stay one line");
  });
});

describe("chargeSpans", () => {
  it("merges contiguous charging buckets and splits on the first idle one", () => {
    const history = [
      point(NOW - 20 * SECOND, 40, { charging: true }),
      point(NOW - 15 * SECOND, 41, { charging: true }),
      point(NOW - 10 * SECOND, 42, { charging: true }),
      point(NOW - 5 * SECOND, 41, { charging: false }),
      point(NOW, 40, { charging: false }),
    ];

    const spans = chargeSpans(history, WINDOW);
    assert.equal(spans.length, 1);

    const [span] = spans;
    const x = (t: number) => BATTERY_BOX.padX + ((t - WINDOW.from) / WINDOW.ms) * (BATTERY_BOX.width - BATTERY_BOX.padX * 2);

    assert.ok(span !== undefined);
    assert.ok(Math.abs(span.x - x(NOW - 20 * SECOND)) < 1e-6);
    // Three charging buckets: from the first to the end of the third.
    assert.ok(Math.abs(span.width - (x(NOW - 5 * SECOND) - x(NOW - 20 * SECOND))) < 1e-6);

    const broken = chargeSpans(
      [
        point(NOW - 20 * SECOND, 40, { charging: true }),
        point(NOW - 15 * SECOND, 41, { charging: false }),
        point(NOW - 10 * SECOND, 42, { charging: true }),
      ],
      WINDOW,
    );
    assert.equal(broken.length, 2, "an idle bucket ends the band");
  });
});

describe("trail geometry", () => {
  it("pads bounds and floors the span, so a stationary robot does not fill the map", () => {
    const single = trailBounds([{ x: 5, y: 5 }]);
    assert.equal(single.maxX - single.minX, 20);
    assert.equal(single.maxY - single.minY, 20);
    assert.equal((single.minX + single.maxX) / 2, 5);

    const line = trailBounds([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    assert.ok(line.maxX - line.minX > 100, "padded past the points themselves");
    assert.equal(line.maxY - line.minY, 20, "the flat axis is still floored at 20 m");
  });

  it("projects x left to right and y upside down, with every point inside the box", () => {
    const bounds = trailBounds([
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ]);

    const [bottomLeft, topRight] = projectTrail(
      [
        { x: bounds.minX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.maxY },
      ],
      bounds,
    );

    assert.ok(bottomLeft !== undefined && topRight !== undefined);
    assert.equal(bottomLeft.x, TRAIL_BOX.padX);
    assert.equal(bottomLeft.y, TRAIL_BOX.height - TRAIL_BOX.padBottom);
    assert.equal(topRight.x, TRAIL_BOX.width - TRAIL_BOX.padX);
    assert.equal(topRight.y, TRAIL_BOX.padTop);

    for (const point of projectTrail([{ x: 0, y: 0 }, { x: 100, y: 50 }], bounds)) {
      assert.ok(point.x >= TRAIL_BOX.padX && point.x <= TRAIL_BOX.width - TRAIL_BOX.padX);
      assert.ok(point.y >= TRAIL_BOX.padTop && point.y <= TRAIL_BOX.height - TRAIL_BOX.padBottom);
    }
  });
});

describe("display helpers", () => {
  it("floors the speed axis at 1 m/s so an idle robot reads as a baseline", () => {
    assert.equal(speedMax([]), 1);
    assert.equal(speedMax([{ speed: 0.4 }]), 1);
    assert.equal(speedMax([{ speed: 0.4 }, { speed: 2.3 }]), 2.3);
  });

  it("formats distance in metres under a kilometre and kilometres above it", () => {
    assert.equal(formatDistance(0.4), "0.4 m");
    assert.equal(formatDistance(412), "412 m");
    assert.equal(formatDistance(1_234), "1.2 km");
    assert.equal(formatDistance(12_345), "12 km");
  });

  it("formats clock labels as HH:MM and event times as HH:MM:SS", () => {
    assert.match(formatClock(NOW), /^\d{2}:\d{2}$/);
    assert.match(formatEventTime(NOW), /^\d{2}:\d{2}:\d{2}$/);
    assert.equal(formatEventTime(NOW).slice(0, 5), formatClock(NOW));
  });

  it("labels every event kind the API derives", () => {
    assert.equal(eventLabel("fault"), "Fault");
    assert.equal(eventLabel("charge_start"), "Charging started");
    assert.equal(eventLabel("comms_gap"), "Comms gap");
  });

  it("offers exactly PLAN's three windows, defaulting to 15 minutes", () => {
    assert.deepEqual([...WINDOW_CHOICES], ["5m", "15m", "1h"]);
    assert.equal(DEFAULT_CHOICE, "15m");
    assert.equal(formatWindow("15m"), "15 min");
    assert.equal(formatWindow("1h"), "1 hour");
  });
});
