import fs from "node:fs";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";
import { WORKER_BUNDLE_WINDOWS_SECURITY_HELPER_PATH } from "../../src/shared/worker-bundle-hash.ts";

export function resolveWindowsSecurityHelperPath(rootDir = process.cwd()) {
  return fs.realpathSync(
    path.resolve(
      rootDir,
      "node_modules/@openclaw/fs-safe/dist",
      WORKER_BUNDLE_WINDOWS_SECURITY_HELPER_PATH,
    ),
  );
}

/** Keep fs-safe's relative executable URL valid in every sealed output directory. */
export function createWindowsSecurityHelperBuildPlugin(
  rootDir = process.cwd(),
  outputPrefix = "",
  recordInput?: (file: string) => void,
) {
  const helperPath = resolveWindowsSecurityHelperPath(rootDir);
  return {
    name: "openclaw:windows-security-helper",
    buildStart() {
      recordInput?.(helperPath);
      this.addWatchFile(helperPath);
      this.emitFile({
        type: "asset",
        fileName: `${outputPrefix}${WORKER_BUNDLE_WINDOWS_SECURITY_HELPER_PATH}`,
        source: fs.readFileSync(helperPath),
      });
    },
  } satisfies TsdownPlugin;
}
