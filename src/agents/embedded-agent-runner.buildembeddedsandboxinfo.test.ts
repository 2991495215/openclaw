import { beforeEach, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals-store.js";
import {
  buildEmbeddedSandboxInfo,
  resolveEmbeddedSandboxInfoExecPolicy,
} from "./embedded-agent-runner/sandbox-info.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import type { SandboxContext } from "./sandbox/types.js";

const sandbox = (overrides: Partial<SandboxContext> = {}) =>
  createSandboxTestContext({
    overrides: {
      workspaceDir: "/tmp/openclaw-sandbox",
      workspaceAccess: "none",
      browserAllowHostControl: true,
      browser: {
        bridgeUrl: "http://localhost:9222",
        noVncUrl: "http://localhost:6080",
        containerName: "openclaw-sbx-browser-test",
      },
      ...overrides,
    },
  });
const elevation = { enabled: true, allowed: true, defaultLevel: "full" } as const;
const blocked = {
  allowed: true,
  defaultLevel: "full",
  fullAccessAvailable: false,
  fullAccessBlockedReason: "host-policy",
};
const promptInfo = {
  enabled: true,
  workspaceDir: "/tmp/openclaw-sandbox",
  containerWorkspaceDir: "/workspace",
  workspaceAccess: "none",
  agentWorkspaceMount: undefined,
  browserBridgeUrl: "http://localhost:9222",
  hostBrowserAllowed: true,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(execApprovals, "loadExecApprovalsReadOnlyAsync").mockResolvedValue({
    version: 1,
    agents: {},
  });
});

it("omits missing sandbox information", () => {
  expect(buildEmbeddedSandboxInfo()).toBeUndefined();
});
it("maps sandbox context into prompt information", () => {
  expect(buildEmbeddedSandboxInfo(sandbox())).toEqual(promptInfo);
});
it.each([true, false])("blocks full access with required sandbox=%s", (required) => {
  const runtime = { fullAccessAvailable: required, fullAccessBlockedReason: "runtime" } as const;
  const expected = required
    ? { ...blocked, allowed: false, defaultLevel: "off" }
    : { ...blocked, fullAccessBlockedReason: "runtime" };
  expect(
    buildEmbeddedSandboxInfo(sandbox(required ? { required: true } : {}), {
      ...elevation,
      ...runtime,
    })?.elevated,
  ).toEqual(expected);
});
it("uses the effective configured exec policy", async () => {
  const policy = await resolveEmbeddedSandboxInfoExecPolicy(
    {
      config: { tools: { exec: { mode: "auto" } } },
      agentId: "main",
      sandboxAvailable: true,
    },
    {},
  );
  expect(buildEmbeddedSandboxInfo(sandbox(), elevation, policy)?.elevated).toEqual(blocked);
});
it.each([
  [{ security: "allowlist", ask: "off" }, blocked],
  [{ security: "full", ask: "always" }, blocked],
  [
    { security: "full", ask: "on-miss" },
    { allowed: true, defaultLevel: "full", fullAccessAvailable: true },
  ],
] as const)("applies host approval floors (%j)", async (hostPolicy, expected) => {
  vi.mocked(execApprovals.loadExecApprovalsReadOnlyAsync).mockResolvedValue({
    version: 1,
    defaults: hostPolicy,
    agents: {},
  });
  const policy = await resolveEmbeddedSandboxInfoExecPolicy(
    { config: { tools: { exec: { mode: "full" } } }, sandboxAvailable: true },
    {},
  );
  expect(buildEmbeddedSandboxInfo(sandbox(), elevation, policy)?.elevated).toEqual(expected);
});
