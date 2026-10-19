import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSingleSkillDirectory, type LocalSkillLoadDiagnostic } from "./local-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeRawSkill(dir: string, raw: string, filename = "SKILL.md") {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, raw, "utf-8");
  return filePath;
}

it("keeps cached content isolated from caller mutations, paths and read limits", async () => {
  const root = tempDirs.make("openclaw-skill-content-cache-");
  const raw = "---\ndescription: Cached instructions\n---\nInstructions without a heading.";
  for (const name of ["first-copy", "second-copy"]) {
    const dir = path.join(root, name);
    await writeRawSkill(dir, raw);
  }
  const firstParams = {
    skillDir: path.join(root, "first-copy"),
    rootRealPath: await fs.realpath(root),
    source: "openclaw-bundled",
  };
  const first = loadSingleSkillDirectory(firstParams)!;
  const hash = first.skill.contentHash;
  first.frontmatter.description = "Caller mutation";
  first.skill.description = "Caller mutation";
  first.skill.sourceInfo.scope = "temporary";
  expect(loadSingleSkillDirectory({ ...firstParams, maxBytes: 1 })).toBeNull();

  const skillDir = path.join(root, "second-copy");
  const second = loadSingleSkillDirectory({
    ...firstParams,
    skillDir,
    source: "openclaw-workspace",
  });
  expect(second?.frontmatter.description).toBe("Cached instructions");
  expect(second?.skill).toMatchObject({
    name: "second-copy",
    displayName: "Second Copy",
    description: "Cached instructions",
    contentHash: hash,
    filePath: path.join(skillDir, "SKILL.md"),
    baseDir: skillDir,
    source: "openclaw-workspace",
    sourceInfo: {
      path: path.join(skillDir, "SKILL.md"),
      baseDir: skillDir,
      source: "openclaw-workspace",
      scope: "project",
    },
  });
});

it("materializes trimmed workspace names, metadata, titles and invocation policy", async () => {
  const root = tempDirs.make("openclaw-skill-materialization-");
  const skillDir = path.join(root, " padded-name");
  const filePath = await writeRawSkill(
    skillDir,
    '---\ndescription: "  Padded metadata.  "\ndisable-model-invocation: true\n---\n# Shared Title\n',
  );
  const diagnostics: LocalSkillLoadDiagnostic[] = [];
  const local = loadSingleSkillDirectory({
    skillDir,
    source: "workspace",
    rootRealPath: await fs.realpath(skillDir),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  expect(local?.skill).toEqual({
    name: "padded-name",
    displayName: "Shared Title",
    description: "Padded metadata.",
    contentHash: "3967fcab002170698ce185c9e5fc82383f80b925f3888d6e5cc94cad47cef2d1",
    filePath,
    baseDir: skillDir,
    disableModelInvocation: true,
    source: "workspace",
    sourceInfo: {
      path: filePath,
      baseDir: skillDir,
      origin: "top-level",
      source: "workspace",
      scope: "project",
    },
  });
  expect(diagnostics).toEqual([]);
});
