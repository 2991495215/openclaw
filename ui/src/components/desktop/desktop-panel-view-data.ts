import type { EnvironmentSummary, WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import type { DockLayout } from "../dock-layout.ts";
import type { DesktopPanelControls, DesktopPanelInputs } from "./desktop-panel-inputs.ts";
import type { DesktopPanelState, DesktopSizingMode } from "./desktop-panel-state.ts";
import type { DesktopSessionOwner } from "./desktop-session-owner.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";
import type { DesktopHostSetup } from "./host-desktop-setup.ts";

type DesktopViewFacts = {
  host: DesktopPanelInputs;
  surfaceRef: (target: HTMLElement | undefined) => void;
  environments: EnvironmentSummary[];
  currentId: string | null;
  phase: DesktopPanelState;
  loading: boolean;
  automaticSource: boolean;
  hostSetup: DesktopHostSetup | null;
  controlling: boolean;
  errorText: string | null;
  noticeText: string | null;
  disconnectedReason: string | null;
  connectionTransition: "connecting" | "taking-control" | "switching-to-viewing";
  connectionFailure: "error" | "lost" | "closed" | null;
  controlTakeoverRecoveryUsed: boolean;
  desktopApps: WorkerDesktopAppId[];
  sizingMode: DesktopSizingMode;
  canResize: boolean;
  username: string;
  ardAccount: boolean;
  controls: DesktopPanelControls;
  sessionSource: Pick<DesktopSessionOwner, "desktopAvailability" | "startupEnvironment">;
  dockLayout: DockLayout<"bottom" | "right">;
};
type DesktopViewActions = {
  onRefresh: () => void;
  onConnect: (environmentId: string) => void;
  onCredentialsSubmit: (event: SubmitEvent) => void;
  onBack: (() => void) | undefined;
  onRetry: () => void;
  onSizingChange: (mode: DesktopSizingMode) => void;
  onControlToggle: () => void;
  onTakeControl: () => void;
  onLaunch: (app: WorkerDesktopAppId) => void;
  onClose: () => void;
  onDocumentClose: () => void;
  focusTarget: () => {
    basePath: string;
    source: string | null;
    control: boolean;
    workspaceControls: boolean;
  };
  onDisconnect: () => void;
};
/** Pure presentation projection; every operation closes over the original live owner. */
export function projectDesktopPanelView(facts: DesktopViewFacts & DesktopViewActions) {
  const environment = facts.environments.find((entry) => entry.id === facts.currentId);
  return {
    documentMode: facts.host.documentMode,
    embedded: facts.host.embedded,
    surfaceRef: facts.surfaceRef,
    workspaceControls: facts.host.workspaceControls,
    machine: facts.currentId
      ? {
          name: environment?.label || facts.currentId,
          host: desktopSourceForEnvironment({ id: facts.currentId }).kind === "host",
        }
      : null,
    content: {
      state: facts.phase,
      loading: facts.loading,
      automaticSource: facts.automaticSource,
      hasTarget: facts.host.sessionKey !== null || facts.host.requestedSource !== null,
      errorText: facts.errorText,
      noticeText: facts.noticeText,
      takeoverText:
        facts.controlTakeoverRecoveryUsed &&
        (facts.phase === "connecting" || facts.phase === "connected")
          ? facts.noticeText
          : null,
      transition: facts.connectionTransition,
      availability: facts.sessionSource.desktopAvailability,
      picker: {
        automatic: facts.automaticSource && facts.host.embedded && facts.host.sessionKey !== null,
        environments: facts.environments,
        hostSetup: facts.hostSetup,
        onRefresh: facts.onRefresh,
        onConnect: facts.onConnect,
      },
      credentials: {
        ardAccount: facts.ardAccount,
        username: facts.username,
        onSubmit: facts.onCredentialsSubmit,
        onBack: facts.onBack,
      },
      recovery: {
        kind: facts.connectionFailure,
        reason: facts.disconnectedReason,
        onRetry: facts.onRetry,
      },
    },
    controlling: facts.controlling,
    desktopApps: facts.desktopApps,
    launcher: facts.controls.launcher,
    startup: facts.sessionSource.startupEnvironment,
    sizing: {
      mode: facts.sizingMode,
      canResize: facts.canResize && facts.controlling && facts.phase === "connected",
      onChange: facts.onSizingChange,
    },
    mobileKeyboard: facts.controls.mobileKeyboard,
    pictureInPicture: facts.controls.pictureInPicture,
    audio: facts.controls.audio,
    fullscreenMode: facts.controls.fullscreenMode,
    dockLayout: facts.dockLayout,
    onControlToggle: facts.onControlToggle,
    onTakeControl: facts.onTakeControl,
    onLaunch: facts.onLaunch,
    onClose: facts.onClose,
    onDocumentClose: facts.onDocumentClose,
    focusTarget: facts.focusTarget,
    onDisconnect: facts.onDisconnect,
  };
}
