import { describe, expect, it } from "vitest";
import { resolveSpeechTalkApiKeyOverride } from "./tts-provider-helpers.js";

describe("resolveSpeechTalkApiKeyOverride", () => {
  it("inherits an absent key but clears an explicitly blank override", () => {
    const merge = (value: unknown) => ({
      apiKey: "inherited-key",
      ...resolveSpeechTalkApiKeyOverride(value, "talk.providers.example.apiKey"),
    });
    expect(merge(undefined)).toEqual({ apiKey: "inherited-key" });
    expect(merge(" ")).toEqual({ apiKey: undefined });
    expect(merge(null)).toEqual({ apiKey: undefined });
    expect(merge(" literal-key ")).toEqual({ apiKey: "literal-key" });
  });

  it("rejects unresolved references at the caller's Talk config path", () => {
    expect(() =>
      resolveSpeechTalkApiKeyOverride(
        { source: "env", provider: "default", id: "SYNTHETIC_API_KEY" },
        "talk.providers.example.apiKey",
      ),
    ).toThrow(/talk\.providers\.example\.apiKey/);
  });
});
