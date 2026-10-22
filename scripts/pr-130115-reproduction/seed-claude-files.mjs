// Synthetic external transcripts: this prepares parser inputs, not a Claude CLI execution.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.platform !== "darwin") {
  throw new Error("Prepare Claude parser inputs only in the disposable native runner");
}
const spec = JSON.parse(await readFile(process.argv[2], "utf8"));
const runnerRoot = await realpath(process.env.RUNNER_TEMP);
for (const value of [spec.home, spec.output, ...spec.stores.map(store => store.root)]) {
  if (!(await realpath(value)).startsWith(runnerRoot + path.sep)) throw new Error("Synthetic path escaped RUNNER_TEMP");
}
const fixtures = [];
for (const store of spec.stores) {
  if (!/^[a-z][a-z0-9-]*$/.test(store.label) || (await readdir(store.root)).length) throw new Error("Claude input root must be empty and owned");
  const project = path.join(store.root, "projects", "-catalog-proof");
  await mkdir(project, { recursive: true });
  for (let index = 1; index <= 3; index++) {
    const threadId = randomUUID();
    const title = `Claude parser proof ${store.label} ${index}`;
    const sentinel = `Synthetic Claude file for PR 130115: ${store.label} ${index}.`;
    const common = { sessionId: threadId, entrypoint: "cli", cwd: path.join(spec.home, `workspace-${store.label}`),
      timestamp: new Date().toISOString(), isSidechain: false };
    const rows = [
      { ...common, uuid: randomUUID(), type: "user", message: { role: "user", content: sentinel } },
      { ...common, uuid: randomUUID(), type: "assistant", message: { role: "assistant",
        content: [{ type: "text", text: "Synthetic parser input; no Claude CLI or external model was run." }] } },
      { type: "custom-title", sessionId: threadId, customTitle: title },
    ];
    const file = path.join(project, `${threadId}.jsonl`);
    const bytes = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(file, bytes, { flag: "wx" });
    fixtures.push({ catalogId: "claude", owner: store.label, root: store.root, threadId, title, sentinel, file,
      sha256: createHash("sha256").update(bytes).digest("hex") });
  }
}
await writeFile(path.join(spec.output, "claude-inputs.json"), JSON.stringify({ fixtures,
  status: "synthetic_files_prepared", sessionIdsAreSynthetic: true,
  claudeCLIExecuted: false, parserOrCatalogVerified: false }, null, 2));
