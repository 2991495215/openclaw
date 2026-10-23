// Tool Display script supports OpenClaw repository automation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_DISPLAY_CONFIG } from "../src/agents/tool-display-config.js";
import { isTestOnlyPath } from "./lib/changed-path-facts.mjs";

type ToolDisplayConfig = typeof TOOL_DISPLAY_CONFIG;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputPath = path.join(
  repoRoot,
  "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json",
);
const toolSources = [
  path.join(repoRoot, "src/agents/apply-patch.ts"),
  path.join(repoRoot, "src/agents/bash-tools.exec-run.ts"),
  path.join(repoRoot, "src/agents/bash-tools.process.ts"),
  path.join(repoRoot, "src/auto-reply/reply/acp-projector.ts"),
];

const args = new Set(process.argv.slice(2));
const shouldCheck = args.has("--check");
const shouldWrite = args.has("--write");

if (!shouldCheck && !shouldWrite) {
  console.error("Usage: node --import tsx scripts/tool-display.ts --check|--write");
  process.exit(1);
}

const snapshots = [
  { path: outputPath, expected: serializeToolDisplayConfig() },
  {
    path: path.join(repoRoot, "ui/src/lib/chat/tool-display-presentation.generated.json"),
    expected: `${JSON.stringify(
      {
        version: TOOL_DISPLAY_CONFIG.version,
        fallback: toolPresentation(TOOL_DISPLAY_CONFIG.fallback),
        tools: Object.fromEntries(
          Object.entries(TOOL_DISPLAY_CONFIG.tools).map(([name, spec]) => [
            name,
            toolPresentation(spec),
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  },
];
ensureCoreToolCoverage();

if (shouldWrite) {
  for (const snapshot of snapshots) {
    fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
    fs.writeFileSync(snapshot.path, snapshot.expected);
    process.stdout.write(`wrote ${path.relative(repoRoot, snapshot.path)}\n`);
  }
  process.exit(0);
}

for (const snapshot of snapshots) {
  if (!fs.existsSync(path.dirname(snapshot.path))) {
    process.stdout.write(
      `skip tool-display snapshot check; missing ${path.relative(repoRoot, path.dirname(snapshot.path))}\n`,
    );
    continue;
  }

  if (!fs.existsSync(snapshot.path)) {
    console.error(
      `missing generated snapshot: ${path.relative(repoRoot, snapshot.path)}\nrun: pnpm tool-display:write`,
    );
    process.exit(1);
  }

  const actual = fs.readFileSync(snapshot.path, "utf8");
  if (actual !== snapshot.expected) {
    console.error(
      `tool-display snapshot is stale: ${path.relative(repoRoot, snapshot.path)}\nrun: pnpm tool-display:write`,
    );
    process.exit(1);
  }
}

process.stdout.write("tool-display snapshot is up to date\n");

function ensureCoreToolCoverage() {
  const toolNames = new Set<string>();
  for (const sourcePath of toolSources) {
    collectToolNamesFromFile(sourcePath, toolNames);
  }
  for (const entry of fs.readdirSync(path.join(repoRoot, "src/agents/tools"))) {
    if (!entry.endsWith(".ts") || isTestOnlyPath(entry)) {
      continue;
    }
    collectToolNamesFromFile(path.join(repoRoot, "src/agents/tools", entry), toolNames);
  }
  const missing = [...toolNames].filter((name) => !TOOL_DISPLAY_CONFIG.tools[name]).toSorted();
  if (missing.length > 0) {
    console.error(
      `tool-display metadata missing for runtime tools: ${missing.join(", ")}\nupdate: src/agents/tool-display-config.ts`,
    );
    process.exit(1);
  }
}

function collectToolNamesFromFile(sourcePath: string, names: Set<string>) {
  const source = fs.readFileSync(sourcePath, "utf8");
  for (const match of source.matchAll(/\bname:\s*"([A-Za-z0-9_-]+)"/g)) {
    const name = match[1]?.trim();
    if (name) {
      names.add(name);
    }
  }
}

function toolPresentation({ icon, title, label }: ToolDisplayConfig["fallback"]) {
  return { icon, title, label };
}

function serializeToolDisplayConfig(config: ToolDisplayConfig = TOOL_DISPLAY_CONFIG): string {
  const tools = Object.entries(config.tools);
  return [
    "{",
    `  "version": ${JSON.stringify(config.version)},`,
    `  "fallback": ${JSON.stringify(config.fallback)},`,
    '  "tools": {',
    ...tools.map(
      ([name, spec], index) =>
        `    ${JSON.stringify(name)}: ${JSON.stringify(spec)}${index === tools.length - 1 ? "" : ","}`,
    ),
    "  }",
    "}",
    "",
  ].join("\n");
}
