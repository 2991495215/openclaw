import type { JSX } from "@solidjs/web";
import { For, Loading, Show, children } from "solid-js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import type { CronCompactJob } from "../../../api/types.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ChatSubagentActivity } from "../chat-subagent-wait.ts";
import { ChatDetailsSubagents, type ChatDetailsSubagentsProps } from "./chat-details-subagents.tsx";
import {
  ChatPullRequestMobileRow,
  ChatPullRequestMobileRecovery,
  type ChatPullRequestMobileCollectionProps,
} from "./chat-pull-request-mobile.tsx";
import { chatPullRequestId } from "./chat-pull-requests.ts";
import "../../../styles/chat/details-mobile-root.css";

registerEnglishCatalog(registerChatDetailsEnglish);
registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerGitHubEnglish);

/** Presentation supplied by the domain owner; marks/metadata are noninteractive. */
export type ChatDetailsMobileEntry = {
  label: string;
  description?: string;
  descriptionLeading?: JSX.Element;
  /** Note-only progress is the one root summary that uses ellipsis. */
  truncateDescription?: boolean;
  accessibleLabel?: string;
  leading?: JSX.Element;
  metadata?: JSX.Element;
};

type ChatDetailsMobileItem<T> = ChatDetailsMobileEntry & { value: T };

type ChatDetailsMobileCollection<T> = {
  /** Native order, including settled items; never a second roster or query. */
  items: readonly ChatDetailsMobileItem<T>[];
  /** Authoritative total, including pages not loaded. Undefined means unknown. */
  total?: number;
  summary: ChatDetailsMobileEntry;
  /** Owner-rendered loading/error/retry; retained rows remain available. */
  notice?: JSX.Element;
};

type ChatDetailsMobileRootDestination =
  | { kind: "people" }
  | { kind: "task-progress" }
  | { kind: "subagents" }
  | { kind: "subagent"; sessionKey: ChatSubagentActivity["key"] }
  | { kind: "pull-requests" }
  | { kind: "pull-request"; pullRequest: ControlUiSessionPullRequest }
  | { kind: "publication" }
  | { kind: "automations" }
  | { kind: "automation"; jobId: CronCompactJob["id"] }
  | { kind: "outputs" }
  | { kind: "versions" };

type ChatDetailsMobileRootOrigin = {
  kind: "details-root";
  trigger: HTMLButtonElement;
};

export type ChatDetailsMobileRootProps = {
  /** The mobile host owns hidden/inert, mounting, scroll, focus and navigation retention. */
  presented: boolean;
  people?: ChatDetailsMobileEntry;
  /** The native Sharing control, including its value, glyph and action. */
  sharingOptions?: JSX.Element;
  /** The progress owner supplies current position, not the completed-step count from the pill. */
  taskProgress?: ChatDetailsMobileEntry;
  taskProgressNotice?: JSX.Element;
  subagents?: Omit<ChatDetailsSubagentsProps, "mobile" | "collapsed">;
  /** Mobile content without another section heading or scroll container. */
  processes?: JSX.Element;
  /** The complete mobile Environment section, including its own heading and group. */
  environment?: JSX.Element;
  pullRequests?: ChatPullRequestMobileCollectionProps & { summary: ChatDetailsMobileEntry };
  /** Native publication/recovery can exist without any attached PR. */
  publication?: JSX.Element;
  /** The publication entry presentation; opening review is navigation, never publication. */
  publicationEntry?: ChatDetailsMobileEntry;
  automations?: ChatDetailsMobileCollection<CronCompactJob["id"]>;
  outputs?: ChatDetailsMobileEntry;
  /** Supply even for one version; omission is not a greater-than-one policy. */
  versions?: ChatDetailsMobileEntry;
  onNavigate: (
    destination: ChatDetailsMobileRootDestination,
    origin: ChatDetailsMobileRootOrigin,
  ) => void;
};

function RootGroup(props: {
  label: string;
  name: string;
  heading?: boolean;
  children: JSX.Element;
}) {
  return (
    <section
      class="chat-details-mobile-root__section"
      data-details-group={props.name}
      aria-label={props.label}
    >
      <Show when={props.heading !== false}>
        <h3 class="chat-details-mobile-root__heading">{props.label}</h3>
      </Show>
      <div class="chat-details-mobile-root__group">{props.children}</div>
    </section>
  );
}

