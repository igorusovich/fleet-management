/**
 * `GET /api/stream` — the live fleet as Server-Sent Events.
 *
 * Frames, in order:
 *   1. `retry: 2000`                  how long the browser waits before retrying
 *   2. `event: hello`                 tick, heartbeat, retry and thresholds
 *   3. `event: fleet`                 immediately, then once per tick
 *   4. `: ping`                       only if nothing has been written for a heartbeat
 *   5. `event: error` then close      if a tick throws
 *
 * Every `fleet` frame is a *complete* snapshot, byte-identical in shape to
 * `GET /api/fleet`. That is what makes the design forgiving: a dropped frame
 * costs one second, a reconnect needs no replay, and the polling fallback is the
 * same body over `fetch` instead of a second data model.
 *
 * The tick is not write-driven on purpose. Status is derived from
 * `now - receivedAt`, so a stopped simulator must still walk its robots to
 * `offline` with zero database writes. Ingest does not push frames either; it
 * only invalidates the hub so the next tick reflects the report.
 *
 * Plain function over Web `Request`/`Response` with an injected clock and timer,
 * no `next/*` import, so the gate drives whole frames without a server.
 */

import type { FleetResponseBody } from "./fleet";

/** Frame interval: the simulator reports at 1 Hz, so the stream need not be faster. */
export const STREAM_TICK_MS = 1_000;

/** Comment interval when a tick is configured slower than this. */
export const STREAM_HEARTBEAT_MS = 15_000;

/** Reconnect delay handed to the browser in the opening `retry:` line. */
export const STREAM_RETRY_MS = 2_000;

/** Anything with a current snapshot: the hub in production, a stub in tests. */
export interface SnapshotSource {
  snapshot(): FleetResponseBody;
}

/** `setInterval`-shaped, but any timer works — tests pass a manual one. */
export type Schedule = (callback: () => void, ms: number) => unknown;
export type CancelSchedule = (handle: unknown) => void;

export interface StreamDeps {
  readonly hub: SnapshotSource;
  /** Read per write, so one frame can be dated and the next see a later clock. */
  readonly now: () => number;
  readonly tickMs?: number;
  readonly heartbeatMs?: number;
  readonly schedule?: Schedule;
  readonly cancel?: CancelSchedule;
}

interface FrameFields {
  event?: string;
  id?: number;
  data?: unknown;
}

function frame(fields: FrameFields): string {
  let text = "";
  if (fields.id !== undefined) text += `id: ${fields.id}\n`;
  if (fields.event !== undefined) text += `event: ${fields.event}\n`;
  if (fields.data !== undefined) text += `data: ${JSON.stringify(fields.data)}\n`;
  return `${text}\n`;
}

function fleetFrame(snapshot: FleetResponseBody): string {
  return frame({ id: snapshot.generatedAt, event: "fleet", data: snapshot });
}

function errorFrame(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return frame({ event: "error", data: { message } });
}

function defaultSchedule(callback: () => void, ms: number): unknown {
  return setInterval(callback, ms);
}

function defaultCancel(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

export function handleStream(request: Request, deps: StreamDeps): Response {
  const tickMs = deps.tickMs ?? STREAM_TICK_MS;
  const heartbeatMs = deps.heartbeatMs ?? STREAM_HEARTBEAT_MS;
  const schedule = deps.schedule ?? defaultSchedule;
  const cancel = deps.cancel ?? defaultCancel;
  const encoder = new TextEncoder();

  // Set inside `start`; `cancel` can only run after `start`, but the stream type
  // does not know that, so start from a no-op.
  let stop = (): void => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let finished = false;
      let lastWriteAt = deps.now();
      let timer: unknown;

      const write = (text: string): void => {
        if (finished) return;
        controller.enqueue(encoder.encode(text));
        lastWriteAt = deps.now();
      };

      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) {
          cancel(timer);
          timer = undefined;
        }
        request.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // The consumer already cancelled; closing twice is not an error here.
        }
      };

      const onAbort = (): void => finish();
      stop = finish;
      request.signal.addEventListener("abort", onAbort, { once: true });

      try {
        write(`retry: ${STREAM_RETRY_MS}\n\n`);
        write(
          frame({
            event: "hello",
            data: {
              tickMs,
              heartbeatMs,
              retryMs: STREAM_RETRY_MS,
              thresholds: deps.hub.snapshot().thresholds,
              generatedAt: deps.now(),
            },
          }),
        );
        write(fleetFrame(deps.hub.snapshot()));
      } catch (error) {
        write(errorFrame(error));
        finish();
        return;
      }

      if (finished) return;

      timer = schedule(() => {
        if (finished) return;
        try {
          // With the default 1 s tick this never fires: a frame is always written.
          // It is the safety net for a tick configured slower than the heartbeat,
          // where a proxy could otherwise drop an idle connection.
          if (deps.now() - lastWriteAt >= heartbeatMs) write(": ping\n\n");
          write(fleetFrame(deps.hub.snapshot()));
        } catch (error) {
          write(errorFrame(error));
          finish();
        }
      }, tickMs);
    },

    cancel() {
      // The browser navigated away or the proxy dropped us.
      stop();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Documented Next mitigation for proxies that buffer responses; without it
      // the first frame can sit in a buffer and the screen looks dead.
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
