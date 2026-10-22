// Verifies exec approval allowlist pattern parsing and matching.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { matchAllowlist } from "./exec-command-resolution.js";

function matchesAllowedPath(pattern: string, target: string): boolean {
  return (
    matchAllowlist([{ pattern }], {
      kind: "executable",
      rawExecutable: target,
      resolvedPath: target,
      executableName: path.basename(target),
    }) !== null
  );
}

describe("exec allowlist path patterns", () => {
  it.each([{ pattern: "   ", target: "/tmp/tool", expected: false }])(
    "handles literal patterns for %j",
    ({ pattern, target, expected }) => {
      expect(matchesAllowedPath(pattern, target)).toBe(expected);
    },
  );

  it("does not let ? cross path separators", () => {
    expect(matchesAllowedPath("/tmp/a?b", "/tmp/a/b")).toBe(false);
    expect(matchesAllowedPath("/tmp/a?b", "/tmp/acb")).toBe(true);
  });

  it("expands home-prefix patterns", () => {
    const openClawHome = path.join(path.resolve("/srv/openclaw-home"), "bin", "tool");
    const fallbackHome = path.join(path.resolve("/home/other"), "bin", "tool");
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      expect(matchesAllowedPath("~/bin/tool", openClawHome)).toBe(true);
      expect(matchesAllowedPath("~/bin/tool", fallbackHome)).toBe(false);
    });
  });

  it.runIf(process.platform === "darwin")("matches macOS /private/var temp aliases", () => {
    expect(
      matchesAllowedPath("/var/folders/example/bin/tool", "/private/var/folders/example/bin/tool"),
    ).toBe(true);
    expect(
      matchesAllowedPath("/private/var/folders/example/bin/tool", "/var/folders/example/bin/tool"),
    ).toBe(true);
  });

  it.runIf(process.platform === "win32")("preserves case-insensitive matching on Windows", () => {
    expect(matchesAllowedPath("C:/Tools/Allowed-Tool", "c:/tools/allowed-tool")).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "matches Windows wildcard paths after collapsing dot segments",
    () => {
      expect(matchesAllowedPath("C:/Tools/**", "C:/Tools/../../Windows/System32/cmd.exe")).toBe(
        false,
      );
      expect(matchesAllowedPath("C:/Tools/**", String.raw`..\..\Windows\cmd.exe`)).toBe(false);
      expect(matchesAllowedPath("C:/Tools/**", "C:/Tools/bin/../runner.exe")).toBe(true);
    },
  );
});
