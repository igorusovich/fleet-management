"use client";

/**
 * One live fleet connection per screen.
 *
 * The transport is task 6's `FleetStream`, which already owns reconnects, the
 * polling fallback and the four connection states; this hook only binds its
 * lifetime to a component and turns its callbacks into state.
 *
 * The stream is started in an effect, so it never runs during prerendering: the
 * server renders the connecting state and the HTML the browser receives matches
 * its first render exactly.
 */

import { useEffect, useState } from "react";

import type { FleetResponseBody } from "@/lib/http/fleet";
import { FleetStream, type FleetStreamState } from "@/lib/stream/client";

export interface FleetStreamSnapshot {
  readonly snapshot: FleetResponseBody | null;
  readonly state: FleetStreamState;
  readonly error: string | null;
}

export function useFleetStream(): FleetStreamSnapshot {
  const [snapshot, setSnapshot] = useState<FleetResponseBody | null>(null);
  const [state, setState] = useState<FleetStreamState>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stream = new FleetStream({
      onSnapshot: setSnapshot,
      onStateChange: setState,
      onError: (cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    });

    stream.start();
    // StrictMode mounts effects twice in development; both start() and stop()
    // are idempotent on FleetStream, so exactly one connection survives.
    return () => stream.stop();
  }, []);

  return { snapshot, state, error };
}
