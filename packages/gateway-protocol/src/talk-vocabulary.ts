export const TALK_TRANSPORTS = [
  "webrtc",
  "provider-websocket",
  "gateway-relay",
  "managed-room",
] as const;

export const TALK_AGENT_CONTROL_MODES = ["status", "steer", "cancel", "followup"] as const;
