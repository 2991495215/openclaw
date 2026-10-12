import path from "node:path";
import { resolveSelectedCronJobsStorePath } from "../cron/store/paths.js";
import { buildGatewayCronService as buildGatewayCronServiceRuntime } from "./server-cron.js";

export function buildGatewayCronService(
  params: Omit<Parameters<typeof buildGatewayCronServiceRuntime>[0], "storePath">,
) {
  const legacyStore = (params.cfg.cron as { store?: unknown } | undefined)?.store;
  const env =
    typeof legacyStore === "string"
      ? {
          ...process.env,
          OPENCLAW_SKIP_CRON: "0",
          OPENCLAW_STATE_DIR: path.dirname(legacyStore),
        }
      : (params.env ?? process.env);
  return buildGatewayCronServiceRuntime({
    ...params,
    env,
    storePath: resolveSelectedCronJobsStorePath(
      typeof legacyStore === "string" ? legacyStore : undefined,
      env,
    ),
  });
}
