import { expect, it, vi } from "vitest";
import { createAnthropicMessagesTransportStreamFn } from "../transports/anthropic-transport-stream.js";
import { makeAnthropicTransportModel } from "../transports/anthropic-transport-stream.test-support.js";
import type { Context, Tool } from "../types.js";
import { streamAnthropic } from "./anthropic.js";
import { streamOpenAICompletions } from "./openai-completions.js";
import { makeOpenAIProviderModel } from "./openai-provider.test-support.js";
import { streamOpenAIResponses } from "./openai-responses.js";

const openAIAdapters = [
  {
    name: "OpenAI Completions",
    stream: (context: Context, onPayload: () => never) =>
      streamOpenAICompletions(makeOpenAIProviderModel("openai-completions"), context, {
        apiKey: "fixture",
        onPayload,
      }),
  },
  {
    name: "OpenAI Responses",
    stream: (context: Context, onPayload: () => never) =>
      streamOpenAIResponses(makeOpenAIProviderModel("openai-responses"), context, {
        apiKey: "fixture",
        onPayload,
      }),
  },
];
const adapters = [
  ...openAIAdapters,
  {
    name: "Anthropic provider",
    stream: (context: Context, onPayload: () => never) =>
      streamAnthropic(makeAnthropicTransportModel(), context, {
        apiKey: "fixture",
        onPayload,
      }),
  },
  {
    name: "Anthropic transport",
    stream: (context: Context, onPayload: () => never) =>
      createAnthropicMessagesTransportStreamFn()(makeAnthropicTransportModel(), context, {
        apiKey: "fixture",
        onPayload,
      }),
  },
];

it.each(
  adapters.flatMap((adapter) =>
    ["name", "parameters", "description"].map((field) => ({
      name: adapter.name,
      stream: adapter.stream,
      field,
    })),
  ),
)("$name reports an unreadable tool $field before request handoff", async ({ stream, field }) => {
  const tool = { name: "broken", description: "Broken", parameters: {} };
  Object.defineProperty(tool, field, {
    get() {
      throw new Error(`${field} exploded`);
    },
  });
  const onPayload = vi.fn(() => {
    throw new Error("payload reached");
  });
  const events = await stream(
    {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      tools: [tool, { name: "lookup", description: "Lookup", parameters: {} }],
    },
    onPayload,
  );
  const result = await events.result();

  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain(`${field} exploded`);
  expect(onPayload).not.toHaveBeenCalled();
});

it.each(openAIAdapters)(
  "$name reports unreadable inventories before request handoff",
  async ({ stream }) => {
    const tools = new Proxy<Tool[]>([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const onPayload = vi.fn(() => {
      throw new Error("payload reached");
    });
    const result = await stream(
      { messages: [{ role: "user", content: "hello", timestamp: 0 }], tools },
      onPayload,
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("length exploded");
    expect(onPayload).not.toHaveBeenCalled();
  },
);
