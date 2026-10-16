import { escapeHtmlText as escapeGoogleChatApprovalCardText } from "openclaw/plugin-sdk/string-normalization-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_TEXT_PARAGRAPH_CHARS = 1800;

export { escapeGoogleChatApprovalCardText };

export function buildGoogleChatApprovalTextWidget(text: string, format: "text" | "html" = "text") {
  const truncated =
    text.length <= MAX_TEXT_PARAGRAPH_CHARS
      ? text
      : `${truncateUtf16Safe(text, MAX_TEXT_PARAGRAPH_CHARS - 3)}...`;
  return {
    textParagraph: {
      text: format === "html" ? truncated : escapeGoogleChatApprovalCardText(truncated),
    },
  };
}
