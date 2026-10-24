import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { JSX } from "@solidjs/web";
import { For, Loading, Show, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import type { SessionSystemPromptReport } from "../../../../../src/config/sessions/session-system-prompt-report.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { gatewayPresentationScope } from "../../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { isRetryableGatewayReadError } from "../../../lib/gateway-errors.ts";
import { createGatewayRetryOwner } from "../../../lib/gateway-retry.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import {
  areUiSessionKeysEquivalent,
  scopedSessionArtifactKey,
} from "../../../lib/sessions/session-key.ts";
import { requestSessionUsage, sessionUsageRetryState } from "../../../lib/sessions/usage.ts";
import { showToast } from "../../../lib/toast.ts";
import "../../../styles/chat/context-breakdown.css";
import {
  buildChatContextCategories,
  buildDeferredContextGroups,
  type ContextEntry,
  type ContextGroup,
  type ContextCategory,
} from "./chat-context-breakdown-model.ts";
import { createDetailsDesktopReveal } from "./chat-details-desktop-section.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

const labelKeys = {
  messages: "contextMessages",
  files: "contextFiles",
  tools: "contextTools",
  skills: "contextSkills",
  system: "contextSystem",
} as const;

const groupLabelKeys = {
  "agent-workspace": "contextAgentWorkspace",
  "execution-project": "contextProject",
  personal: "contextPersonal",
  other: "contextOtherFiles",
  openclaw: "contextSystemTools",
  mcp: "contextMcpTools",
  client: "contextClientTools",
  "unknown-tools": "contextTools",
} as const;

function ContextEntries(props: { entries: ContextEntry[] }) {
  return (
    <For each={props.entries} keyed={(entry) => entry.key}>
      {(entry) => (
        <div class="chat-context__entry">
          <span title={entry().path ?? entry().name}>
            <span>{entry().name}</span>
            <Show when={entry().path}>
              <small class="chat-context__path">{entry().path}</small>
            </Show>
          </span>
          <span>
            {entry().tokens === null
              ? t("chat.sessionDetails.contextUnverified")
              : "~" + formatCompactTokenCount(entry().tokens!)}
          </span>
        </div>
      )}
    </For>
  );
}

function ContextGroups(props: { groups: ContextGroup[] }) {
  return (
    <For each={props.groups} keyed={(group) => group.key}>
      {(group) => (
        <section class="chat-context__source" data-context-source={group().kind}>
          <div class="chat-context__source-heading">
            <span title={group().path}>
              {t("chat.sessionDetails." + groupLabelKeys[group().kind])}
              <Show when={group().name}> · {group().name}</Show>
            </span>
            <small>
              {group().entries.length} ·{" "}
              {group().tokens === null ? "—" : "~" + formatCompactTokenCount(group().tokens!)}
            </small>
          </div>
          <ContextEntries entries={group().entries} />
        </section>
      )}
    </For>
  );
}

function ContextRow(props: { category: ContextCategory; limit: number; desktop?: boolean }) {
  const tokens = () => props.category.tokens;
  const value = () => (tokens() === null ? "—" : "~" + formatCompactTokenCount(tokens()!));
  const percent = () =>
    tokens() === null ? "—" : "~" + ((tokens()! / props.limit) * 100).toFixed(1) + "%";
  const label = () => t("chat.sessionDetails." + labelKeys[props.category.id]);
  const content = () => (
    <>
      <span
        class={["chat-context__swatch", `chat-context__${props.category.id}`]}
        aria-hidden="true"
      />
      <span class="chat-context__label">
        <span>{label()}</span>
        <Show when={props.category.entries.length > 0}>
          <small>{props.category.entries.length}</small>
        </Show>
      </span>
      <span class="chat-context__tokens">{value()}</span>
      <span class="chat-context__percent">{percent()}</span>
    </>
  );
  const entries = () => (
    <div class="chat-context__entries">
      <Show
        when={props.category.groups}
        fallback={<ContextEntries entries={props.category.entries} />}
      >
        {(groups) => <ContextGroups groups={groups()} />}
      </Show>
    </div>
  );
  return (
    <Show
      when={props.category.entries.length > 0}
      fallback={
        <div class="chat-context__row" data-context-category={props.category.id}>
          {content()}
        </div>
      }
    >
      <Show
        when={props.desktop}
        fallback={
          <details class="chat-context__details" data-context-details={props.category.id}>
            <summary class="chat-context__row" data-context-category={props.category.id}>
              {content()}
              <Icon name="chevronDown" />
            </summary>
            {entries()}
          </details>
        }
      >
        <DesktopContextDisclosure category={props.category.id} heading={content()}>
          {entries()}
        </DesktopContextDisclosure>
      </Show>
    </Show>
  );
}

