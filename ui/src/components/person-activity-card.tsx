import { render, spread } from "@solidjs/web";
import { createMemo, createSignal, Errored, lazy, Loading, runWithOwner, Show } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import { registerChatComposerEnglish } from "../i18n/locales/en-chat-composer.ts";
import { presenceUserLabel, type PresenceViewer } from "../lib/presence-users.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createResizeObserver } from "../lib/reactive/observers.ts";
import type { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import type { PersonActivityData } from "./person-activity-data.ts";
import type { PersonActivityRouting } from "./person-activity-link.ts";
import { controlsForHovercard, HovercardControlsContext } from "./portaled-hovercard-focus.ts";

registerEnglishCatalog(registerChatComposerEnglish);

const PersonActivityCard = lazy(() => import("./person-activity-card-view.tsx"), {
  export: "PersonActivityCard",
});

export type PersonCardInput = {
  user: PresenceViewer;
  ariaName?: string;
  sessionData: PersonActivityData | undefined;
  watchAgentId: string;
  mainKey: string;
  globalScope: boolean;
  routing: PersonActivityRouting;
  openSession: (
    row: GatewaySessionRow,
    agentId: string,
    options: ReturnType<typeof sessionNavigationTarget>["options"],
  ) => void;
};

type CardStatus = { status: "loading" | "unavailable"; name: string };
type ResolvedCard = PersonCardInput | CardStatus;
type CardValue = ResolvedCard | { name: string; read: Promise<ResolvedCard> };

function cardName(input: CardValue) {
  return "user" in input
    ? (input.ariaName ?? presenceUserLabel(input.user, t("presence.card.person")).name)
    : input.name;
}

const cards = new WeakMap<
  HTMLElement,
  { update: (value: CardValue) => void; dispose: () => void }
>();

/** The portal owns one Solid root and retires its retained selection when closed. */
export function updatePersonActivityCard(
  container: HTMLElement,
  input?: CardValue,
  onPosition?: () => void,
) {
  const existing = cards.get(container);
  if (input === undefined) {
    existing?.dispose();
  } else if (existing) {
    existing.update(input);
  } else {
    let update!: (value: CardValue) => void;
    // The portal outlives the caller’s transient render scope.
    const dispose = runWithOwner(null, () =>
      render(() => {
        function PersonCardContents(props: { input: ResolvedCard }) {
          spread(
            container,
            () => ({ "aria-label": t("presence.card.ariaLabel", { name: cardName(props.input) }) }),
            true,
          );
          return (
            <Show
              when={"status" in props.input ? undefined : props.input}
              fallback={
                <div class="person-reference__status" role="status">
                  {"status" in props.input
                    ? t(
                        props.input.status === "loading"
                          ? "common.loading"
                          : "chat.mentions.unavailable",
                      )
                    : ""}
                </div>
              }
            >
              {(current) => <PersonActivityCard input={current()} />}
            </Show>
          );
        }
        const [value, setValue] = createSignal<CardValue>(input, { ownedWrite: true });
        const read = createMemo(() => {
          const current = value();
          return "read" in current ? current.read : current;
        });
        update = setValue;
        if (onPosition) {
          // Translated text can resize the retained card without another owner update.
          createResizeObserver(() => [container], onPosition);
        }
        return (
          <HovercardControlsContext value={controlsForHovercard(container)}>
            <Errored
              fallback={
                <PersonCardContents input={{ status: "unavailable", name: cardName(value()) }} />
              }
            >
              <Loading
                fallback={
                  <PersonCardContents input={{ status: "loading", name: cardName(value()) }} />
                }
              >
                <PersonCardContents input={read()} />
              </Loading>
            </Errored>
          </HovercardControlsContext>
        );
      }, container),
    );
    cards.set(container, {
      update,
      dispose: () => {
        cards.delete(container);
        dispose();
      },
    });
  }
}
