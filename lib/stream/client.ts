/**
 * The browser side of the live fleet: one `EventSource`, plus polling while it
 * is down.
 *
 * Framework-free on purpose. Task 8 (the fleet screen) wraps this in a hook; the
 * gate drives it here in Node with a stub `EventSource` and a fake interval, so
 * the reconnect and fallback paths are tested without a browser or a clock.
 *
 * Both transports deliver the same `FleetResponseBody` — the polling fallback
 * fetches `GET /api/fleet`, which the stream already mirrors frame-for-frame —
 * so a consumer never learns which one is running.
 *
 * Lifecycle:
 *
 *   idle → connecting → live
 *                 ↘        ↓ (transport error)
 *                  reconnecting ⇄ (polling covers the gap)
 *   polling  (no EventSource at all: fallback only)
 *   stopped  (after stop())
 */

import type { FleetResponseBody } from "../http/fleet";

export const STREAM_URL = "/api/stream";
export const POLL_URL = "/api/fleet";
export const POLL_INTERVAL_MS = 5_000;

export type FleetStreamState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "polling"
  | "stopped";

/**
 * The part of `EventSource` this module uses. `data` is `unknown` so the same
 * listener type fits a server frame and a transport-level error event, which
 * carries no data.
 */
export interface FleetStreamEvent {
  readonly data?: unknown;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: FleetStreamEvent) => void): void;
  close(): void;
}

export interface FleetStreamOptions {
  readonly streamUrl?: string;
  readonly pollUrl?: string;
  readonly pollIntervalMs?: number;
  readonly onSnapshot: (snapshot: FleetResponseBody) => void;
  readonly onStateChange?: (state: FleetStreamState) => void;
  readonly onError?: (error: unknown) => void;
  /** Injected for tests; returns `undefined` to force the polling fallback. */
  readonly eventSourceFactory?: (url: string) => EventSourceLike | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  readonly clearIntervalImpl?: (handle: unknown) => void;
}

function isFleetSnapshot(value: unknown): value is FleetResponseBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<FleetResponseBody>;
  return (
    typeof body.generatedAt === "number" &&
    typeof body.thresholds === "object" &&
    body.thresholds !== null &&
    typeof body.summary === "object" &&
    body.summary !== null &&
    Array.isArray(body.robots)
  );
}

function defaultEventSource(url: string): EventSourceLike | undefined {
  // Node before 22.3 (and a jsdom without it) has no EventSource: poll instead
  // of throwing on a screen that would otherwise stay empty.
  if (typeof EventSource === "undefined") return undefined;
  return new EventSource(url);
}

function describeStreamError(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      return String((parsed as { message: unknown }).message);
    }
  } catch {
    // Fall through to the raw payload.
  }
  return text;
}

export class FleetStream {
  private readonly options: FleetStreamOptions;
  private streamState: FleetStreamState = "idle";
  private source: EventSourceLike | undefined;
  private timer: unknown;
  private polling = false;
  private running = false;

  constructor(options: FleetStreamOptions) {
    this.options = options;
  }

  get state(): FleetStreamState {
    return this.streamState;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.setState("connecting");

    const factory = this.options.eventSourceFactory ?? defaultEventSource;
    let source: EventSourceLike | undefined;
    try {
      source = factory(this.options.streamUrl ?? STREAM_URL);
    } catch (error) {
      this.report(error);
    }

    if (!source) {
      this.beginPolling("polling");
      return;
    }

    this.source = source;
    source.addEventListener("hello", () => this.markLive());
    source.addEventListener("fleet", (event) => this.onFleetEvent(event));
    source.addEventListener("error", (event) => this.onStreamError(event));
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const source = this.source;
    this.source = undefined;
    source?.close();
    this.stopPolling();
    this.setState("stopped");
  }

  private markLive(): void {
    if (!this.running) return;
    // A frame means the socket is delivering again: the poll is now duplicated work.
    this.stopPolling();
    this.setState("live");
  }

  private onFleetEvent(event: FleetStreamEvent): void {
    if (!this.running) return;
    if (typeof event.data !== "string") {
      this.report(new Error("Fleet frame carried no data."));
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      this.report(error);
      return;
    }

    if (!isFleetSnapshot(payload)) {
      this.report(new Error("Fleet frame did not match the fleet snapshot shape."));
      return;
    }

    this.markLive();
    this.options.onSnapshot(payload);
  }

  private onStreamError(event: FleetStreamEvent): void {
    if (!this.running) return;
    // A server-sent `event: error` has data; a transport failure does not, and
    // the browser retries that one on its own after the `retry:` delay.
    if (typeof event.data === "string") {
      this.report(new Error(describeStreamError(event.data)));
    }
    // Keep the screen alive while the socket reconnects.
    this.beginPolling("reconnecting");
  }

  /**
   * Start (or reuse) the polling fallback. `polling` means there is no socket at
   * all; `reconnecting` means one is retrying underneath.
   */
  private beginPolling(state: "polling" | "reconnecting"): void {
    if (!this.running) return;
    this.setState(state);
    if (this.timer !== undefined) return;

    void this.poll();
    const interval = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const setIntervalImpl =
      this.options.setIntervalImpl ?? ((callback, ms) => setInterval(callback, ms));
    this.timer = setIntervalImpl(() => void this.poll(), interval);
  }

  private stopPolling(): void {
    if (this.timer === undefined) return;
    const clearIntervalImpl =
      this.options.clearIntervalImpl ?? ((handle) => clearInterval(handle as never));
    clearIntervalImpl(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;

    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const response = await fetchImpl(this.options.pollUrl ?? POLL_URL, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Fleet poll failed with ${response.status}.`);

      const payload: unknown = await response.json();
      if (!isFleetSnapshot(payload)) {
        throw new Error("Fleet poll returned an unexpected body.");
      }
      if (!this.running) return;
      this.options.onSnapshot(payload);
    } catch (error) {
      if (this.running) this.report(error);
    } finally {
      this.polling = false;
    }
  }

  private setState(next: FleetStreamState): void {
    if (this.streamState === next) return;
    this.streamState = next;
    this.options.onStateChange?.(next);
  }

  private report(error: unknown): void {
    this.options.onError?.(error);
  }
}
