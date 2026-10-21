import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import {
  installAnthropicTransportTestHost,
  makeAnthropicTransportModel,
} from "./anthropic-transport-stream.test-support.js";

const coreTransportHost = getAiTransportHost();
const guardedFetch = vi.fn<typeof fetch>();
const buildModelFetch = vi.fn();

beforeEach(() =>
  installAnthropicTransportTestHost({ coreTransportHost, buildModelFetch, guardedFetch }),
);
afterAll(() => configureAiTransportHost(coreTransportHost));

it.each([
  {
    label: "defaults missing catalog limits",
    maxTokens: undefined,
    contextWindow: 200_000,
    requested: undefined,
    expected: 4_096,
  },
  {
    label: "rejects an invalid catalog limit",
    maxTokens: 0,
    contextWindow: 4_096,
    requested: undefined,
    expected: undefined,
  },
  {
    label: "floors a requested token limit",
    maxTokens: 7.9,
    contextWindow: 200_000,
    requested: 1.9,
    expected: 1,
  },
  {
    label: "falls back from a subunit request to the floored catalog limit",
    maxTokens: 7.9,
    contextWindow: 200_000,
    requested: 0.5,
    expected: 7,
  },
  {
    label: "rejects a subunit catalog limit before fetch",
    maxTokens: 0.5,
    contextWindow: 4_096,
    requested: undefined,
    expected: undefined,
  },
  {
    label: "defaults a subunit context window when the catalog limit is missing",
    maxTokens: undefined,
    contextWindow: 0.5,
    requested: undefined,
    expected: 4_096,
  },
  {
    label: "floors the fallback context window before dividing its token budget",
    maxTokens: undefined,
    contextWindow: 15.9,
    requested: undefined,
    expected: 3,
  },
])("$label", async ({ maxTokens, contextWindow, requested, expected }) => {
  const model = makeAnthropicTransportModel({
    id: "custom-model",
    provider: "custom-anthropic",
    baseUrl: "https://custom.example/anthropic",
    reasoning: false,
    contextWindow,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });
  if (maxTokens === undefined) {
    Reflect.deleteProperty(model, "maxTokens");
  }
  const stream = await createAnthropicMessagesTransportStreamFn()(
    model,
    { messages: [makeUserMessage("hello", 0)] },
    { apiKey: "fake", maxTokens: requested },
  );
  const result = await stream.result();
  if (expected === undefined) {
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      "Anthropic Messages transport requires a positive maxTokens value",
    );
    expect(guardedFetch).not.toHaveBeenCalled();
  } else {
    expect(result.stopReason).toBe("stop");
    const body = guardedFetch.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("expected a serialized Anthropic request");
    }
    expect(JSON.parse(body)).toMatchObject({
      model: model.id,
      max_tokens: expected,
      stream: true,
    });
  }
});
