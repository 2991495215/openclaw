import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type {
  ChatMobilePeople,
  ChatMobilePeopleMention,
  ChatMobilePerson,
} from "../chat-mobile-people.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar-view.tsx";
import "../../../styles/chat/mobile-people.css";

registerEnglishCatalog(registerChatSessionEnglish);

export type ChatMobilePeopleBodyProps = {
  people: ChatMobilePeople;
  viewingNow: string;
  /** Parent-owned ChatSessionSharingOptions, including its permission gates. */
  sharingOptions: JSX.Element;
  /** Insert a typed recipient, close People and focus the composer; never send. */
  onMention?: (person: ChatMobilePeopleMention) => void;
};

function PersonName(props: { person: ChatMobilePerson }) {
  return (
    <span
      ref={createTextOverflow(() => props.person.firstName)}
      class="chat-mobile-people__name"
      aria-label={props.person.label}
      title={props.person.label}
    >
      {props.person.firstName}
    </span>
  );
}

function PeopleSection(props: {
  title: string;
  people: readonly ChatMobilePerson[];
  showCount?: boolean;
  partial?: boolean;
  onMention?: ChatMobilePeopleBodyProps["onMention"];
}) {
  return (
    <section class="chat-mobile-people__section" aria-label={props.title}>
      <h3>
        {props.title}
        <Show when={props.showCount && !props.partial}>
          <span>{props.people.length}</span>
        </Show>
      </h3>
      <ul class="chat-mobile-people__list">
        <For each={props.people} keyed={(person) => person.key}>
          {(person) => (
            <li class="chat-mobile-people__row">
              <ChatAuthorAvatar sender={person().sender} hideTooltip />
              <PersonName person={person()} />
              <Show when={props.onMention && person().mention}>
                {(mention) => (
                  <button
                    type="button"
                    class="chat-mobile-people__mention"
                    aria-label={t("chat.sessionHeader.mentionPerson", { name: person().label })}
                    onClick={() => props.onMention?.(mention())}
                  >
                    <span aria-hidden="true">@</span>
                    <span>{t("chat.sessionHeader.mention")}</span>
                    <Icon name="chevronRight" />
                  </button>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/** Body only: The mobile host owns route, expansion, scroll, close and focus restoration. */
export function ChatMobilePeopleBody(props: ChatMobilePeopleBodyProps) {
  return (
    <div class="chat-mobile-people" role="group" aria-label={t("chat.sessionHeader.people")}>
      <Show when={props.people.viewers.length > 0}>
        <section class="chat-mobile-people__section" aria-label={props.viewingNow}>
          <h3>{props.viewingNow}</h3>
          <ul class="chat-mobile-people__viewers">
            <For each={props.people.viewers} keyed={(person) => person.key}>
              {(person) => (
                <li>
                  <Show
                    when={props.onMention && person().mention}
                    fallback={
                      <div class="chat-mobile-people__viewer">
                        <ChatAuthorAvatar sender={person().sender} hideTooltip />
                        <PersonName person={person()} />
                      </div>
                    }
                  >
                    {(mention) => (
                      <button
                        type="button"
                        class="chat-mobile-people__viewer"
                        aria-label={t("chat.sessionHeader.mentionPerson", { name: person().label })}
                        onClick={() => props.onMention?.(mention())}
                      >
                        <ChatAuthorAvatar sender={person().sender} hideTooltip />
                        <PersonName person={person()} />
                      </button>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      {props.sharingOptions}
      <Show when={props.people.creator}>
        {(creator) => (
          <PeopleSection
            title={t("chat.sessionSharing.creator")}
            people={[creator()]}
            onMention={props.onMention}
          />
        )}
      </Show>
      <Show when={props.people.owner}>
        {(owner) => (
          <PeopleSection
            title={t("chat.sessionSharing.owner")}
            people={[owner()]}
            onMention={props.onMention}
          />
        )}
      </Show>
      <Show when={props.people.participants.length > 0}>
        <PeopleSection
          title={t("chat.sessionHeader.peopleParticipants")}
          people={props.people.participants}
          showCount
          partial={!props.people.participantsComplete}
          onMention={props.onMention}
        />
      </Show>
      <Show when={props.people.unlistedParticipantCount > 0}>
        <p class="chat-mobile-people__unlisted">
          {t("chat.sessionHeader.morePeople", {
            count: String(props.people.unlistedParticipantCount),
          })}
        </p>
      </Show>
    </div>
  );
}
