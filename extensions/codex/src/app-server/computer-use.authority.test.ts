import { describe, expect, it } from "vitest";
import { installCodexComputerUse } from "./computer-use.js";
import {
  createComputerUseRequest,
  expectRequestMethodNotCalled,
  requestCalls,
} from "./computer-use.test-support.js";

describe("Codex Computer Use authority", () => {
  it("releases an accepted readiness thread when owner revocation blocks its tool call", async () => {
    const request = createComputerUseRequest({ installed: true });
    let ownerCurrent = true;
    await expect(
      installCodexComputerUse({
        pluginConfig: { computerUse: {} },
        assertCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
        request: async <T>(
          method: string,
          params?: unknown,
          options?: { timeoutMs?: number; signal?: AbortSignal },
        ) => {
          const result = await request<T>(method, params, options);
          if (method === "thread/start") {
            ownerCurrent = false;
          }
          return result;
        },
      }),
    ).rejects.toThrow("Command owner was revoked");
    expectRequestMethodNotCalled(request, "mcpServer/tool/call");
    expect(
      requestCalls(request).filter(([method]) => method === "thread/unsubscribe"),
    ).toHaveLength(1);
  });
});
