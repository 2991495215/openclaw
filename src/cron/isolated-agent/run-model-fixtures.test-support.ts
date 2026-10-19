export function makeDefaultModelFallbackResult() {
  return {
    result: {
      result: {
        payloads: [{ text: "test output" }],
        meta: { agentMeta: {} },
      },
    },
    provider: "openai",
    model: "gpt-5.4",
    attempts: [],
  };
}

export function makeDefaultEmbeddedResult() {
  return {
    payloads: [{ text: "test output" }],
    meta: { agentMeta: {} },
  };
}
