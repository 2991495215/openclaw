import type { JSX } from "@solidjs/web";
import {
  For,
  Show,
  createContext,
  createMemo,
  createSignal,
  createUniqueId,
  onSettled,
  useContext,
} from "solid-js";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import { Icon } from "./icon.tsx";
import { Popover } from "./popover.tsx";
import "./panel-feedback.css";

registerEnglishCatalog(registerChatSessionEnglish);

type Feedback = {
  label: string;
  message?: string | null;
  onRetry?: (event: MouseEvent) => unknown;
  recovery?: "retry" | "reload";
  retrying?: boolean;
  retryDisabled?: boolean;
};
type FeedbackReader = () => Feedback | undefined;
type FeedbackScope = {
  presented: () => boolean;
  register: (read: FeedbackReader) => () => void;
};
const FeedbackContext = createContext<FeedbackScope | null>(null);

/** Registers a live presentation accessor, never a copy of the reader's state. */
export function PanelFeedback(props: Feedback & { presented?: boolean }) {
  const scope = useContext(FeedbackContext);
  if (!scope) {
    throw new Error("PanelFeedback requires its panel's PanelFeedbackScope");
  }
  const read = createMemo(() =>
    scope.presented() && props.presented !== false && props.message
      ? {
          label: props.label,
          message: props.message,
          onRetry: props.onRetry,
          recovery: props.recovery,
          retrying: props.retrying,
          retryDisabled: props.retryDisabled,
        }
      : undefined,
  );
  onSettled(() => {
    let mounted = true;
    const unregister = scope.register(() => (mounted ? read() : undefined));
    return () => {
      mounted = false;
      unregister();
    };
  });
  return null;
}

/** Place inside the panel shell, around its scroll body; the footer is a sibling. */
export function PanelFeedbackScope(props: { children: JSX.Element; presented?: boolean }) {
  const parent = useContext(FeedbackContext);
  const contentPresented = useContext(ContentPresentation);
  const [readers, setReaders] = createSignal<FeedbackReader[]>([]);
  const scope: FeedbackScope = {
    presented: () =>
      props.presented !== false && contentPresented() && (parent?.presented() ?? true),
    register:
      parent?.register ??
      ((read) => {
        setReaders((current) => [...current, read]);
        return () => setReaders((current) => current.filter((item) => item !== read));
      }),
  };
  const faults = createMemo(() => {
    if (!scope.presented()) {
      return [];
    }
    const result: Feedback[] = [];
    for (const read of readers()) {
      const fault = read();
      if (
        fault &&
        !result.some((item) => item.label === fault.label && item.message === fault.message)
      ) {
        result.push(fault);
      }
    }
    return result;
  });
  const active = () =>
    scope.presented()
      ? readers().flatMap((read) => {
          const fault = read();
          return fault ? [fault] : [];
        })
      : [];
  const recovery = () => {
    const values = active();
    const reloads = values.filter((fault) => fault.recovery === "reload" && fault.onRetry);
    return reloads.length ? reloads : values;
  };
  const busy = () => recovery().some((fault) => fault.retrying);
  const retryable = () => recovery().some((fault) => fault.onRetry && !fault.retryDisabled);
  const retry = (event: MouseEvent) => {
    if (busy() || !retryable()) {
      return;
    }
    // Resolve current callbacks at the click; retired scopes cannot retry old reads.
    const callbacks = new Set(
      recovery()
        .filter((fault) => !fault.retryDisabled && !fault.retrying)
        .map((fault) => fault.onRetry),
    );
    for (const callback of callbacks) {
      callback?.(event);
    }
  };
  const summary = () =>
    faults().length === 1
      ? t("chat.sessionDetails.feedbackUnavailable", { source: faults()[0]!.label })
      : t("chat.sessionDetails.feedbackMultiple");
  const id = createUniqueId();
  return (
    <FeedbackContext value={scope}>
      {props.children}
      <Show when={!parent && faults().length > 0}>
        <footer class="panel-feedback" aria-label={t("chat.sessionDetails.feedbackTitle")}>
          <Popover
            id={id}
            label={t("chat.sessionDetails.feedbackTitle")}
            placement="top-start"
            lazy="while-open"
            triggerClass="panel-feedback__trigger"
            trigger={
              <>
                <Icon name="alertTriangle" />
                <span role="status">{summary()}</span>
                <Icon name="chevronUp" />
              </>
            }
            class="panel-feedback__popover"
          >
            <div class="panel-feedback__messages">
              <For each={faults()}>
                {(fault) => (
                  <section>
                    <strong>{fault.label}</strong>
                    <p>{fault.message}</p>
                  </section>
                )}
              </For>
            </div>
          </Popover>
          <Show when={active().some((fault) => fault.onRetry)}>
            <button
              type="button"
              class="panel-feedback__retry"
              aria-disabled={busy() || !retryable() ? "true" : "false"}
              onClick={retry}
            >
              {t(
                recovery().some((fault) => fault.recovery === "reload")
                  ? "common.reload"
                  : "common.retry",
              )}
            </button>
          </Show>
        </footer>
      </Show>
    </FeedbackContext>
  );
}
