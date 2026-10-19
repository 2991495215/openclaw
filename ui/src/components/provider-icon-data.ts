import { takeGraphemes } from "../lib/graphemes.ts";

const PROVIDER_ICON_NAMES = new Set([
  "abacus",
  "alibaba",
  "amp",
  "antigravity",
  "arcee",
  "augment",
  "baseten",
  "bedrock",
  "byteplus",
  "cerebras",
  "chutes",
  "claude",
  "clawrouter",
  "cloudflare",
  "codebuff",
  "codex",
  "cohere",
  "comfy",
  "commandcode",
  "copilot",
  "crof",
  "crossmodel",
  "cursor",
  "deepgram",
  "deepinfra",
  "deepseek",
  "devin",
  "doubao",
  "elevenlabs",
  "factory",
  "fal",
  "featherless",
  "fireworks",
  "gemini",
  "grok",
  "groq",
  "huggingface",
  "jetbrains",
  "kilo",
  "kimi",
  "kiro",
  "litellm",
  "llamacpp",
  "llmproxy",
  "lmstudio",
  "longcat",
  "manus",
  "meta",
  "microsoft",
  "mimo",
  "minimax",
  "mistral",
  "novita",
  "nvidia",
  "ollama",
  "opencode",
  "opencodego",
  "openrouter",
  "perplexity",
  "pi",
  "pixverse",
  "poe",
  "qianfan",
  "qoder",
  "runway",
  "sakana",
  "stepfun",
  "synthetic",
  "t3chat",
  "tencent",
  "together",
  "venice",
  "vercel",
  "vertexai",
  "vllm",
  "volcengine",
  "warp",
  "windsurf",
  "zai",
  "zed",
]);

// Provider-specific brand assets and labels; omitted fields use the id fallback.
const PROVIDER_BRANDS = new Map<string, { icon?: string; label?: string }>([
  ["anthropic", { icon: "claude", label: "Anthropic" }],
  ["amazon-bedrock", { icon: "bedrock" }],
  ["aws-bedrock", { icon: "bedrock" }],
  ["claude-cli", { icon: "claude", label: "Claude CLI" }],
  ["cloudflare-ai-gateway", { icon: "cloudflare" }],
  ["copilot-proxy", { icon: "copilot" }],
  ["google", { icon: "gemini", label: "Google" }],
  ["google-gemini-cli", { icon: "gemini" }],
  ["github-copilot", { icon: "copilot", label: "GitHub" }],
  ["kilocode", { icon: "kilo" }],
  ["kimi-coding", { icon: "kimi" }],
  ["llama-cpp", { icon: "llamacpp", label: "llama.cpp" }],
  ["microsoft-foundry", { icon: "microsoft" }],
  ["minimax-portal", { icon: "minimax" }],
  ["ollama-cloud", { icon: "ollama" }],
  // CodexBar names its bundled OpenAI knot asset "codex".
  ["openai", { icon: "codex", label: "OpenAI" }],
  ["moonshot", { icon: "kimi", label: "Moonshot AI" }],
  ["opencode-go", { icon: "opencodego" }],
  ["opencode-zen", { icon: "opencode" }],
  ["qwen", { icon: "alibaba", label: "Qwen Cloud" }],
  ["qwen-token-plan", { icon: "alibaba" }],
  ["stepfun-plan", { icon: "stepfun" }],
  ["tencent-tokenhub", { icon: "tencent" }],
  ["tencent-tokenplan", { icon: "tencent" }],
  ["xai", { icon: "grok", label: "xAI" }],
  // Xiaomi ships its AI models under the MiMo brand mark.
  ["xiaomi", { icon: "mimo" }],
  ["xiaomi-token-plan", { icon: "mimo" }],
  ["vercel-ai-gateway", { icon: "vercel" }],
  ["vertex-ai", { icon: "vertexai" }],
  ["z-ai", { icon: "zai" }],
  ["acp-copilot", { label: "GitHub Copilot CLI" }],
  ["acp-kilocode", { label: "Kilo Code (ACP)" }],
  ["acp-qwen", { label: "Qwen Code (ACP)" }],
  ["lmstudio", { label: "LM Studio" }],
  ["longcat", { label: "LongCat" }],
  ["opencode", { label: "OpenCode" }],
  ["openrouter", { label: "OpenRouter" }],
  ["zai", { label: "Z.AI" }],
]);

