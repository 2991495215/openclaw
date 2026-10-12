import { expect, it } from "vitest";
import { buildModelsMenu } from "./commands-models-menu.js";

it.each([true, false])(
  "scopes readiness warnings to part of a provider with a ready choice (ready first=%s)",
  (readyFirst) => {
    const models = ["ready-model", "blocked-model-a", "blocked-model-b"];
    if (!readyFirst) {
      models.reverse();
    }
    const menu = buildModelsMenu({
      byProvider: new Map([["openai", new Set(models)]]),
      modelNames: new Map([["openai/ready-model", "Ready choice"]]),
      modelAvailability: new Map([
        ["openai/ready-model", { availability: true }],
        ["openai/blocked-model-a", { availability: false }],
        ["openai/blocked-model-b", { availability: false }],
      ]),
      loginProviders: new Set(),
    });

    const provider = menu.byProvider.get("openai")!;
    expect(provider.available).toBe(1);
    expect(menu.modelNames.get("openai/ready-model")).toBe("Ready choice");
    expect(menu.modelNames.get("openai/blocked-model-a")).toContain("Unavailable");
    expect(menu.modelNames.get("openai/blocked-model-b")).toContain("Unavailable");
    expect(provider.notice).not.toContain("openai: Unavailable");
    expect(provider.notice).toContain("some models");
    expect(provider.notice).toContain("choose another model");
    expect(provider.notice.split("\n")).toHaveLength(1);
  },
);
