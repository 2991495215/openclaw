import type { JSX } from "@solidjs/web";
import { For, Show, createSignal } from "solid-js";
import type { SessionGoal } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import type { ChatGoalAction, ChatGoalRecovery } from "../../../lib/chat/chat-types.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createInterval } from "../../../lib/reactive/timers.ts";
import {
  formatGoalDetail,
  formatGoalElapsed,
  formatGoalStatusLabel,
  formatGoalUsage,
  goalElapsedMs,
} from "../../../lib/session-goal.ts";

registerEnglishCatalog(registerChatGoalsEnglish);

export function GoalIcon() {
  return (
    <StrokeIcon aria-hidden="true">
      <path d="M12 13V2l8 4-8 4" />
      <path d="M20.561 10.222a9 9 0 1 1-12.55-5.29" />
      <path d="M8.002 9.997a5 5 0 1 0 8.9 2.02" />
    </StrokeIcon>
  );
}

const goalStatusIcons = {
  paused: "pause",
  blocked: "alertTriangle",
  usage_limited: "alertTriangle",
  budget_limited: "alertTriangle",
  complete: "check",
} as const;

// Keep the one-second clock local to its span; it must not invalidate the composer.
function GoalElapsed(props: { goal: SessionGoal; class?: string }) {
  // Resuming samples the current clock before the next interval tick.
  const [now, setNow] = createSignal(() => (props.goal.status === "active" ? Date.now() : 0));
  createInterval(
    () => setNow(Date.now()),
    () => (props.goal.status === "active" ? 1000 : undefined),
  );
  return <span class={props.class}>{formatGoalElapsed(goalElapsedMs(props.goal, now()))}</span>;
}

type ChatGoalProps = {
  goal?: SessionGoal;
  expanded: boolean;
  canAct: boolean;
  recovery?: ChatGoalRecovery;
  connected?: boolean;
  onGoalAction?: (goalId: string, action: ChatGoalAction) => void;
  onGoalEdit?: (goal: SessionGoal) => void;
  onExpandedChange: (expanded: boolean) => void;
};

const goalActions = ["edit", "pause", "resume", "clear"] as const;
const goalActionIcons = {
  edit: "penLine",
  pause: "pause",
  resume: "play",
  clear: "trash",
} as const;

type GoalPresentationProps = Pick<
  ChatGoalProps,
  "canAct" | "recovery" | "connected" | "onGoalAction" | "onGoalEdit"
> & { goal: SessionGoal };

/** Shared eligibility and callbacks; the parent supplies native write availability. */
export function ChatGoalActions(props: GoalPresentationProps) {
  const visibleAction = (action: (typeof goalActions)[number]) =>
    !props.recovery &&
    props.canAct &&
    Boolean(props.onGoalAction) &&
    (action === "edit"
      ? Boolean(props.onGoalEdit) && props.goal.status !== "complete"
      : action === "pause"
        ? props.goal.status === "active"
        : action === "resume"
          ? props.goal.status !== "active"
          : true);
  return (
    <span class="agent-chat__goal-command-actions">
      <For each={goalActions}>
        {(action) => (
          <>
            {visibleAction(action) ? (
              <openclaw-tooltip content={t(`chat.goals.${action}`)}>
                <button
                  class={["agent-chat__goal-action", `agent-chat__goal-${action}`]}
                  type="button"
                  aria-label={t(`chat.goals.${action}`)}
                  onClick={() => {
                    if (action === "edit") {
                      props.onGoalEdit?.(props.goal);
                    } else {
                      props.onGoalAction?.(props.goal.id, action);
                    }
                  }}
                >
                  <Icon name={goalActionIcons[action]} />
                  <span class="agent-chat__goal-action-label">{t(`chat.goals.${action}Chip`)}</span>
                </button>
              </openclaw-tooltip>
            ) : null}
          </>
        )}
      </For>
    </span>
  );
}

export function ChatGoalBody(props: {
  goal: SessionGoal;
  recovery?: ChatGoalRecovery;
  objectiveRef?: (element: HTMLDivElement) => void;
}) {
  return (
    <>
      <div
        class="agent-chat__goal-detail-objective"
        ref={props.objectiveRef}
        textContent={props.goal.objective}
      />
      {props.goal.lastStatusNote && !props.recovery ? (
        <div class="agent-chat__goal-detail-note">{props.goal.lastStatusNote}</div>
      ) : null}
    </>
  );
}

export function ChatGoalMetrics(props: { goal: SessionGoal; live?: boolean }) {
  return (
    <div class="agent-chat__goal-detail-meta">
      {formatGoalUsage(props.goal) ? (
        <>
          <span class="agent-chat__goal-detail-usage">{formatGoalUsage(props.goal)}</span>
          <span class="agent-chat__goal-detail-separator" aria-hidden="true">
            ·
          </span>
        </>
      ) : null}
      <span class="agent-chat__goal-detail-duration">
        <Show when={props.live} fallback={formatGoalElapsed(goalElapsedMs(props.goal, Date.now()))}>
          <GoalElapsed goal={props.goal} />
        </Show>
      </span>
    </div>
  );
}

