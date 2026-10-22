const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "Google Chat",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
];

/** Removes recognized channel/timestamp prefixes while preserving user-authored bracket text. */
export function stripEnvelope(text: string): string {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) {
    return text;
  }
  const header = match[1] ?? "";
  // Only strip known generated envelopes; arbitrary `[name]` text may be part of the message.
  if (
    !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header) &&
    !/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header) &&
    !ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `))
  ) {
    return text;
  }
  return text.slice(match[0].length);
}
