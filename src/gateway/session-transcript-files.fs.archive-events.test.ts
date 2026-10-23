import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSessionTranscriptsDetailed } from "./session-transcript-files.fs.js";

let tmpDir: string;
let sessionFile: string;
const sessionId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-")));
  sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.chmodSync(tmpDir, 0o755);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function archive() {
  return archiveSessionTranscriptsDetailed({
    sessionId,
    sessionFile,
    storePath: path.join(tmpDir, "store.json"),
    agentId: "main",
    reason: "reset",
  });
}

describe("archiveSessionTranscriptsDetailed failure surface", () => {
  it("retains the original transcript when fs.renameSync fails", () => {
    const renameError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw renameError;
    });

    const archived = archive();

    renameSpy.mockRestore();

    expect(archived).toEqual([]);
    expect(fs.existsSync(sessionFile)).toBe(true);
  });

  it("archives an available transcript", () => {
    const archived = archive();

    expect(archived.length).toBe(1);
    const { archivedPath } = expectDefined(archived[0], "archived[0] test invariant");
    expect(archivedPath).toContain(".jsonl.reset.");
    expect(fs.existsSync(archivedPath)).toBe(true);
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("retains the original transcript when directory permissions prevent archiving", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }

    fs.chmodSync(tmpDir, 0o555);

    let archived: ReturnType<typeof archiveSessionTranscriptsDetailed> = [];
    try {
      archived = archive();
    } finally {
      fs.chmodSync(tmpDir, 0o755);
    }

    expect(archived).toEqual([]);
    expect(fs.existsSync(sessionFile)).toBe(true);
  });
});