function GoalCard(props: Omit<ChatGoalProps, "goal"> & { goal: SessionGoal }) {
  const canResume = () => props.goal.status !== "active";
  const pauseReason = () =>
    canResume() && !props.expanded && !props.recovery ? props.goal.lastStatusNote : undefined;
  const statusLabel = () =>
    props.recovery
      ? t(props.recovery.pending ? "chat.goals.checking" : "chat.goals.recoveryTitle")
      : formatGoalStatusLabel(props.goal.status);
  return (
    <div
      class={[
        "agent-chat__goal",
        `agent-chat__goal--${props.recovery ? "resuming" : props.goal.status}`,
      ]}
      data-expanded={String(props.expanded)}
      role="group"
      aria-label={
        props.recovery ? `${statusLabel()}: ${props.goal.objective}` : formatGoalDetail(props.goal)
      }
      aria-busy={props.recovery?.pending ? "true" : "false"}
    >
      <div class="agent-chat__goal-row">
        <span class="agent-chat__goal-icon" aria-hidden="true">
          {props.recovery?.pending ? (
            <span class="session-run-spinner" />
          ) : props.recovery ? (
            <Icon name="alertTriangle" />
          ) : props.goal.status === "active" ? (
            <GoalIcon />
          ) : (
            <Icon name={goalStatusIcons[props.goal.status]} />
          )}
        </span>
        <span class="agent-chat__goal-copy">
          <openclaw-tooltip prop:content={pauseReason() ?? ""} disabled={!pauseReason()}>
            <span
              class="agent-chat__goal-label"
              role="status"
              tabindex={pauseReason() ? "0" : undefined}
            >
              {statusLabel()}
            </span>
          </openclaw-tooltip>
          <span class="agent-chat__goal-objective">{props.goal.objective}</span>
        </span>
        <GoalElapsed goal={props.goal} class="agent-chat__goal-elapsed" />
        <span class="agent-chat__goal-actions">
          <ChatGoalActions
            goal={props.goal}
            canAct={props.canAct}
            recovery={props.recovery}
            connected={props.connected}
            onGoalAction={props.onGoalAction}
            onGoalEdit={props.onGoalEdit}
          />
          <button
            class="agent-chat__goal-action agent-chat__goal-expand"
            type="button"
            aria-expanded={props.expanded ? "true" : "false"}
            aria-label={t(props.expanded ? "chat.goals.hideDetails" : "chat.goals.showDetails")}
            onClick={() => props.onExpandedChange(!props.expanded)}
          >
            <Icon name={props.expanded ? "chevronDown" : "chevronRight"} />
          </button>
        </span>
      </div>
      <div
        class="agent-chat__goal-detail"
        data-expanded={String(props.expanded)}
        aria-hidden={props.expanded ? "false" : "true"}
        inert={!props.expanded}
      >
        <div class="agent-chat__goal-detail-content">
          <ChatGoalBody
            goal={props.goal}
            recovery={props.recovery}
            objectiveRef={useScrollState(false, true, { revision: () => props.goal.objective })}
          />
          <Show when={props.recovery}>
            <div class="agent-chat__goal-recovery-detail">
              <ChatGoalRecoveryMessage recovery={props.recovery!} />
              <ChatGoalRecoveryAction
                recovery={props.recovery!}
                connected={Boolean(props.connected)}
              />
            </div>
          </Show>
          <ChatGoalMetrics goal={props.goal} />
        </div>
      </div>
    </div>
  );
}

export function ChatGoal(props: ChatGoalProps) {
  return (
    <Show when={props.goal !== undefined}>
      <GoalCard
        goal={props.goal!}
        expanded={props.expanded}
        canAct={props.canAct}
        recovery={props.recovery}
        connected={props.connected}
        onGoalAction={props.onGoalAction}
        onGoalEdit={props.onGoalEdit}
        onExpandedChange={props.onExpandedChange}
      />
    </Show>
  );
}

export function renderChatGoalRecoverySolid(
  recovery: ChatGoalRecovery | undefined,
  connected: boolean,
): JSX.Element {
  if (!recovery) {
    return null;
  }
  return (
    <div class="chat-composer-neighbor-card chat-composer-neighbor-card--warn" role="status">
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
        <Icon name="alertTriangle" />
      </span>
      <div class="chat-composer-neighbor-card__copy">
        <strong>{t(recovery.pending ? "chat.goals.checking" : "chat.goals.recoveryTitle")}</strong>
        <ChatGoalRecoveryMessage recovery={recovery} />
      </div>
      <ChatGoalRecoveryAction recovery={recovery} connected={connected} />
    </div>
  );
}

export function ChatGoalRecoveryMessage(props: { recovery: ChatGoalRecovery }) {
  return (
    <>
      <span>
        {t(
          props.recovery.retired === "expired"
            ? "chat.goals.recoveryExpired"
            : props.recovery.retired === "invalid"
              ? "chat.goals.recoveryInvalid"
              : "chat.goals.recoveryHint",
        )}
      </span>
      <Show when={props.recovery.error}>
        <details class="agent-chat__goal-recovery-error">
          <summary>
            <span>{t("chat.goals.technicalDetails")}</span>
            <Icon name="chevronDown" />
          </summary>
          <div class="agent-chat__goal-recovery-error-body">{props.recovery.error}</div>
        </details>
      </Show>
    </>
  );
}

export function ChatGoalRecoveryAction(props: { recovery: ChatGoalRecovery; connected: boolean }) {
  return (
    <button
      class="btn btn--sm"
      type="button"
      disabled={!props.connected || props.recovery.pending}
      onClick={() => void props.recovery.onCheck()}
    >
      {t(props.recovery.retired ? "chat.goals.refreshCurrent" : "chat.goals.checkOutcome")}
    </button>
  );
}
