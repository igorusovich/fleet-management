import { FleetScreen } from "@/components/fleet/fleet-screen";

/**
 * The fleet overview.
 *
 * A server shell around a client screen: the HTML is static, the data arrives
 * over the SSE connection the screen opens on mount. That keeps `/` a `○` route
 * — no database read at request time, and no server work per visitor.
 */
export default function FleetPage() {
  return <FleetScreen />;
}
