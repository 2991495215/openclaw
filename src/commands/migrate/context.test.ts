import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { buildMigrationContext, buildMigrationReportDir } from "./context.js";

afterEach(() => vi.restoreAllMocks());

function migrationTarget(config: OpenClawConfig, targetAgentId?: string) {
  return buildMigrationContext({
    configOverride: config,
    targetAgentId,
    runtime: createNonExitingRuntime(),
  }).targetAgentId;
}

describe("migration context helpers", () => {
  it("builds report directories with filename-safe timestamps", () => {
    const now = Date.parse("2026-02-23T12:34:56.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(buildMigrationReportDir("codex", "/state")).toBe(
      path.join("/state", "migration", "codex", "2026-02-23T12-34-56.000Z"),
    );
  });

  it("normalizes and validates an explicit migration target agent", () => {
    const config = {
      agents: {
        entries: { main: {}, research: {} },
      },
    };

    expect(migrationTarget(config, "Research")).toBe("research");
    expect(() => migrationTarget(config, "research/../main")).toThrow(
      'Invalid agent id "research/../main"',
    );
    expect(() => migrationTarget(config, "missing")).toThrow('Unknown agent id "missing"');
  });

  it("keeps the configured default when no migration target is supplied", () => {
    expect(migrationTarget({})).toBeUndefined();
  });

  it("rejects an explicitly blank migration target", () => {
    expect(() => migrationTarget({}, "")).toThrow("--agent must not be blank");
  });
});