// ACPX native harnesses publish their catalogs under `acp-<agent>` provider ids.
const ACP_HARNESS_PROVIDER = /^acp-(.+)$/u;

/** Title-cased fallback label built from the provider id ("z-ai" → "Z Ai"). */
export function formatRawProviderLabel(provider: string): string {
  return provider
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** Brand display name for a (normalized, lowercase) provider id. */
export function providerDisplayLabel(provider: string): string {
  const label = PROVIDER_BRANDS.get(provider)?.label;
  if (label) {
    return label;
  }
  const acpAgent = ACP_HARNESS_PROVIDER.exec(provider)?.[1];
  return acpAgent ? `${providerDisplayLabel(acpAgent)} (ACP)` : formatRawProviderLabel(provider);
}

/** Provider id from a canonical `provider/model` reference, or null when absent. */
export function providerIdFromModelRef(modelRef: string): string | null {
  const separator = modelRef.indexOf("/");
  const provider = separator > 0 ? modelRef.slice(0, separator).trim().toLowerCase() : "";
  return provider || null;
}

/** Icon asset name for a (normalized, lowercase) provider id, or null when no brand mark ships. */
export function resolveProviderIconName(provider: string): string | null {
  const normalized = provider.trim().toLowerCase();
  const icon = PROVIDER_BRANDS.get(normalized)?.icon ?? normalized;
  if (PROVIDER_ICON_NAMES.has(icon)) {
    return icon;
  }
  const acpAgent = ACP_HARNESS_PROVIDER.exec(normalized)?.[1];
  return acpAgent ? resolveProviderIconName(acpAgent) : null;
}

export function hasProviderBrandIcon(provider: string): boolean {
  return resolveProviderIconName(provider) !== null;
}

export type CloudProfileIdentity = { providerId: string; providerDisplayId?: string };

// Cloud backends are a separate identity domain: Google Cloud is not Gemini,
// and AWS is not Bedrock. Map lookup also keeps prototype keys on the fallback.
const CLOUD_PROVIDERS = new Map<string, { label: string; brand?: string }>([
  ["aws", { label: "AWS", brand: "aws" }],
  ["azure", { label: "Azure", brand: "azure" }],
  ["daytona", { label: "Daytona", brand: "daytona" }],
  ["gcp", { label: "Google Cloud", brand: "gcp" }],
  ["hetzner", { label: "Hetzner", brand: "hetzner" }],
  ["machine0", { label: "Machine0" }],
]);
const CLOUD_ALIASES = new Map([
  ["google", "gcp"],
  ["google-cloud", "gcp"],
  ["docker", "local-container"],
  ["local-docker", "local-container"],
  ["podman", "local-container"],
  ["local-podman", "local-container"],
]);

function cloudProfileBackendId(profile?: CloudProfileIdentity): string {
  const raw = (profile?.providerDisplayId ?? profile?.providerId ?? "").trim().toLowerCase();
  return CLOUD_ALIASES.get(raw) ?? raw;
}

/** Known cloud services precede local/custom infrastructure, alphabetically within each group. */
export function compareCloudProfiles(
  left: CloudProfileIdentity & { id: string },
  right: CloudProfileIdentity & { id: string },
): number {
  // Backend identity, not an editable profile name or the availability of a logo.
  return (
    Number(CLOUD_PROVIDERS.has(cloudProfileBackendId(right))) -
      Number(CLOUD_PROVIDERS.has(cloudProfileBackendId(left))) || left.id.localeCompare(right.id)
  );
}

export function providerFallbackLetter(label: string): string {
  return takeGraphemes(label.trim().toUpperCase(), 1) || "?";
}

/** Cloud identity is distinct from model-provider identity (Google Cloud versus Gemini). */
type CloudProfileIconData = {
  label: string;
} & (
  | { providerId: string; iconName?: never }
  | { providerId?: never; iconName: "server" | "box" | "cloud" }
);

export function resolveCloudProfileIconData(profile?: CloudProfileIdentity): CloudProfileIconData {
  const id = cloudProfileBackendId(profile);
  const brand = CLOUD_PROVIDERS.get(id);
  const label =
    brand?.label ?? (profile?.providerDisplayId ?? profile?.providerId ?? "").trim().toLowerCase();
  return brand?.brand
    ? {
        label,
        providerId: brand.brand,
      }
    : {
        label,
        iconName:
          id === "machine0" || id === "incus"
            ? "server"
            : id === "local-container"
              ? "box"
              : "cloud",
      };
}
