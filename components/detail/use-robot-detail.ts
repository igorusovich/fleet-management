"use client";

/**
 * The detail screen's data: one request, then a 5 s poll.
 *
 * The stream has no history, so this screen talks to `GET /api/robots/:id`
 * directly — one payload carries state, history, trail, events and stats, which
 * means the pill and the charts can never disagree about the time.
 *
 * Three behaviours matter here:
 *   1. A window change aborts the in-flight request, and a response is ignored
 *      if its echoed `window.requested` no longer matches the selection — a slow
 *      answer for the old window must not overwrite the one the user asked for.
 *   2. A failed refresh keeps the last payload and reports the failure; the
 *      screen shows how old the data is rather than blanking.
 *   3. Polling pauses while the tab is hidden and resumes on the next tick.
 */

import { useEffect, useState } from "react";

import type { RobotResponseBody, WindowName } from "@/lib/http/robot";

export type DetailState = "loading" | "ready" | "not_found" | "error";

export interface RobotDetail {
  readonly data: RobotResponseBody | null;
  readonly state: DetailState;
  /** Set on a failed poll; the screen keeps drawing the last good payload. */
  readonly failure: string | null;
}

const POLL_MS = 5_000;

export function useRobotDetail(id: string, windowName: WindowName): RobotDetail {
  const [data, setData] = useState<RobotResponseBody | null>(null);
  const [state, setState] = useState<DetailState>("loading");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;

    const schedule = () => {
      if (!alive) return;
      timer = setTimeout(() => {
        void load();
      }, POLL_MS);
    };

    const load = async (): Promise<void> => {
      if (!alive) return;

      if (document.hidden) {
        schedule();
        return;
      }

      try {
        const response = await fetch(
          `/api/robots/${encodeURIComponent(id)}?window=${windowName}`,
          { signal: controller.signal, cache: "no-store" },
        );

        if (!alive || controller.signal.aborted) return;

        if (response.status === 404) {
          // A 404 is an answer, not a failure: the robot has never reported.
          // Keep polling, because a newly registered robot should appear.
          setData(null);
          setState("not_found");
          setFailure(null);
        } else if (!response.ok) {
          throw new Error(`GET /api/robots/${id} answered ${response.status}`);
        } else {
          const body = (await response.json()) as RobotResponseBody;
          if (!alive || controller.signal.aborted) return;
          if (body.window.requested !== windowName) return;

          setData(body);
          setState("ready");
          setFailure(null);
        }
      } catch (cause) {
        if (!alive || controller.signal.aborted) return;
        setFailure(cause instanceof Error ? cause.message : String(cause));
        setState((previous) => (previous === "ready" ? "ready" : "error"));
      }

      schedule();
    };

    void load();

    return () => {
      alive = false;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [id, windowName]);

  return { data, state, failure };
}
