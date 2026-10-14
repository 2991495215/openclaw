import { createSignal, Show } from "solid-js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { withPromiseModalHost } from "../components/promise-modal-host.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { t } from "../lib/reactive/i18n.ts";
import { notifyBrowserAuthRestored, subscribeBrowserHttpFailures } from "./browser-http.ts";
import {
  fetchWithControlUiAuth,
  resolveControlUiAuthCandidates,
  type ControlUiAuthSource,
} from "./control-ui-auth.ts";
import { webKitHostWindow } from "./native-webkit-bridge.ts";

function renewBrowserSession(url: URL, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    // Navigation follows cookie-based SSO redirects without CORS/connect-src
    // exceptions or Gateway credentials. The frame cannot run scripts or leave itself.
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.referrerPolicy = "no-referrer";
    frame.src = url.href;
    const finish = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      frame.remove();
      resolve();
    };
    const timeout = window.setTimeout(finish, 10_000);
    frame.addEventListener("load", finish, { once: true });
    frame.addEventListener("error", finish, { once: true });
    signal.addEventListener("abort", finish, { once: true });
    document.body.append(frame);
  });
}

/** The document owns proxy sign-in; a healthy WebSocket does not establish HTTP access. */
export function startBrowserAuthRecovery(
  resourceBasePath: string,
  getAuth: () => ControlUiAuthSource = () => ({}),
): () => void {
  const root = new URL(`${normalizeBasePath(resourceBasePath)}/`, window.location.origin);
  const probeUrl = new URL(CONTROL_UI_BOOTSTRAP_CONFIG_PATH.slice(1), root);
  const lifetime = new AbortController();
  let pending: Promise<void> | undefined;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  let signInRequired = false;
  let dismissed = false;
  let openedSignIn = false;
  let dialog: { close: () => void; update: () => void } | undefined;
  let probeResult: "unavailable" | "sign-in" | undefined;

  let diagnosticProbe = 0;
  let diagnosticPhase = "idle";
  const trace = (event: string, details: Record<string, unknown> = {}) => {
    console.warn(
      "BROWSER_AUTH_DIAGNOSTIC",
      JSON.stringify({
        event,
        probe: diagnosticProbe,
        phase: diagnosticPhase,
        pending: Boolean(pending),
        aborted: lifetime.signal.aborted,
        signInRequired,
        dismissed,
        openedSignIn,
        dialog: Boolean(dialog),
        probeResult,
        ...details,
      }),
    );
  };

  const showDialog = () => {
    trace("show-dialog");
    if (dialog || dismissed || lifetime.signal.aborted) {
      return;
    }
    void withPromiseModalHost<void>({ signal: lifetime.signal, value: undefined }, (modal) => {
      const dismiss = () => {
        dismissed = true;
        modal.finish(undefined);
      };
      let update: (() => void) | undefined;
      async function signIn() {
        if (webKitHostWindow()?.webkit?.messageHandlers?.openclawGateways) {
          const { nativeGatewaysCapability } = await import("./native-gateways.runtime.ts");
          if (lifetime.signal.aborted || dismissed) {
            return;
          }
          const native = nativeGatewaysCapability();
          const currentId = native?.snapshot?.currentId;
          if (native?.reconnect && currentId) {
            // The app owns a separate cookie store; a normal browser tab cannot renew it.
            native.reconnect(currentId);
            return;
          }
        }
        openedSignIn = true;
        probeResult = undefined;
        openExternalUrlSafe(root.href);
        update?.();
      }
      const content = () => {
        const readView = () => ({ openedSignIn, pending: Boolean(pending), probeResult });
        const [view, setView] = createSignal(readView());
        update = () => setView(readView());
        return (
          <openclaw-modal-dialog
            label={t("connection.browserSignIn.title")}
            description={t("connection.browserSignIn.description")}
            onModal-cancel={dismiss}
          >
            <div class="exec-approval-card">
              <div class="exec-approval-header">
                <div style={{ "min-width": "0" }}>
                  <div class="exec-approval-title">{t("connection.browserSignIn.title")}</div>
                  <div class="exec-approval-sub" style={{ "white-space": "normal" }}>
                    {t("connection.browserSignIn.description")}
                  </div>
                </div>
              </div>
              <Show when={view().openedSignIn}>
                <p>{t("connection.browserSignIn.returnHint")}</p>
              </Show>
              <p role="status" aria-live="polite">
                {view().pending
                  ? t("connection.browserSignIn.checking")
                  : view().probeResult === "unavailable"
                    ? t("connection.browserSignIn.unavailable")
                    : view().probeResult === "sign-in"
                      ? t("connection.browserSignIn.stillRequired")
                      : null}
              </p>
              <div class="exec-approval-actions">
                <button class="btn primary" onClick={() => void signIn()}>
                  {t("connection.browserSignIn.action")}
                </button>
                <Show when={view().openedSignIn}>
                  <button class="btn" disabled={view().pending} onClick={() => void check(true)}>
                    {t("connection.browserSignIn.checkAgain")}
                  </button>
                </Show>
                <button class="btn" onClick={dismiss}>
                  {t("connection.browserSignIn.dismiss")}
                </button>
              </div>
            </div>
          </openclaw-modal-dialog>
        );
      };
      dialog = { close: () => modal.finish(undefined), update: () => update?.() };
      modal.render(content);
    }).finally(() => {
      dialog = undefined;
    });
  };

  function check(explicit = false): Promise<void> | undefined {
    trace("check-enter", { explicit });
    if (lifetime.signal.aborted || pending || (!explicit && Date.now() - lastProbeAt < 30_000)) {
      trace("check-coalesced-or-skipped", { explicit });
      return pending;
    }
    diagnosticProbe += 1;
    diagnosticPhase = "capturing-auth";
    trace("check-start", { explicit });
    lastProbeAt = Date.now();
    const authCandidates = resolveControlUiAuthCandidates(getAuth());
    const isCurrent = () => {
      const current = resolveControlUiAuthCandidates(getAuth());
      return (
        !lifetime.signal.aborted &&
        current.length === authCandidates.length &&
        current.every((candidate, index) => candidate === authCandidates[index])
      );
    };
    pending = (async () => {
      try {
        // This canonical endpoint never redirects. Manual mode exposes an edge
        // redirect without following it or forwarding Gateway credentials to it.
        const probe = () =>
          fetchWithControlUiAuth(
            probeUrl.href,
            {
              method: "HEAD",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "manual",
              signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]),
            },
            authCandidates,
            isCurrent,
          );
        diagnosticPhase = "first-probe";
        trace("probe-start");
        let response = await probe();
        trace("probe-response", { responseType: response.type, responseStatus: response.status });
        if (!isCurrent()) {
          return;
        }
        if (response.type === "opaqueredirect" && !signInRequired) {
          signInRequired = true;
          diagnosticPhase = "renewal";
          trace("renewal-start");
          await renewBrowserSession(probeUrl, lifetime.signal);
          trace("renewal-finished");
          if (!isCurrent()) {
            return;
          }
          // Login/error pages can also finish loading (or refuse framing).
          // Only a fresh authenticated probe establishes renewed HTTP access.
          diagnosticPhase = "renewed-probe";
          trace("probe-start");
          response = await probe();
          trace("probe-response", { responseType: response.type, responseStatus: response.status });
        }
        if (!isCurrent()) {
          return;
        }
        if (response.type === "opaqueredirect") {
          signInRequired = true;
          probeResult = openedSignIn ? "sign-in" : undefined;
          diagnosticPhase = "show-dialog";
          showDialog();
          trace("show-dialog-returned");
        } else if (
          response.ok &&
          response.headers.get("content-type")?.split(";")[0]?.trim() === "application/json"
        ) {
          const recovered = signInRequired;
          signInRequired = false;
          dismissed = false;
          openedSignIn = false;
          diagnosticPhase = "dialog-close";
          trace("dialog-close-start", { recovered });
          dialog?.close();
          trace("dialog-close-finished", { recovered });
          if (recovered) {
            diagnosticPhase = "notify-restored";
            trace("notify-start");
            notifyBrowserAuthRestored();
            trace("notify-finished");
          }
        } else {
          probeResult = "unavailable";
        }
      } catch (error) {
        trace("caught", {
          errorClass: error instanceof Error ? error.name : typeof error,
          stack:
            error instanceof Error
              ? error.stack?.split("\n").filter((line) => /^\s+at /.test(line))
              : undefined,
        });
        if (isCurrent()) {
          probeResult = "unavailable";
        }
      }
    })().finally(() => {
      trace("pending-finally-start");
      pending = undefined;
      dialog?.update();
      trace("pending-finally-finished");
    });
    dialog?.update();
    return pending;
  }

  const stopFailures = subscribeBrowserHttpFailures((url) => {
    const request = URL.parse(url, window.location.href);
    if (request?.origin === root.origin && request.pathname.startsWith(root.pathname)) {
      void check();
    }
  });
  const serviceWorker = navigator.serviceWorker;
  const onWorkerMessage = (event: MessageEvent) => {
    if (
      serviceWorker?.controller &&
      event.source === serviceWorker.controller &&
      event.data?.type === "openclaw-http-request-failed"
    ) {
      void check();
    }
  };
  const onFocus = () => {
    trace("window-focus");
    if (signInRequired) {
      void check(true);
    }
  };
  const onVisibilityChange = () => {
    trace("visibility", { visible: document.visibilityState === "visible" });
    if (document.visibilityState === "visible") {
      onFocus();
    }
  };
  serviceWorker?.addEventListener("message", onWorkerMessage, { signal: lifetime.signal });
  window.addEventListener("focus", onFocus, { signal: lifetime.signal });
  document.addEventListener("visibilitychange", onVisibilityChange, { signal: lifetime.signal });
  return () => {
    trace("stop");
    lifetime.abort();
    stopFailures();
  };
}
