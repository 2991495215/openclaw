// OpenClaw rescue policy tests cover eligibility and safety decisions.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSystemAgentRescuePolicy } from "./rescue-policy.js";

function decide(cfg: OpenClawConfig, overrides = {}) {
  return resolveSystemAgentRescuePolicy({
    cfg,
    senderIsOwner: true,
    isDirectMessage: true,
    ...overrides,
  });
}

describe("resolveSystemAgentRescuePolicy", () => {
  it("allows auto rescue for owner DMs in YOLO host posture with sandboxing off", () => {
    expect(decide({}).allowed).toBe(true);
  });

  it("hard-denies rescue when sandboxing is active", () => {
    const decision = decide({
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
    expect(decision).toEqual({
      allowed: false,
      message:
        "OpenClaw rescue is blocked because OpenClaw sandboxing is active. Fix the install locally or disable sandboxing before using remote rescue.",
    });
  });

  it("keeps auto rescue closed outside YOLO host posture", () => {
    const decision = decide({
      tools: { exec: { security: "allowlist", ask: "always" } },
    });
    expect(decision).toEqual({
      allowed: false,
      message: "OpenClaw rescue requires YOLO host posture with sandboxing off.",
    });
  });

  it("requires owner identity and direct messages by default", () => {
    const notOwnerDecision = decide({}, { senderIsOwner: false });
    expect(notOwnerDecision).toEqual({
      allowed: false,
      message: "OpenClaw rescue only accepts commands from an OpenClaw owner.",
    });

    const notDirectMessageDecision = decide({}, { isDirectMessage: false });
    expect(notDirectMessageDecision).toEqual({
      allowed: false,
      message: "OpenClaw rescue is restricted to owner DMs by default.",
    });
  });
});
