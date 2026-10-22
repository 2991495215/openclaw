// Telegram heartbeat channel plugin fixture for reply conversation tests.
import type { ChannelOutboundAdapter } from "../../../src/channels/plugins/types.public.js";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "../../../src/infra/outbound/send-deps.js";
import { createOutboundTestPlugin } from "../../../src/test-utils/channel-plugins.js";
import { parseTelegramTargetForTest } from "./telegram-targets.js";

type HeartbeatSendFn = (
  to: string,
  text: string,
  opts?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Create an outbound adapter that routes through heartbeat send deps. */
function createHeartbeatOutboundAdapter(): ChannelOutboundAdapter {
  const resolveSend = (deps: unknown) => {
    const send = resolveOutboundSendDep<HeartbeatSendFn>(deps as OutboundSendDeps, "telegram");
    if (!send) {
      throw new Error("Missing telegram outbound send dependency");
    }
    return send;
  };
  return {
    deliveryMode: "direct",
    sendText: async ({ to, text, deps, cfg, accountId, replyToId, threadId, ...opts }) => {
      const send = resolveSend(deps);
      const sendOptions = {
        verbose: false,
        cfg,
        accountId,
        ...(typeof threadId === "number" ? { messageThreadId: threadId } : {}),
        ...(typeof replyToId === "string" ? { replyToMessageId: Number(replyToId) } : {}),
        ...(opts.silent !== undefined ? { silent: opts.silent } : {}),
      };
      return (await send(to, text, sendOptions)) as never;
    },
    sendMedia: async ({ to, text, mediaUrl, deps, cfg, accountId, ...opts }) => {
      const send = resolveSend(deps);
      return (await send(to, text, {
        verbose: false,
        cfg,
        accountId,
        ...opts,
        mediaUrl,
      })) as never;
    },
  };
}

/** Telegram heartbeat channel fixture with thread preservation. */
export const heartbeatRunnerTelegramPlugin = createOutboundTestPlugin({
  id: "telegram",
  label: "Telegram",
  docsPath: "/channels/telegram",
  outbound: createHeartbeatOutboundAdapter(),
  messaging: {
    inferTargetChatType: ({ to }) => {
      const target = parseTelegramTargetForTest(to);
      return target.chatType === "unknown" ? undefined : target.chatType;
    },
    preserveHeartbeatThreadIdForGroupRoute: true,
  },
});