/** Mobile root only. Domain owners supply facts; the mobile host records every transition. */
export function ChatDetailsMobileRoot(props: ChatDetailsMobileRootProps) {
  function RootEntry(entryProps: {
    entry: ChatDetailsMobileEntry;
    icon?: IconName;
    destination: ChatDetailsMobileRootDestination;
  }) {
    return (
      <button
        type="button"
        class="chat-details-mobile-root__entry"
        data-details-destination={entryProps.destination.kind}
        aria-label={entryProps.entry.accessibleLabel}
        disabled={!props.presented}
        onClick={(event) => {
          if (props.presented) {
            props.onNavigate(entryProps.destination, {
              kind: "details-root",
              trigger: event.currentTarget,
            });
          }
        }}
      >
        <Show when={entryProps.entry.leading != null || entryProps.icon}>
          <span class="chat-details-mobile-root__leading" aria-hidden="true">
            {entryProps.entry.leading ?? (entryProps.icon && <Icon name={entryProps.icon} />)}
          </span>
        </Show>
        <span class="chat-details-mobile-root__copy">
          <span
            ref={createTextOverflow(() => entryProps.entry.label)}
            class="chat-details-mobile-root__label"
          >
            {entryProps.entry.label}
          </span>
          <Show when={entryProps.entry.description}>
            <span class="chat-details-mobile-root__description">
              {entryProps.entry.descriptionLeading}
              <span
                class={[
                  "chat-details-mobile-root__description-text",
                  {
                    "chat-details-mobile-root__description-text--note":
                      entryProps.entry.truncateDescription,
                  },
                ]}
              >
                {entryProps.entry.description}
              </span>
            </span>
          </Show>
        </span>
        <Show when={entryProps.entry.metadata != null}>
          <span class="chat-details-mobile-root__metadata">{entryProps.entry.metadata}</span>
        </Show>
        <Icon name="chevronRight" class="chat-details-mobile-root__chevron" />
      </button>
    );
  }

  const pullRequestsTotal = () => props.pullRequests?.pullRequests.length ?? 0;
  const automationsTotal = () => props.automations?.total ?? props.automations?.items.length ?? 0;
  const automationNotice = children(() => props.automations?.notice);

  return (
    <div class="chat-details-mobile-root">
      <Show when={props.people || props.sharingOptions}>
        <RootGroup name="people" label={t("chat.mobileDetails.people")} heading={false}>
          <Show when={props.people}>
            {(entry) => <RootEntry entry={entry()} icon="users" destination={{ kind: "people" }} />}
          </Show>
          {props.sharingOptions}
        </RootGroup>
      </Show>
      <Show when={props.taskProgress || props.taskProgressNotice}>
        <RootGroup name="task-progress" label={t("sessionProgressCard.composerTitle")}>
          <Show when={props.taskProgress}>
            {(entry) => <RootEntry entry={entry()} destination={{ kind: "task-progress" }} />}
          </Show>
          {props.taskProgressNotice}
        </RootGroup>
      </Show>
      <Show when={props.subagents && props.subagents.rows.length > 0 && props.subagents}>
        {(subagents) => (
          <section
            class="chat-details-mobile-root__section"
            data-details-group="subagents"
            aria-label={t("chat.sessionDetails.subagents")}
          >
            <h3 class="chat-details-mobile-root__heading">{t("chat.sessionDetails.subagents")}</h3>
            <ChatDetailsSubagents {...subagents()} mobile />
          </section>
        )}
      </Show>
      {props.environment}
      <Show
        when={
          pullRequestsTotal() > 0 ||
          (props.pullRequests && props.pullRequests.status !== "ready") ||
          props.publication ||
          props.publicationEntry
        }
      >
        <RootGroup name="pull-requests" label={t("sessionHovercard.pullRequests")}>
          <Show when={props.pullRequests}>
            {(collection) => (
              <>
                <For
                  each={collection().pullRequests.slice(0, pullRequestsTotal() > 3 ? 2 : 3)}
                  keyed={chatPullRequestId}
                >
                  {(pullRequest) => (
                    <ChatPullRequestMobileRow
                      pullRequest={pullRequest()}
                      onOpen={collection().onOpen}
                    />
                  )}
                </For>
                <Show when={pullRequestsTotal() > 3}>
                  <RootEntry
                    entry={collection().summary}
                    icon="gitPullRequest"
                    destination={{ kind: "pull-requests" }}
                  />
                </Show>
                <ChatPullRequestMobileRecovery {...collection()} collection />
              </>
            )}
          </Show>
          {props.publication}
          <Show when={props.publicationEntry}>
            {(entry) => (
              <RootEntry
                entry={entry()}
                icon="gitPullRequest"
                destination={{ kind: "publication" }}
              />
            )}
          </Show>
        </RootGroup>
      </Show>
      <Loading>
        <Show when={automationsTotal() > 0 || automationNotice.toArray().length > 0}>
          <RootGroup name="automations" label={t("chat.sessionDetails.automations")}>
            <Show when={props.automations}>
              {(collection) => (
                <>
                  <Show
                    when={automationsTotal() > 1}
                    fallback={
                      <For each={collection().items} keyed={(entry) => entry.value}>
                        {(entry) => (
                          <RootEntry
                            entry={entry()}
                            icon="clock"
                            destination={{ kind: "automation", jobId: entry().value }}
                          />
                        )}
                      </For>
                    }
                  >
                    <Show when={automationsTotal() > 0}>
                      <RootEntry
                        entry={collection().summary}
                        icon="clock"
                        destination={{ kind: "automations" }}
                      />
                    </Show>
                  </Show>
                  {automationNotice()}
                </>
              )}
            </Show>
          </RootGroup>
        </Show>
      </Loading>
      <Show when={props.outputs}>
        {(entry) => (
          <RootGroup name="outputs" label={t("chat.mobileDetails.generatedFiles")}>
            <RootEntry entry={entry()} icon="fileText" destination={{ kind: "outputs" }} />
          </RootGroup>
        )}
      </Show>
      <Show when={props.versions && props.versions.metadata !== 0 && props.versions}>
        {(entry) => (
          <RootGroup name="session" label={t("chat.sessionDetails.session")}>
            <RootEntry entry={entry()} icon="history" destination={{ kind: "versions" }} />
          </RootGroup>
        )}
      </Show>
      <Show when={props.processes}>
        <RootGroup name="processes" label={t("chat.sessionDetails.processes")}>
          {props.processes}
        </RootGroup>
      </Show>
    </div>
  );
}
