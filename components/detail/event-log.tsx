import { eventLabel, eventTone, formatEventTime, type RobotEvent } from "./detail-view";

/**
 * Faults, charge starts and comms gaps, newest first — the order the API gives
 * them in. An empty list says so; a zero-count table would look like data.
 */
export function EventLog({ events }: { events: readonly RobotEvent[] }) {
  return (
    <section
      aria-labelledby="events-heading"
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 id="events-heading" className="text-sm font-medium">
          Events
        </h2>
        <span className="font-mono text-[10px] text-muted">newest first</span>
      </div>

      {events.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">
          No faults, charge starts or comms gaps in this window.
        </p>
      ) : (
        <ol className="divide-y divide-line">
          {events.map((event) => (
            <li
              key={`${event.kind}-${event.t}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 self-center rounded-full"
                style={{ backgroundColor: eventTone(event.kind) }}
              />
              <time
                dateTime={new Date(event.t).toISOString()}
                className="tnum font-mono text-[11px] text-muted"
              >
                {formatEventTime(event.t)}
              </time>
              <span className="text-sm">{eventLabel(event.kind)}</span>
              {event.detail === null ? null : (
                <span className="font-mono text-[11px] text-muted">{event.detail}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
