import fs from "node:fs";
import path from "node:path";
import { WORKER_BUNDLE_WINDOWS_SECURITY_HELPER_PATH } from "../shared/worker-bundle-hash.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { stageFreeBsdManagedHandoffNativeRuntime } from "./update-managed-service-handoff-native.js";
import {
  MANAGED_HANDOFF_RUNTIME_ENTRY,
  managedHandoffRuntimeEntrypoint,
} from "./update-managed-service-handoff-runtime-assets.js";

/** Prepare the complete lease owner before launch; the caller owns partial-stage cleanup. */
export function stageManagedHandoffRuntime(directory: string): string[] {
  const source = resolveRuntimeWorkerUrl(managedHandoffRuntimeEntrypoint);
  if (!source.pathname.endsWith(".mjs")) {
    throw new Error(
      "Managed handoff requires its sealed runtime; use the repository test runner or the dist-backed pnpm openclaw CLI.",
    );
  }
  const destination = path.join(directory, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, fs.readFileSync(source), { mode: 0o600, flag: "wx" });
  const files = [destination];
  if (process.platform === "win32") {
    const helperSource = new URL(`./${WORKER_BUNDLE_WINDOWS_SECURITY_HELPER_PATH}`, source);
    if (!fs.lstatSync(helperSource).isFile()) {
      throw new Error("Managed handoff Windows permission helper requires a regular package file");
    }
    const helperDestination = path.join(
      path.dirname(destination),
      WORKER_BUNDLE_WINDOWS_SECURITY_HELPER_PATH,
    );
    fs.writeFileSync(helperDestination, fs.readFileSync(helperSource), {
      mode: 0o600,
      flag: "wx",
    });
    files.push(helperDestination);
  }
  // Survives update-to-triage exec, then shares the helper's sensitive-file cleanup.
  return [...files, ...stageFreeBsdManagedHandoffNativeRuntime(directory)];
}
