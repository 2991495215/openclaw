import { sidebarSidePanels } from "../sidebar-layout.ts";
import type { RegionProps } from "./chat-sidebar-region-types.ts";

/** Complete a single close without interfering with Close all's retained launcher. */
export function closeEmptyMobileHost(
  props: Pick<RegionProps, "mobileHost" | "layout">,
  scopeKey: string | undefined,
): boolean {
  if (
    !props.mobileHost ||
    props.mobileHost.scopeKey !== scopeKey ||
    props.mobileHost.destination.area !== "panels" ||
    props.mobileHost.destination.page ||
    sidebarSidePanels(props.layout).length ||
    props.layout.newTab
  ) {
    return false;
  }
  props.mobileHost.close();
  return true;
}
