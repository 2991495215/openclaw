import type { HookRunner } from "../plugins/hooks.js";
import { fireAndForgetHook } from "./fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "./internal-hooks.js";
import {
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "./message-hook-mappers.js";

/** Dispatch prepared observations; internal routing need not be plugin correlation. */
export function dispatchMessageSentHooks(
  canonical: Parameters<typeof toPluginMessageSentEvent>[0],
  hookRunner: Pick<HookRunner, "runMessageSent"> | null | undefined,
  sessionKeyForInternalHooks: string | undefined,
  logPrefix: string,
  logger?: (message: string) => void,
): void {
  if (hookRunner) {
    fireAndForgetHook(
      Promise.resolve(
        hookRunner.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      `${logPrefix}: message_sent plugin hook failed`,
      logger,
    );
  }
  if (sessionKeyForInternalHooks) {
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "sent",
          sessionKeyForInternalHooks,
          toInternalMessageSentContext(canonical),
        ),
      ),
      `${logPrefix}: message:sent internal hook failed`,
      logger,
    );
  }
}
