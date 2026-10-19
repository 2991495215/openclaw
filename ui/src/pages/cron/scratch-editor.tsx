import { onCleanup, Show } from "solid-js";
import type { CronScratchGetResult, CronScratchSetResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";

registerEnglishCatalog(registerCronEnglish);

type Props = { jobId: string; gateway: ApplicationContext["gateway"] | null };
type Host = SolidBridgeElement<Props>;

// Admission and draft updates stay synchronous; the renderer consumes their projection.
class ScratchEditorState {
  snapshot: CronScratchGetResult | null = null;
  draft = "";
  busy = false;
  message = "";
  conflict = false;
  redacted = false;
  private unsubscribeGateway?: () => void;
  private bindingRevision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly connection = createGatewayConnectionLifecycle({
    client: null,
    phase: "stopped",
  });

  constructor(private readonly host: Host) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  bindGateway() {
    const bindingRevision = ++this.bindingRevision;
    this.unsubscribeGateway?.();
    this.unsubscribeGateway = undefined;
    this.connection.invalidate();
    this.reset();
    const gateway = this.host.gateway;
    if (!this.host.isConnected || !gateway) {
      this.connection.transition({ client: null, phase: "stopped" });
      return;
    }
    this.applySnapshot(gateway.snapshot);
    this.unsubscribeGateway = gateway.subscribe((snapshot) => {
      if (bindingRevision === this.bindingRevision && gateway === this.host.gateway) {
        this.applySnapshot(snapshot);
      }
    });
  }

  disconnect() {
    this.bindingRevision += 1;
    this.unsubscribeGateway?.();
    this.unsubscribeGateway = undefined;
    this.connection.transition({ client: null, phase: "stopped" });
    this.reset();
  }

  dispose() {
    this.listeners.clear();
    this.disconnect();
  }

  private applySnapshot(snapshot: ApplicationGatewaySnapshot) {
    if (this.connection.transition(snapshot)) {
      this.reset();
    }
    if (!this.canManage) {
      this.connection.invalidate();
      this.reset();
    }
    this.publish();
  }

  private reset() {
    this.snapshot = null;
    this.draft = "";
    this.busy = false;
    this.message = "";
    this.conflict = false;
    this.redacted = false;
    this.publish();
  }

  get canManage() {
    return Boolean(
      this.host.gateway && readGatewayOperatorAccess(this.host.gateway.snapshot).canAdmin,
    );
  }

  get connected() {
    return this.host.gateway?.snapshot.phase === "connected";
  }

  get disabled() {
    return this.busy || !this.connected || !this.canManage || this.conflict;
  }

  get sizeBytes() {
    return new TextEncoder().encode(this.draft).length;
  }

  private accept(snapshot: CronScratchGetResult) {
    const content = snapshot.scratch?.content ?? "";
    this.draft = redactToolDetail(content);
    this.redacted = this.draft !== content;
    // Retain revision metadata only: raw scratch must not leak into diagnostics/state dumps.
    this.snapshot = {
      ...snapshot,
      scratch: snapshot.scratch ? { ...snapshot.scratch, content: "" } : null,
    };
    this.conflict = false;
  }

  async request(content?: string | null) {
    const scope = this.connection.capture();
    const client = scope?.client;
    const jobId = this.host.jobId;
    const saving = content !== undefined;
    const snapshot = this.snapshot;
    if (!scope || !client || !jobId || this.busy || !this.canManage) {
      return;
    }
    if (saving && (!snapshot || this.conflict)) {
      return;
    }
    if (typeof content === "string" && this.redacted) {
      return;
    }
    if (typeof content === "string" && snapshot && this.sizeBytes > snapshot.maxBytes) {
      this.message = t("cron.scratch.tooLarge");
      this.publish();
      return;
    }
    this.busy = true;
    this.message = "";
    this.publish();
    try {
      const result = saving
        ? await client.request<CronScratchSetResult>("cron.scratch.set", {
            id: jobId,
            content,
            expectedRevision: snapshot?.currentRevision,
          })
        : await client.request<CronScratchGetResult>("cron.scratch.get", { id: jobId });
      if (!this.connection.isCurrent(scope) || this.host.jobId !== jobId || !this.canManage) {
        return;
      }
      if ("reason" in result) {
        // A retry must not overwrite a newer revision with this conflicting draft.
        this.conflict = true;
        this.message = t("cron.scratch.conflict");
        return;
      }
      this.accept(result);
      if (saving) {
        this.message = t(content === null ? "cron.scratch.removed" : "cron.scratch.saved");
      }
    } catch (error) {
      if (this.connection.isCurrent(scope) && this.host.jobId === jobId) {
        this.message = formatUiError(error);
      }
    } finally {
      if (this.connection.isCurrent(scope) && this.host.jobId === jobId) {
        this.busy = false;
        this.publish();
      }
    }
  }
}

const states = new WeakMap<Host, ScratchEditorState>();

function ScratchEditorContent(_props: Props, host: Host) {
  const state = new ScratchEditorState(host);
  states.set(host, state);
  state.bindGateway();
  const view = projectOwner(state, (owner) => owner).read;
  onCleanup(() => {
    state.dispose();
    states.delete(host);
  });
  return (
    <Show when={view().canManage}>
      <section class="settings-section">
        <details>
          <summary class="settings-section__heading">{t("cron.scratch.title")}</summary>
          <p class="settings-section__desc">{t("cron.scratch.help")}</p>
          <button
            type="button"
            class="btn btn--sm"
            disabled={view().busy || !view().connected}
            onClick={() => void state.request()}
          >
            {t(view().snapshot ? "cron.scratch.reload" : "cron.scratch.load")}
          </button>
          <Show when={view().snapshot}>
            <Show when={!view().snapshot?.scratch}>
              <p class="cron-help">{t("cron.scratch.empty")}</p>
            </Show>
            <label class="field">
              <span>{t("cron.scratch.content")}</span>
              <textarea
                class="settings-input mono"
                rows={8}
                value={view().draft}
                readonly={view().disabled || view().redacted}
                maxlength={view().snapshot?.maxBytes}
                onInput={(event) => {
                  state.draft = event.currentTarget.value;
                  state.publish();
                }}
              />
            </label>
            <p class="cron-help">
              {t("cron.scratch.limit", {
                bytes: String(view().sizeBytes),
                max: String(view().snapshot?.maxBytes),
              })}
            </p>
            <Show when={view().redacted}>
              <p class="cron-help">{t("cron.scratch.redacted")}</p>
            </Show>
            <button
              type="button"
              class="btn btn--sm"
              disabled={
                view().disabled ||
                view().redacted ||
                view().sizeBytes > (view().snapshot?.maxBytes ?? 0)
              }
              onClick={() => void state.request(state.draft)}
            >
              {t("cron.scratch.save")}
            </button>{" "}
            <button
              type="button"
              class="btn btn--sm danger"
              disabled={view().disabled || !view().snapshot?.scratch}
              onClick={() => void state.request(null)}
            >
              {t("cron.scratch.clear")}
            </button>
          </Show>
          <Show when={view().message}>
            <p class="cron-help" role="status">
              {view().message}
            </p>
          </Show>
        </details>
      </section>
    </Show>
  );
}

export const CronScratchEditor = defineSolidBridge<Props>(
  "openclaw-cron-scratch-editor",
  ScratchEditorContent,
  {
    properties: {
      jobId: { default: "", attribute: false },
      gateway: { default: null, attribute: false },
    },
    connected: (host) => states.get(host)?.bindGateway(),
    disconnected: (host) => states.get(host)?.disconnect(),
    propertyChanged: (host) => states.get(host)?.bindGateway(),
  },
);
