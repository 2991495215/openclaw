/**
 * Locates or downloads fd for TUI file completion.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { extractArchive } from "../../infra/archive.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { type FileLockOptions, withFileLock } from "../../infra/file-lock.js";
import { root as fsRoot, type Root, walkDirectorySync } from "../../infra/fs-safe.js";
import { cancelUnreadResponseBody } from "../../infra/http-body.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import { getBinDir } from "../config.js";
import { APP_NAME } from "../package-metadata.js";
import { readProviderJsonResponse } from "../provider-http-errors.js";

const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1_000;
const ARCHIVE_EXTRACT_TIMEOUT_MS = 60_000;
const CONTENT_LENGTH_RE = /^\d+$/;
const GITHUB_RELEASE_JSON_MAX_BYTES = 1024 * 1024;
const TOOL_INSTALL_STALE_MS =
  DOWNLOAD_TIMEOUT_MS + ARCHIVE_EXTRACT_TIMEOUT_MS + NETWORK_TIMEOUT_MS + 30_000;
const toolInstallations = new Map<string, Promise<string>>();
const TOOL_INSTALL_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    // The minimum backoff total is about 234s, beyond the full 220s install bound.
    retries: 480,
    factor: 1.2,
    minTimeout: 25,
    maxTimeout: 500,
    randomize: true,
  },
  stale: TOOL_INSTALL_STALE_MS,
  staleRecovery: "remove-if-unchanged",
};

function commandExists(cmd: string): boolean {
  try {
    const result = spawnSync(cmd, ["--version"], {
      killSignal: "SIGKILL",
      stdio: "pipe",
      timeout: 5_000,
    });
    // Require a clean exit, not just a successful spawn. An installed-but-broken
    // binary (e.g. GLIBC mismatch after a system upgrade, missing shared lib)
    // spawns fine but exits non-zero; without the status check it would be
    // misreported as available and block ensureFd's auto-install fallback.
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function getFdPath(toolsDir: string | undefined): string | null {
  if (toolsDir) {
    const localPath = join(toolsDir, platform() === "win32" ? "fd.exe" : "fd");
    if (existsSync(localPath)) {
      return localPath;
    }
  }

  for (const systemBinaryName of ["fd", "fdfind"]) {
    if (commandExists(systemBinaryName)) {
      return systemBinaryName;
    }
  }

  return null;
}

async function getLatestVersion(): Promise<string> {
  const guarded = await fetchWithSsrFGuard({
    url: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    timeoutMs: NETWORK_TIMEOUT_MS,
    auditContext: "tools-manager-release-check",
    init: {
      headers: { "User-Agent": `${APP_NAME}-coding-agent` },
    },
  });
  const { response } = guarded;

  try {
    if (!response.ok) {
      await cancelUnreadResponseBody(response);
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await readProviderJsonResponse<{ tag_name: string }>(response, "GitHub release", {
      maxBytes: GITHUB_RELEASE_JSON_MAX_BYTES,
    });
    return data.tag_name.replace(/^v/, "");
  } finally {
    await guarded.release();
  }
}

async function downloadFile(url: string, destination: Root, assetName: string): Promise<void> {
  const guarded = await fetchWithSsrFGuard({
    url,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    auditContext: "tools-manager-download",
  });
  const { response } = guarded;

  try {
    if (!response.ok) {
      await cancelUnreadResponseBody(response);
      throw new Error(`Failed to download: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const rawContentLength = response.headers.get("content-length");
    const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (rawContentLength !== null && (!contentEncoding || contentEncoding === "identity")) {
      const contentLength = rawContentLength.trim();
      if (CONTENT_LENGTH_RE.test(contentLength)) {
        const declaredBytes = Number(contentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_ARCHIVE_BYTES) {
          await cancelUnreadResponseBody(response);
          throw new Error(`Download exceeds the ${MAX_ARCHIVE_BYTES}-byte archive limit`);
        }
      }
    }

    const body = response.body;
    async function* chunks() {
      // Admit the destination before acquiring a reader; the fetch guard owns cancellation.
      yield* body.values({ preventCancel: true });
    }
    await destination.create(join(destination.rootReal, assetName), chunks(), {
      maxBytes: MAX_ARCHIVE_BYTES,
      mkdir: false,
      durable: false,
      mode: 0o666 & ~process.umask(),
    });
  } finally {
    await guarded.release();
  }
}

async function downloadFd(toolsDir: string): Promise<string> {
  const plat = platform();
  const architecture = arch();

  let version = await getLatestVersion();
  if (plat === "darwin" && architecture === "x64") {
    version = "10.3.0";
  }

  const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
  const targets: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "apple-darwin.tar.gz",
    linux: "unknown-linux-gnu.tar.gz",
    win32: "pc-windows-msvc.zip",
  };
  const target = targets[plat];
  if (!target) {
    throw new Error(`Unsupported platform: ${plat}/${architecture}`);
  }
  const assetName = `fd-v${version}-${archStr}-${target}`;

  mkdirSync(toolsDir, { recursive: true });

  const downloadUrl = `https://github.com/sharkdp/fd/releases/download/v${version}/${assetName}`;
  const binaryExt = plat === "win32" ? ".exe" : "";
  const binaryPath = join(toolsDir, "fd" + binaryExt);
  // Keep every installation's archive and extracted files together so parallel
  // processes cannot remove or overwrite another installation's staging files.
  const stagingDir = join(toolsDir, `install_tmp_fd_${process.pid}_${randomUUID()}`);
  const archivePath = join(stagingDir, assetName);
  const extractDir = join(stagingDir, "extract");
  mkdirSync(extractDir, { recursive: true });

  try {
    const stagingRoot = await fsRoot(stagingDir);
    await downloadFile(downloadUrl, stagingRoot, assetName);

    await extractArchive({
      archivePath,
      destDir: extractDir,
      timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
      limits: {
        maxArchiveBytes: MAX_ARCHIVE_BYTES,
        maxExtractedBytes: MAX_EXTRACTED_BYTES,
        maxEntries: MAX_ARCHIVE_ENTRIES,
      },
    });

    // Find the binary in extracted files. Some archives contain files directly
    // at root, others nest under a versioned subdirectory.
    const binaryFileName = "fd" + binaryExt;
    const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
    const extractedBinaryCandidates = [
      join(extractedDir, binaryFileName),
      join(extractDir, binaryFileName),
    ];
    let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

    if (!extractedBinary) {
      const { entries, failedDirs } = walkDirectorySync(extractDir, {
        symlinks: "skip",
        include: (entry) => entry.kind === "file" && entry.name === binaryFileName,
      });
      extractedBinary = entries[0]?.path;
      const failure = failedDirs[0];
      if (!extractedBinary && failure) {
        throw failure.error;
      }
    }

    if (extractedBinary) {
      renameSync(extractedBinary, binaryPath);
    } else {
      throw new Error(
        `Binary not found in archive: expected ${binaryFileName} under ${extractDir}`,
      );
    }

    if (plat !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  return binaryPath;
}

function installFd(toolsDir: string): Promise<string> {
  const binaryPath = join(toolsDir, platform() === "win32" ? "fd.exe" : "fd");
  return getOrCreatePromise(
    toolInstallations,
    binaryPath,
    () => {
      mkdirSync(toolsDir, { recursive: true });
      return withFileLock(binaryPath, TOOL_INSTALL_LOCK_OPTIONS, async () => {
        const existingPath = getFdPath(toolsDir);
        return existingPath ?? downloadFd(toolsDir);
      });
    },
    { evictOnSettled: true },
  );
}

/** Returns the existing or installed binary path, or undefined when unavailable. */
export async function ensureFd(): Promise<string | undefined> {
  const toolsDir = getBinDir();
  const existingPath = getFdPath(toolsDir);
  if (existingPath) {
    return existingPath;
  }

  // On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
  // Users must install via pkg.
  if (!toolsDir || isTruthyEnvValue(process.env.OPENCLAW_OFFLINE) || platform() === "android") {
    return undefined;
  }

  try {
    return await installFd(toolsDir);
  } catch {
    return undefined;
  }
}
