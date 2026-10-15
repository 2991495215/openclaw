// Message hook tests cover message hook dispatch and failure handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  registerInternalHook,
  triggerInternalHook,
  type InternalHookEvent,
} from "./internal-hooks.js";
import { dispatchMessageSentHooks } from "./message-sent.js";

describe("message hooks", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("routes internal sent events without adding plugin session correlation", () => {
    const internalSent = vi.fn();
    const runMessageSent = vi.fn(async () => {});
    registerInternalHook("message:sent", internalSent);

    dispatchMessageSentHooks(
      {
        to: "chat-42",
        content: "reply",
        success: true,
        channelId: "telegram",
        conversationId: "chat-42",
      },
      { runMessageSent },
      "agent:main:telegram:chat-42",
      "telegram",
    );

    expect(runMessageSent).toHaveBeenCalledWith(
      { to: "chat-42", content: "reply", success: true },
      { channelId: "telegram", conversationId: "chat-42", accountId: undefined },
    );
    expect(internalSent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:telegram:chat-42" }),
    );
  });

  it("does not trigger action-specific handlers for other actions", async () => {
    const sentHandler = vi.fn();
    registerInternalHook("message:sent", sentHandler);

    await triggerInternalHook(
      createInternalHookEvent("message", "received", "session-1", { content: "hello" }),
    );

    expect(sentHandler).not.toHaveBeenCalled();
  });

  it("isolates async handler errors", async () => {
    const asyncFailHandler = vi.fn(async () => {
      throw new Error("Async hook failed");
    });
    registerInternalHook("message:sent", asyncFailHandler);

    await triggerInternalHook(
      createInternalHookEvent("message", "sent", "s1", { content: "reply" }),
    );
    expect(asyncFailHandler).toHaveBeenCalledOnce();
  });

  it("preserves mutable messages and sessionKey", async () => {
    const events: InternalHookEvent[] = [];
    registerInternalHook("message", (event) => {
      event.messages.push("Echo");
      events.push(event);
    });

    const sessionKey = "agent:main:telegram:abc";
    const received = createInternalHookEvent("message", "received", sessionKey, {
      content: "hi",
    });
    await triggerInternalHook(received);
    await triggerInternalHook(
      createInternalHookEvent("message", "sent", sessionKey, { content: "reply" }),
    );

    expect(received.messages).toContain("Echo");
    expect(events[0]?.sessionKey).toBe(sessionKey);
    expect(events[1]?.sessionKey).toBe(sessionKey);
  });
});
