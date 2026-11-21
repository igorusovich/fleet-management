import { Suspense } from "react";

import {
  RobotDetailScreen,
  RobotDetailSkeleton,
} from "@/components/detail/robot-detail-screen";

/**
 * One robot, in detail.
 *
 * A static shell: the id comes from the URL on the client and the screen fetches
 * its own payload, exactly like the fleet screen. Under Cache Components URL data
 * (`useParams`) has to sit behind a Suspense boundary, so the shell is rendered
 * once at build time — with the screen's own skeleton, which is what it shows
 * while the first payload loads anyway — and the id resolves in the browser.
 * No database read, no per-request server work.
 */
export default function RobotDetailPage() {
  return (
    <Suspense fallback={<RobotDetailSkeleton />}>
      <RobotDetailScreen />
    </Suspense>
  );
}
