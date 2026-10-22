import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { isRetryableGatewayReadError } from "../../lib/gateway-errors.ts";
import { createGatewayRetryOwner } from "../../lib/gateway-retry.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { showToast } from "../../lib/toast.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import type {
  HumanMentionAccess,
  HumanMentionRead,
} from "./components/chat-composer-mention-menu.tsx";

registerChatSessionEnglish();

export type ChatMobilePeopleActivation = (() => void) & {
  setPresented: (presented: boolean) => void;
};

export type ChatMobilePeopleMentions = {
  readonly status: "idle" | "loading" | "ready" | "unavailable" | "error" | "insert-rejected";
  readonly truncated: boolean;
  read: () => HumanMentionRead | null;
  /** Activate only on entry to People; release on leaving that page. */
  activate: (presented?: boolean) => ChatMobilePeopleActivation;
  /** Caller closes the page only on true. The native composer owns deferred focus. */
  insert: (profileId: string) => boolean;
};

/** Page presentation only. The receipt is the last native interaction result, not
 * a directory cache. Rendering must not read back into the composer computation
 * that consumes this same pane's props. The native composer owns caching and insertion admission. */
export function createChatMobilePeopleMentions(
  access: () => HumanMentionAccess | undefined,
): ChatMobilePeopleMentions {
  type Activation = {
    access: HumanMentionAccess | undefined;
    receipt?: HumanMentionRead | null;
    status: ChatMobilePeopleMentions["status"];
    request?: object;
    presented: boolean;
    scope?: object;
    retry: ReturnType<typeof createGatewayRetryOwner>;
    stopVisibility?: () => void;
    stopDirectory?: () => void;
  };
  const state = projectChatFields<{ active: Activation | undefined }>({ active: undefined });
  const ownsScope = (page: Activation) =>
    page.access === access() && page.scope === page.access?.scope;
  const read = () =>
    state.active && state.active.access === access() ? (state.active.receipt ?? null) : null;
  const canRequest = (page: Activation) =>
    page.presented && globalThis.document?.visibilityState !== "hidden";
  const syncPresentation = (page: Activation) => {
    if (!canRequest(page)) {
      page.retry.pause();
    } else if (!page.retry.resume() && page.status === "idle") {
      void request();
    }
  };
  const request = async (automatic = false) => {
    const page = state.active;
    if (!page || !canRequest(page)) {
      return;
    }
    if (automatic) {
      page.retry.cancel();
    } else {
      page.retry.reset();
    }
    page.access = access();
    const pending = {};
    page.request = pending;
    page.receipt = page.access?.read();
    page.status = "loading";
    const current = () => {
      if (state.active !== page || page.request !== pending) {
        return false;
      }
      if (ownsScope(page)) {
        return true;
      }
      page.receipt = null;
      page.status = "unavailable";
      return false;
    };

    try {
      const response = page.access?.request();
      page.scope = page.access?.scope;
      const result = await response;
      if (!current()) {
        return;
      }
      page.retry.reset();
      page.receipt = result;
      page.status = page.access === access() && result ? "ready" : "unavailable";
    } catch (error) {
      if (!current()) {
        return;
      }
      page.receipt = page.access?.read();
      page.status = "error";
      if (isRetryableGatewayReadError(error, "users.mentionable")) {
        page.retry.schedule(
          () => {
            if (current()) {
              void request(true);
            }
          },
          error instanceof GatewayProtocolRequestError ? error.retryAfterMs : undefined,
        );
        syncPresentation(page);
      }
    }
  };
  return {
    get status() {
      if (!state.active) {
        return "idle";
      }
      if (state.active.access !== access() || (state.active.status === "ready" && !read())) {
        return "unavailable";
      }
      return state.active.status;
    },
    get truncated() {
      return read()?.result.truncated ?? false;
    },
    read,
    activate: (presented = true) => {
      state.active?.retry.reset();
      state.active?.stopVisibility?.();
      state.active?.stopDirectory?.();
      const page = projectChatFields<Activation>({
        access: access(),
        receipt: undefined,
        status: "idle",
        request: undefined,
        presented,
        scope: undefined,
        retry: createGatewayRetryOwner(),
        stopVisibility: undefined,
        stopDirectory: undefined,
      });
      state.active = page;
      if (globalThis.document) {
        page.stopVisibility = listen(document, "visibilitychange", () => syncPresentation(page));
      }
      syncPresentation(page);
      page.stopDirectory = page.access?.onDirectoryChange(() => {
        if (state.active !== page || page.access !== access() || ownsScope(page)) {
          return;
        }
        page.retry.reset();
        page.request = undefined;
        page.receipt = undefined;
        page.scope = page.access?.scope;
        page.status = page.scope ? "idle" : "unavailable";
        syncPresentation(page);
      });
      return Object.assign(
        () => {
          if (state.active !== page) {
            return;
          }
          page.retry.reset();
          page.stopVisibility?.();
          page.stopDirectory?.();
          state.active = undefined;
        },
        {
          setPresented: (nextPresented: boolean) => {
            if (state.active === page) {
              page.presented = nextPresented;
              syncPresentation(page);
            }
          },
        },
      );
    },
    insert: (profileId) => {
      const inserted = read()?.insert(profileId) ?? false;
      if (!inserted && state.active) {
        state.active.status = "insert-rejected";
        showToast({ message: t("chat.sessionHeader.mentionRejected"), severity: "error" });
      }
      return inserted;
    },
  };
}
