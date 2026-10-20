import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { normalizeCsvOrLooseStringList } from "@openclaw/normalization-core/string-normalization";
import {
  applyOpenClawManifestInstallCommonFields,
  parseOpenClawManifestInstallBase,
  resolveOpenClawManifestBlock,
  resolveOpenClawManifestCommonFields,
} from "../shared/frontmatter.js";
import type {
  OpenClawHookMetadata,
  HookEntry,
  HookInstallSpec,
  ParsedHookFrontmatter,
} from "./types.js";

export { parseFrontmatterBlock as parseHookFrontmatter } from "../../packages/markdown-core/src/frontmatter.js";

function parseInstallSpec(input: unknown): HookInstallSpec | undefined {
  const parsed = parseOpenClawManifestInstallBase(input, ["bundled", "npm", "git"]);
  if (!parsed) {
    return undefined;
  }
  const { raw } = parsed;
  const spec = applyOpenClawManifestInstallCommonFields<HookInstallSpec>(
    {
      kind: parsed.kind as HookInstallSpec["kind"],
    },
    parsed,
  );
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.repository === "string") {
    spec.repository = raw.repository;
  }

  return spec;
}

export function resolveHookManifestMetadata(
  frontmatter: ParsedHookFrontmatter,
): OpenClawHookMetadata | undefined {
  const metadataObj = resolveOpenClawManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  return {
    ...resolveOpenClawManifestCommonFields(metadataObj, parseInstallSpec),
    hookKey: readStringValue(metadataObj.hookKey),
    export: readStringValue(metadataObj.export),
    events: normalizeCsvOrLooseStringList(metadataObj.events),
  };
}

export function resolveHookKey(hookName: string, entry?: Pick<HookEntry, "metadata">): string {
  return entry?.metadata?.hookKey ?? hookName;
}
