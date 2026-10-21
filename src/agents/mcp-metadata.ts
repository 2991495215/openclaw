import type {
  ClientCapabilities,
  ServerCapabilities,
  Transport,
} from "@modelcontextprotocol/client";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MCP_METADATA_TEXT_LIMIT = 1_200;
const MCP_APPS_CLIENT_EXTENSION = "io.modelcontextprotocol/ui";
export const MCP_ENTERPRISE_AUTH_CLIENT_EXTENSION =
  "io.modelcontextprotocol/enterprise-managed-authorization";
const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

export function prepareMcpCaps(
  session: { transport: Transport; enterpriseAuth?: boolean },
  nativeCapabilities: ClientCapabilities | undefined,
  mcpAppsEnabled: boolean,
): ClientCapabilities {
  if (session.enterpriseAuth === true) {
    // The SDK's legacy fallback omits per-request capabilities; preserve both protocol eras.
    const transport = session.transport;
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (!("id" in message) || !("method" in message)) {
        return send(message, options);
      }
      const params = isRecord(message.params) ? message.params : {};
      const meta = isRecord(params._meta) ? params._meta : {};
      const capabilities = isRecord(meta["io.modelcontextprotocol/clientCapabilities"])
        ? meta["io.modelcontextprotocol/clientCapabilities"]
        : {};
      const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : {};
      return send(
        {
          ...message,
          params: {
            ...params,
            _meta: {
              ...meta,
              "io.modelcontextprotocol/clientCapabilities": {
                ...capabilities,
                extensions: { ...extensions, [MCP_ENTERPRISE_AUTH_CLIENT_EXTENSION]: {} },
              },
            },
          },
        },
        options,
      );
    };
  }
  const enterpriseAuth = session.enterpriseAuth === true;
  const capabilities: ClientCapabilities =
    nativeCapabilities ??
    (mcpAppsEnabled
      ? {
          elicitation: { form: {}, url: {} },
          extensions: {
            "openai/elicitation": { form: {} },
            [MCP_APPS_CLIENT_EXTENSION]: { mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE] },
          },
        }
      : {});
  return enterpriseAuth
    ? {
        ...capabilities,
        extensions: {
          ...capabilities.extensions,
          [MCP_ENTERPRISE_AUTH_CLIENT_EXTENSION]: {},
        },
      }
    : capabilities;
}

export function normalizeToolUiVisibility(value: unknown): Array<"app" | "model"> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter(
    (entry): entry is "app" | "model" => entry === "app" || entry === "model",
  );
  return [...new Set(normalized)].toSorted();
}

export function summarizeServerCapabilities(capabilities: ServerCapabilities | undefined) {
  return {
    resources: capabilities?.resources
      ? { listChanged: capabilities.resources.listChanged === true }
      : undefined,
    prompts: capabilities?.prompts
      ? { listChanged: capabilities.prompts.listChanged === true }
      : undefined,
    tools: capabilities?.tools
      ? { listChanged: capabilities.tools.listChanged === true }
      : undefined,
  };
}

/** Scrubs untrusted MCP metadata before exposing it to a model. */
export function sanitizeMcpMetadataText(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const scrubbed = normalized
    .replace(
      /(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
      "[redacted MCP metadata instruction]",
    )
    .replace(/system\s+prompt/gi, "system prompt");
  return scrubbed.length > MCP_METADATA_TEXT_LIMIT
    ? `${truncateUtf16Safe(scrubbed, MCP_METADATA_TEXT_LIMIT)}...`
    : scrubbed;
}
