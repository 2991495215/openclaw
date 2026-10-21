import type { RouteLocation } from "@openclaw/uirouter";
import { createEffect } from "solid-js";
import type { SolidRouteProps } from "../../app-route-types.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { createActivityPageState } from "./activity-page-state.ts";
import { ActivityPageView } from "./activity-page-view.tsx";

export function renderSolid(props: SolidRouteProps<RouteLocation>) {
  return (
    <ShellLayoutBoundary traits={{ activityPage: true, settingsWorkspace: true }}>
      <ActivityPage routeLocation={props.data} />
    </ShellLayoutBoundary>
  );
}

function ActivityPage(props: { routeLocation?: RouteLocation }) {
  const page = createActivityPageState(useApplication());
  // Route changes drive the Activity request owner without remounting the page.
  createEffect(
    () => props.routeLocation,
    (location) => page.setRouteLocation(location),
  );
  return (
    <openclaw-activity-page>
      <ActivityPageView page={page} />
    </openclaw-activity-page>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-activity-page": HTMLAttributes<HTMLElement>;
    }
  }
}