/** Same category rows and entries, with desktop-only disclosure motion. */
function DesktopContextDisclosure(props: {
  category: ContextCategory["id"];
  heading: JSX.Element;
  children: JSX.Element;
}) {
  const [expanded, setExpanded] = createSignal(false);
  // The Context content owner mounts this only while its page/section is presented.
  const reveal = createDetailsDesktopReveal(() => [expanded(), true]);
  return (
    <details
      ref={reveal.details}
      class="chat-context__details"
      data-context-details={props.category}
    >
      <summary
        class="chat-context__row"
        data-context-category={props.category}
        aria-expanded={expanded() ? "true" : "false"}
        onClick={(event) => {
          event.preventDefault();
          reveal.prepareClick(event);
          setExpanded(!expanded());
        }}
      >
        {props.heading}
        <Icon name="chevronDown" />
      </summary>
      <div
        ref={reveal.body}
        class="chat-details-desktop-section__body"
        inert={!expanded()}
        aria-hidden={expanded() ? "false" : "true"}
      >
        <div ref={reveal.content}>{props.children}</div>
      </div>
    </details>
  );
}

export function ChatContextBreakdown(props: {
  gateway: ApplicationGateway;
  session: GatewaySessionRow;
  agentId?: string;
  used: number;
  limit: number;
  approximate?: boolean;
  desktop?: boolean;
}) {
  const gateway = createMemo(() => projectGateway(props.gateway));
  const [revision, setRevision] = createSignal(0);
  const documentVisible = () => document.visibilityState !== "hidden";
  const target = createMemo(
    () => {
      const connection = gateway().read();
      return {
        client: connection.snapshot.phase === "connected" ? connection.snapshot.client : null,
        connectionRevision: connection.connectionRevision,
        presentationScope: gatewayPresentationScope(props.gateway).key,
        key: scopedSessionArtifactKey(props.session.key, props.agentId),
        sessionId: props.session.sessionId,
        model: props.session.activeModel || props.session.model,
        provider: props.session.modelProvider,
      };
    },
    {
      equals: (a, b) =>
        a.client === b.client &&
        a.connectionRevision === b.connectionRevision &&
        a.presentationScope === b.presentationScope &&
        a.key === b.key &&
        a.sessionId === b.sessionId &&
        a.model === b.model &&
        a.provider === b.provider,
    },
  );
  const recovery = createMemo(() => {
    const current = target();
    const saved = sessionUsageRetryState(
      current.client,
      JSON.stringify([current.connectionRevision, current.presentationScope]),
      JSON.stringify([current.key, current.sessionId, current.model, current.provider]),
    );
    const retry = createGatewayRetryOwner();
    const receipt = saved.read();
    retry.restore(receipt, () => setRevision((value) => value + 1));
    if (!documentVisible()) {
      retry.pause();
    }
    onCleanup(retry.cancel);
    return {
      retry,
      saved,
      skipped: false,
      report: null as SessionSystemPromptReport | null,
    };
  });
  onSettled(() =>
    listen(document, "visibilitychange", () => {
      const current = recovery();
      if (!documentVisible()) {
        current.retry.pause();
      } else if (current.skipped) {
        current.skipped = false;
        setRevision((value) => value + 1);
      } else {
        current.retry.resume();
      }
    }),
  );
  let manualRefresh: ReturnType<typeof target> | undefined;
  const requestState = createMemo(
    () => ({
      target: target(),
      used: props.used,
      revision: revision(),
      recovering: recovery().retry.hasPending(),
    }),
    {
      // Automatic usage updates share the pending deadline; manual refresh and
      // the deadline itself advance revision and admit the next read.
      equals: (before, after) =>
        before.target === after.target &&
        before.revision === after.revision &&
        (before.used === after.used || after.recovering),
    },
  );
  const result = createMemo(async (): Promise<{ report: SessionSystemPromptReport | null }> => {
    const current = requestState().target;
    const pending = recovery();
    const userRequested = manualRefresh === current;
    manualRefresh = undefined;
    const newerRetry = pending.saved.read();
    if (
      !userRequested &&
      newerRetry &&
      newerRetry.deadline > Date.now() &&
      (pending.retry.snapshot()?.deadline ?? 0) < newerRetry.deadline
    ) {
      pending.retry.restore(newerRetry, () => setRevision((value) => value + 1));
      if (!documentVisible()) {pending.retry.pause();}
    }
    if (!userRequested && pending.retry.hasPending()) {
      return { report: pending.report };
    }
    const observedRetry = pending.saved.read();
    pending.retry.cancel();
    pending.skipped = false;
    if (!current.client || !documentVisible()) {
      pending.skipped = current.client !== null;
      if (userRequested && !current.client) {
        showToast({ message: t("chat.sessionDetails.contextOffline"), severity: "error" });
      }
      return { report: pending.report };
    }
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    try {
      // Context reports are independent of the usage date range. Keep this
      // existing single-session read bounded to today's usage, not its history.
      const today = new Date().toISOString().slice(0, 10);
      const response = await requestSessionUsage(
        current.client,
        {
          startDate: today,
          endDate: today,
          timeZone: "utc",
          scope: "instance",
          agentId: props.agentId,
        },
        { key: current.key, includeContextWeight: true, signal: controller.signal },
      );
      if (controller.signal.aborted) {
        return { report: null };
      }
      pending.retry.reset();
      pending.saved.clear(observedRetry);
      const row = response.sessions.find((entry) =>
        areUiSessionKeysEquivalent(entry.key, current.key),
      );
      const report = row?.contextWeight;
      if (
        !report ||
        (current.sessionId &&
          (row?.sessionId !== current.sessionId ||
            (report.sessionId && report.sessionId !== current.sessionId))) ||
        (report.model && current.model && report.model !== current.model) ||
        (report.provider && current.provider && report.provider !== current.provider)
      ) {
        pending.report = null;
        return { report: null };
      }
      pending.report = report;
      return { report };
    } catch (error) {
      if (controller.signal.aborted) {
        return { report: null };
      }
      if (userRequested) {
        showToast({ message: t("chat.sessionDetails.contextError"), severity: "error" });
      }
      if (isRetryableGatewayReadError(error, "sessions.usage")) {
        pending.retry.schedule(
          () => {
            if (!controller.signal.aborted && documentVisible()) {
              setRevision((value) => value + 1);
            }
          },
          error instanceof GatewayProtocolRequestError ? error.retryAfterMs : undefined,
        );
        pending.saved.remember(pending.retry.snapshot());
        if (!documentVisible()) {
          pending.retry.pause();
        }
      } else {
        pending.retry.reset();
        pending.saved.clear(observedRetry);
        pending.report = null;
      }
      return { report: pending.report };
    }
  });
  return (
    <div class="chat-context">
      <Loading on={target()}>
        <Show when={result().report}>
          {(report) => {
            const categories = createMemo(() => buildChatContextCategories(report(), props.used));
            const deferred = createMemo(() => buildDeferredContextGroups(report()));
            return (
              <>
                <div class="chat-context__bar" aria-hidden="true">
                  <For each={categories()} keyed={(category) => category.id}>
                    {(category) => (
                      <span
                        class={["chat-context__segment", `chat-context__${category().id}`]}
                        style={{
                          width:
                            Math.min(100, ((category().tokens ?? 0) / props.limit) * 100) + "%",
                        }}
                      />
                    )}
                  </For>
                </div>
                <div class="chat-context__legend">
                  <For each={categories()} keyed={(category) => category.id}>
                    {(category) => (
                      <ContextRow
                        category={category()}
                        limit={props.limit}
                        desktop={props.desktop}
                      />
                    )}
                  </For>
                  <div class="chat-context__row" data-context-category="free">
                    <span class="chat-context__swatch chat-context__free" aria-hidden="true" />
                    <span class="chat-context__label">{t("chat.sessionDetails.contextFree")}</span>
                    <span class="chat-context__tokens">
                      {props.approximate ? "~" : ""}
                      {formatCompactTokenCount(Math.max(0, props.limit - props.used))}
                    </span>
                    <span class="chat-context__percent">
                      {props.approximate ? "~" : ""}
                      {((Math.max(0, props.limit - props.used) / props.limit) * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
                <Show when={deferred().length > 0}>
                  <details
                    class="chat-context__details chat-context__deferred"
                    data-context-details="deferred"
                  >
                    <summary class="chat-context__source-heading">
                      <span>{t("chat.sessionDetails.contextAvailableOnDemand")}</span>
                      <Icon name="chevronDown" />
                    </summary>
                    <div class="chat-context__entries">
                      <ContextGroups groups={deferred()} />
                    </div>
                  </details>
                </Show>
              </>
            );
          }}
        </Show>
        <button
          type="button"
          class="chat-context__refresh"
          onClick={() => {
            manualRefresh = target();
            setRevision((value) => value + 1);
          }}
        >
          <Icon name="refresh" />
          {t("common.refresh")}
        </button>
      </Loading>
    </div>
  );
}
