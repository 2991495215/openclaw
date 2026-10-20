import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import {
  assertNativeUiCatalog,
  assertNativeUiPolicy,
} from "../../scripts/e2e/lib/upgrade-survivor/native-plugin-ui.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJson, successSummary, writeJson } from "./upgrade-survivor-shard.test-support.js";

const id = "openclaw-survivor-native-ui";
const revision = "a".repeat(64);
const module = {
  pluginId: id,
  revision,
  entryUrl: "/__openclaw__/plugins/control-ui/" + id + "/" + revision + "/index.js",
  styles: ["/__openclaw__/plugins/control-ui/" + id + "/" + revision + "/style.css"],
};
const disabled = {
  plugins: [],
  diagnostics: [{ pluginId: id, code: "custom-plugin-ui-disabled" }],
};
const enabled = { plugins: [module], diagnostics: [] };
const dirs = useAutoCleanupTempDirTracker(afterEach);

it("rejects the pre-change omitted-policy catalog and accepts the native module after upgrade", () => {
  expect(() => assertNativeUiCatalog(disabled, true)).toThrow(
    "did not make the existing native UI eligible",
  );
  expect(assertNativeUiCatalog(enabled, true)).toEqual(module);
  expect(() => assertNativeUiCatalog(enabled, false)).toThrow("Opted-out native UI was advertised");
  expect(() => assertNativeUiCatalog(disabled, false)).not.toThrow();
  expect(() => assertNativeUiCatalog({ plugins: [], diagnostics: [] }, true)).toThrow("eligible");
});

it("keeps omission distinct from the old explicit false and checks retained settings", () => {
  const config = {
    gateway: { controlUi: { enabled: true, experimental: {} as { customPlugins?: boolean } } },
    plugins: {
      entries: {
        [id]: { enabled: true, config: { label: "Existing operator setting", retained: 177869 } },
      },
    },
  };
  expect(() => assertNativeUiPolicy(config, "omitted")).not.toThrow();
  config.gateway.controlUi.experimental.customPlugins = false;
  expect(() => assertNativeUiPolicy(config, "false")).not.toThrow();
  expect(() => assertNativeUiPolicy(config, "omitted")).toThrow(
    "inserted a native UI policy override",
  );
  delete config.gateway.controlUi.experimental.customPlugins;
  expect(() => assertNativeUiPolicy(config, "false")).toThrow(
    "lost the explicit native UI opt-out",
  );
  config.plugins.entries[id]!.config.retained = 0;
  expect(() => assertNativeUiPolicy(config, "omitted")).toThrow("changed native plugin settings");
});

function proof(policy: string, eligible: boolean) {
  return {
    status: "passed",
    stage: "candidate",
    policy,
    servingVersion: "2026.10.20",
    eligible,
    pluginSettingsPreserved: true,
    operatorDataPreserved: true,
    installed: { archiveSha256: "b".repeat(64), files: { "index.mjs": "c".repeat(64) } },
    assets: eligible
      ? [
          { status: 200, authenticated: true, sha256: "d".repeat(64) },
          { status: 200, authenticated: true, sha256: "e".repeat(64) },
          { status: 401, authenticated: false },
        ]
      : [
          { status: 404, authenticated: true },
          { status: 404, authenticated: true },
        ],
    baseline: {
      status: "passed",
      stage: "baseline",
      policy,
      servingVersion: "2026.10.5",
      eligible: false,
      pluginSettingsPreserved: true,
      operatorDataPreserved: true,
    },
  };
}
function publish(overrides: Record<string, unknown>) {
  const root = dirs.make("native-ui-upgrade-publication-");
  const output = path.join(root, "public");
  writeJson(
    path.join(root, "summary.json"),
    successSummary("2026.10.5", "2026.10.20", {
      // Independent backup contract prerequisite for the existing operator-state publisher.
      backupRollback: {
        status: "passed",
        baselineVersion: "2026.10.5",
        candidateVersion: "2026.10.20",
        runtime: {
          version: "2026.10.5",
          schemaVersions: { state: 13, agent: 1 },
          manifestSha256: "f".repeat(64),
          entrySha256: "f".repeat(64),
        },
        candidateSchemaVersions: { state: 13, agent: 1 },
        archive: { sha256: "f".repeat(64) },
        before: {
          files: [],
          databases: [
            {
              kind: "agent",
              agentId: "main",
              present: true,
              userVersion: 1,
              contentVersion: 1,
              sessions: [{ key: "synthetic", sessionId: "synthetic" }],
              tables: [{ table: "transcript_events", rows: 1, sha256: "f".repeat(64) }],
            },
          ],
        },
        preflights: [{ agentId: "main", status: "exact", foundVersion: 1, targetVersion: 1 }],
        sessionReads: [{ agentId: "main", count: 1 }],
      },
      phases: [
        {
          phase: "prepare-native-plugin-ui-upgrade",
          status: "passed",
          at: "2026-10-20T18:00:00.000Z",
        },
      ],
      ...overrides,
    }),
  );
  publishDiagnostics(root, output, (value: string) => value, "passed");
  return readJson(path.join(output, "summary.json"));
}

it("publishes both actual baseline-to-candidate policy witnesses without raw plugin state", () => {
  const result = publish({
    nativePluginUi: proof("omitted", true),
    nativePluginUiOptOut: proof("false", false),
  });
  expect(result.nativePluginUi).toMatchObject({
    status: "passed",
    baselineVersion: "2026.10.5",
    candidateVersion: "2026.10.20",
    omittedBecameEligible: true,
    explicitFalsePreserved: true,
    authenticatedAssetsServed: true,
    unauthenticatedAssetsDenied: true,
    optedOutAssetsDenied: true,
    pluginSettingsPreserved: true,
    operatorDataPreserved: true,
  });
  expect(JSON.stringify(result.nativePluginUi)).not.toContain("packageRoot");
});

it("cannot publish a generic green or an unqualified opt-out as feature upgrade proof", () => {
  expect(() => publish({})).toThrow("native plugin UI upgrade evidence");
  const optOut = proof("false", false);
  optOut.baseline.policy = "omitted";
  expect(() =>
    publish({ nativePluginUi: proof("omitted", true), nativePluginUiOptOut: optOut }),
  ).toThrow("native plugin UI upgrade evidence");
  optOut.baseline.policy = "false";
  optOut.assets[0]!.status = 200;
  expect(() =>
    publish({ nativePluginUi: proof("omitted", true), nativePluginUiOptOut: optOut }),
  ).toThrow("native plugin UI upgrade evidence");
});
