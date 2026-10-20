import { parseControlUiFocusLocation } from "@openclaw/session-url-contract";
import { pathForRoute, routeIdFromPath } from "../../app-route-paths.ts";

/** Setup always targets the Gateway, not the Systems owner's retained selection. */
export function hostDesktopSetupHref(basePath: string, returnPath: string): string {
  const search = new URLSearchParams({ desktopSetup: "gateway", returnTo: returnPath });
  return pathForRoute("systems", basePath) + "?" + search.toString();
}

export function readHostDesktopSetupNavigation(search: string, basePath: string) {
  const params = new URLSearchParams(search);
  if (params.get("desktopSetup") !== "gateway") {
    return null;
  }
  const path = params.get("returnTo");
  // Only a local product pathname is a return destination; never carry auth/search/hash data.
  const url = path ? URL.parse(path, "https://openclaw.invalid") : null;
  const routeId = url ? routeIdFromPath(url.pathname, basePath) : null;
  const focus = url ? parseControlUiFocusLocation(url.pathname, basePath) : null;
  const desktop = focus?.status === "valid" && focus.target.kind === "desktop";
  return {
    returnTo:
      url &&
      url.origin === "https://openclaw.invalid" &&
      path === url.pathname &&
      (routeId !== null || desktop) &&
      routeId !== "systems"
        ? { routeId, pathname: url.pathname }
        : null,
  };
}
