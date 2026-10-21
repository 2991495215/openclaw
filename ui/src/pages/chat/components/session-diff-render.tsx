import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelFeedback } from "../../../components/solid/panel-feedback.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import type { ParsedFilePatch } from "../../../lib/chat/session-diff.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  DiffBlock,
  DiffFoldToggle,
  DiffFoldPlaceholder,
  type DiffPresentation,
} from "./chat-diff-render.solid.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

function SplitSide(props: {
  line: DiffLine | undefined;
  side: "left" | "right";
  presentation: DiffPresentation;
}) {
  return (
    <div
      class={[
        "session-diff-split__side",
        `session-diff-split__side--${props.side}`,
        { "session-diff-split__side--filled": Boolean(props.line) },
      ]}
    >
      <span class="session-diff-split__gutter">
        {props.line && <DiffFoldToggle line={props.line} presentation={props.presentation} />}
        {props.line?.lineNo ?? ""}
      </span>
      <span class="session-diff-split__sign">
        {props.line ? (props.side === "left" ? "-" : "+") : ""}
      </span>
      <span class="session-diff-split__text">
        {props.line ? props.presentation.renderLine(props.line) : ""}
      </span>
    </div>
  );
}

function SessionSplitDiff(props: {
  renderSkip: (line: DiffLine) => JSX.Element;
  presentation: DiffPresentation;
}) {
  return (
    <div
      class="session-diff-split code-highlight"
      role="figure"
      aria-label={t("chat.toolCards.fileChanges")}
    >
      <For each={props.presentation.visibility().rows}>
        {(row) => (
          <>
            {row.kind === "pair" ? (
              <div class="session-diff-split__row session-diff-split__row--pair">
                <SplitSide line={row.left} side="left" presentation={props.presentation} />
                <SplitSide line={row.right} side="right" presentation={props.presentation} />
              </div>
            ) : row.line.kind === "skip" ? (
              <div class="session-diff-split__row session-diff-split__row--skip">
                {(props.renderSkip(row.line) ?? row.line.text) || "⋯"}
              </div>
            ) : (
              <div class="session-diff-split__row session-diff-split__row--context">
                <span class="session-diff-split__gutter">
                  <DiffFoldToggle line={row.line} presentation={props.presentation} />
                  {row.line.lineNo ?? ""}
                </span>
                <span class="session-diff-split__sign" />
                <span class="session-diff-split__text">
                  {props.presentation.renderLine(row.line)}
                </span>
              </div>
            )}
            {props.presentation.visibility().rowPlaceholders.get(row) && (
              <DiffFoldPlaceholder
                fold={props.presentation.visibility().rowPlaceholders.get(row)!}
                presentation={props.presentation}
              />
            )}
          </>
        )}
      </For>
    </div>
  );
}

export function SessionDiffFileBody(props: {
  file: SessionDiffFile;
  parsed: ParsedFilePatch | null;
  unavailableReason: SessionsDiffResult["unavailableReason"];
  split: boolean;
  presentation: DiffPresentation;
  renderSkip: (line: DiffLine) => JSX.Element;
}) {
  return (
    <Show
      when={props.file.binary !== true && props.parsed}
      fallback={
        <Show
          when={props.file.binary === true}
          fallback={
            <PanelFeedback
              label={props.file.path}
              message={t(
                props.unavailableReason === "workspace_stopped"
                  ? "chat.sessionDiff.workspaceStoppedFile"
                  : "chat.sessionDiff.previewUnavailable",
              )}
            />
          }
        >
          <div class="session-diff__note">{t("chat.sessionDiff.binaryFile")}</div>
        </Show>
      }
    >
      <Show
        when={props.split}
        fallback={
          <DiffBlock
            presentation={props.presentation}
            lines={props.parsed?.lines ?? []}
            renderSkip={props.renderSkip}
            file={props.file}
          />
        }
      >
        <SessionSplitDiff presentation={props.presentation} renderSkip={props.renderSkip} />
      </Show>
      {props.parsed?.truncated && (
        <span
          class="panel-feedback__hint"
          role="img"
          title={t("chat.sessionDiff.truncatedFile")}
          aria-label={t("chat.sessionDiff.truncatedFile")}
        >
          <Icon name="info" />
        </span>
      )}
    </Show>
  );
}
