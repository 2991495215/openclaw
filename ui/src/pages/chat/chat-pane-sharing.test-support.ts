import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult,
  SessionVisibility,
  SessionsListResult,
} from "../../api/types.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import type { ChatSessionSharingOutcome } from "./components/chat-session-sharing.solid.tsx";

export type SharingPane = TestChatPane & {
  loadSessionSharing: (row: GatewaySessionRow, force?: boolean) => Promise<void>;
  syncSharingReadRetryPresentation: () => void;
  syncSelectedSessionSharing: (row: GatewaySessionRow | undefined) => void;
  sessionSharingCacheKey: (sessionKey: string) => string;
  mutateSessionSharing: (
    row: GatewaySessionRow,
    change: { visibility: SessionVisibility } | { identityId: string; member: boolean },
  ) => Promise<ChatSessionSharingOutcome>;
  setSessionPublicShare: (
    row: GatewaySessionRow,
    enabled: boolean,
  ) => Promise<ChatSessionSharingOutcome>;
  copySessionPublicLink: (row: GatewaySessionRow) => Promise<ChatSessionSharingOutcome>;
};

const SHARING_METHODS = [
  "session.visibility.set",
  "session.members.listEvidence",
  "session.members.add",
  "session.members.remove",
  "session.publicShare.set",
];

export function setSharingAuthorization(
  pane: SharingPane,
  params: {
    methods?: string[];
    phase?: "connected" | "reconnecting";
    scopes?: string[];
  } = {},
): void {
  const snapshot = pane.context.gateway.snapshot;
  snapshot.phase = params.phase ?? "connected";
  snapshot.hello = {
    ...snapshot.hello,
    auth: {
      role: "operator",
      scopes: params.scopes ?? ["operator.admin"],
    },
    features: {
      ...snapshot.hello?.features,
      methods: params.methods ?? SHARING_METHODS,
    },
  } as typeof snapshot.hello;
}

export function createSharingTestChatPane(params: Parameters<typeof createTestChatPane>[0]) {
  const result = createTestChatPane(params);
  const pane = result.pane as SharingPane;
  setSharingAuthorization(pane);
  result.state.sessionsResult = sharingSessionsResult(sessionRow());
  result.state.sessionsResultAgentId = "main";
  return { ...result, pane };
}

export function sessionRow(): GatewaySessionRow {
  return {
    key: "agent:main:current",
    kind: "direct",
    sessionId: "session-current",
    updatedAt: 1,
    visibility: "draft",
    sharingRole: "owner",
  };
}

export function sharingSessionsResult(row: GatewaySessionRow): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: {
      modelProvider: null,
      model: null,
      contextTokens: null,
    },
    sessions: [row],
  };
}

export function sharingResult(row: GatewaySessionRow): SessionMembersListEvidenceResult {
  return {
    sessionKey: row.key,
    members: [],
    identities: [],
    role: "owner",
    allowedVisibilities: ["shared", "draft"],
  };
}
