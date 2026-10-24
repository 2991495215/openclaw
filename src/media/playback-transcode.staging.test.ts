import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observePlaybackSourceOpen,
  usePlaybackFixture,
  waitForPlaybackSourceCleanup,
} from "./playback-transcode.test-support.js";

const { runFfmpeg, playbackWarn } = vi.hoisted(() => ({
  runFfmpeg: vi.fn(),
  playbackWarn: vi.fn(),
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      return args[0] === "media/playback" ? { ...logger, warn: playbackWarn } : logger;
    },
  };
});
vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return {
    ...actual,
    openLocalFileSafely: (...args: Parameters<typeof actual.openLocalFileSafely>) =>
      observePlaybackSourceOpen(actual.openLocalFileSafely(...args)),
  };
});

vi.mock("./ffmpeg-exec.js", () => ({ runFfmpeg }));
vi.mock("./media-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-probe.js")>()),
  probePlaybackMediaFileDescriptor: vi.fn(async () => ({
    durationMs: 1000,
    audioCodec: "pcm_s16le",
    audioStreamIndex: 0,
  })),
}));

const fixture = usePlaybackFixture("openclaw-playback-staging-", [
  "./ffmpeg-exec.js",
  "./media-probe.js",
  "../infra/fs-safe.js",
  "../logging/subsystem.js",
]);
const { resolveTranscode, resolveMetadata } = fixture;

let quarantine: string | undefined;
afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  await waitForPlaybackSourceCleanup();
  if (quarantine) {
    await fs.rm(quarantine, { recursive: true, force: true });
  }
  quarantine = undefined;
});

beforeEach(() => {
  runFfmpeg.mockReset();
  playbackWarn.mockReset();
});

async function createSource(
  fileName: string,
  contents: Parameters<typeof fixture.createSource>[1] = "stable-source",
) {
  return {
    ...(await fixture.createSource(fileName, contents)),
    mimeType: "audio/x-caf",
    kind: "audio" as const,
  };
}

async function transcode(source: Awaited<ReturnType<typeof createSource>>) {
  expect(await resolveTranscode(source)).toEqual({ kind: "preparing" });
  await waitForPlaybackSourceCleanup();
  return await resolveTranscode(source);
}

describe("playback input staging", () => {
  it("passes every staged input byte to ffmpeg before publishing the rendition", async () => {
    const contents = Buffer.alloc(1024 * 1024 + 19).map((_, index) => index % 251);
    const source = await createSource("complete-input.caf", contents);
    let inputPath: string | undefined;
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      inputPath = args[args.indexOf("-i") + 1];
      expect(inputPath).toBeDefined();
      expect(await fs.readFile(inputPath!), "complete staged ffmpeg input").toEqual(contents);
      await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
      return "";
    });
    await transcode(source);
    expect(runFfmpeg).toHaveBeenCalledOnce();
    expect(await resolveTranscode(source)).toMatchObject({
      kind: "transcoded",
      contentType: "audio/mp4",
    });
    await expect(fs.stat(inputPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["grow", "truncate", "rewrite", "replace"] as const)(
    "falls back when the source changes after open via %s before starting ffmpeg",
    async (change) => {
      const source = await createSource(`changed-${change}.caf`);
      await expect(resolveMetadata(source)).resolves.toMatchObject({
        playback: "transcode",
      });
      let changed = false;
      __setFsSafeTestHooksForTest({
        afterOpenedPathIdentityCheck: async (filePath) => {
          if (filePath !== source.sourcePath || changed) {
            return;
          }
          changed = true;
          if (change === "grow") {
            await fs.appendFile(filePath, "growth");
          } else if (change === "truncate") {
            await fs.truncate(filePath, 1);
          } else if (change === "rewrite") {
            const beforeRewrite = await fs.stat(filePath);
            await fs.writeFile(filePath, "edited-source");
            await fs.utimes(
              filePath,
              beforeRewrite.atime,
              new Date(source.sourceStat.mtimeMs + 2000),
            );
            expect((await fs.stat(filePath)).mtimeMs).not.toBe(source.sourceStat.mtimeMs);
          } else {
            await fs.rename(filePath, `${filePath}.old`);
            await fs.writeFile(filePath, "stable-source");
          }
        },
      });
      await expect(transcode(source)).resolves.toEqual({ kind: "fallback" });
      expect(playbackWarn).toHaveBeenCalledWith(
        expect.stringMatching(change === "grow" ? /exceeds limit/ : /changed|mismatch/),
      );
      expect(changed).toBe(true);
      expect(runFfmpeg).not.toHaveBeenCalled();
      expect(await resolveTranscode(source)).toEqual({ kind: "fallback" });
    },
  );

  it("does not publish a cache entry when workspace cleanup fails", async () => {
    const source = await createSource("cleanup-failed.caf");
    const cleanupError = new Error("synthetic workspace cleanup failure");
    __setFsSafeTestHooksForTest({
      beforeTempWorkspaceNativeRemoval: (target) => {
        quarantine = target;
        throw cleanupError;
      },
    });
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
      return "";
    });
    await transcode(source);
    expect(runFfmpeg).toHaveBeenCalledOnce();
    expect(playbackWarn).toHaveBeenCalledWith(expect.stringContaining(cleanupError.message));
    expect(quarantine).toBeDefined();
    expect(await resolveTranscode(source)).toEqual({ kind: "fallback" });
  });
});
