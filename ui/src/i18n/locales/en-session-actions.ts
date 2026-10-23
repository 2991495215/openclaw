import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Session owners need these labels before optional organization menus load.
const enSessionActions = {
  sessionsView: {
    deletePreservedReasons: {
      "owner-mismatch": "owned elsewhere",
      busy: "live run or cleanup active",
      "foreign-lock": "foreign Git lock",
      "snapshot-failed": "OpenClaw could not create a safety snapshot",
      "cleanup-failed": "cleanup failed",
    },
    archiveReasonManual: "Archived manually",
    archiveReasonAgeRetention: "Automatically archived by age retention",
    archiveReasonActiveSessionCap:
      "Automatically archived because the active-session limit was reached",
    archiveReasonStaleDashboard: "Automatically archived after dashboard inactivity",
    archiveReasonRestartRecovery: "Archived when a replacement session was recovered",
    goal: "Goal",
    pinRootSessionsOnly: "Only root sessions can be pinned; pin the parent session instead.",
    copyTranscriptChanged: "Conversation changed while copying. Try again.",
    openWindowBlocked: "Allow pop-ups for this site, then try again.",
    splitUnavailable: "Open a conversation on a wide screen to use split view.",
    stopCloudWorkerConfirm: 'Stop the cloud worker for "{session}"?',
    stopCloudWorkerConfirmAction: "Stop worker",
    moveSession: "Move session…",
    moveSessionTitle: "Move session",
    moveSessionFailed: "Move failed",
    moveSessionGatewayTarget: "Gateway",
    movingSession: "Moving to {target}…",
    movingSessionGeneric: "Moving session…",
    stopCloudWorker: "Stop cloud worker…",
    newGroupPrompt: "New group name",
    newGroupTitle: "New group",
    newGroupCreate: "Create group",
    newGroupFailed: "Could not create the group.",
    newGroupStale: "Gateway connection replaced before the group was saved. Try again.",
  },
  worktrees: {
    title: "Managed Worktrees",
  },
} satisfies TranslationMap;

export const registerSessionActionsEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, enSessionActions.sessionsView);
    Object.assign(en.worktrees, enSessionActions.worktrees);
  },
  { catalog: enSessionActions },
);
