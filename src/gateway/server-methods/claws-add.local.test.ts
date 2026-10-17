import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { validateClawLifecyclePlanResult } from "../../../packages/gateway-protocol/src/index.js";
import type { ClawLifecyclePlanResult } from "../../../packages/gateway-protocol/src/schema/claws.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  authorizeOperatorScopesForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "../method-scopes.js";
import { clawsAddHandlers } from "./claws-add.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const enabled = { gateway: { controlUi: { experimental: { claws: true } } } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function fixture() {
  const state = await createOpenClawTestState({ label: "local-claw-add", applyEnv: true });
  cleanups.push(state.cleanup);
  await state.writeConfig(enabled);
  const localPath = state.path("imported-bot");
  await fs.mkdir(localPath);
  await fs.writeFile(
    path.join(localPath, "package.json"),
    JSON.stringify({ name: "@fixture/local-bot", version: "1.0.0", openclaw: { claw: "CLAW.md" } }),
  );
  await fs.writeFile(
    path.join(localPath, "CLAW.md"),
    "---\nschemaVersion: 1\nagent:\n  id: local-bot\n  name: Local Bot\n  identity:\n    avatar: avatars/bot.png\nworkspace:\n  files:\n    - source: icon.png\n      path: avatars/bot.png\n---\n\nYou are a research bot.\n",
  );
  const icon = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=",
    "base64",
  );
  await fs.writeFile(path.join(localPath, "icon.png"), icon);
  return { state, source: { localPath }, icon };
}

async function request(
  method: "claws.add.plan" | "claws.add.apply",
  params: Record<string, unknown>,
  hasCurrentClientAuthority?: () => boolean,
) {
  const replies: Parameters<RespondFn>[] = [];
  await expectDefined(
    clawsAddHandlers[method],
    method,
  )({
    req: { type: "req", id: method, method },
    params,
    respond: (...args) => replies.push(args),
    context: {
      getRuntimeConfig: () => enabled,
      localEmbedded: true,
    } as GatewayRequestContext,
    client: null,
    hasCurrentClientAuthority,
    isWebchatConnect: () => false,
  });
  return expectDefined(replies[0], "Gateway response");
}

describe("local Claw Add through the Gateway", () => {
  it("requires admin scope to inspect host files and preserves catalog read access", () => {
    const local = { source: { localPath: "/tmp/imported-bot" } };
    expect(resolveLeastPrivilegeOperatorScopesForMethod("claws.add.plan", local)).toEqual([
      "operator.admin",
    ]);
    expect(authorizeOperatorScopesForMethod("claws.add.plan", ["operator.read"], local)).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(
      authorizeOperatorScopesForMethod("claws.add.plan", ["operator.read"], {
        source: { packageName: "@openclaw/research", version: "1.0.0" },
      }),
    ).toEqual({ allowed: true });
  });

  it("installs a local package as an ordinary agent with its instructions and avatar", async () => {
    const { state, source, icon } = await fixture();
    const preview = await request("claws.add.plan", { source });
    expect(preview[0], JSON.stringify(preview[2])).toBe(true);
    const plan = preview[1] as ClawLifecyclePlanResult;
    expect(validateClawLifecyclePlanResult(plan)).toBe(true);
    expect(plan.manifestDisclosure?.source).toMatchObject({ localName: "@fixture/local-bot" });
    expect(plan.blockers).toEqual([]);
    expect(plan.target.agentId).toBe("local-bot");
    const applied = await request("claws.add.apply", { source, planIntegrity: plan.planIntegrity });
    expect(applied[0], JSON.stringify(applied[2])).toBe(true);
    expect(applied[1]).toMatchObject({
      agentId: "local-bot",
      status: "complete",
      readiness: { ready: true },
    });
    const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    expect(config.agents.entries["local-bot"].identity.avatar).toBe("avatars/bot.png");
    const workspace = config.agents.entries["local-bot"].workspace;
    expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toContain(
      "You are a research bot.",
    );
    expect(await fs.readFile(path.join(workspace, "avatars/bot.png"))).toEqual(icon);
  });

  it("rejects a package changed after preview without creating the agent", async () => {
    const { state, source } = await fixture();
    const preview = await request("claws.add.plan", { source });
    expect(preview[0], JSON.stringify(preview[2])).toBe(true);
    const plan = preview[1] as ClawLifecyclePlanResult;
    await fs.appendFile(path.join(source.localPath, "CLAW.md"), "Changed instructions.\n");
    const applied = await request("claws.add.apply", { source, planIntegrity: plan.planIntegrity });
    expect(applied[0]).toBe(false);
    expect(applied[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("changed since review"),
    });
    const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    expect(config.agents?.entries?.["local-bot"]).toBeUndefined();
  });

  it("rejects relative paths and withholds a local preview after authority is revoked", async () => {
    const { source } = await fixture();
    const relative = await request("claws.add.plan", { source: { localPath: "imported-bot" } });
    expect(relative[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("absolute path on the Gateway host"),
    });
    let checks = 0;
    const revoked = await request("claws.add.plan", { source }, () => ++checks < 3);
    expect(checks).toBe(3);
    expect(revoked[0]).toBe(false);
    expect(revoked[1]).toBeUndefined();
    expect(revoked[2]).toMatchObject({ code: "FORBIDDEN" });
  });
});
