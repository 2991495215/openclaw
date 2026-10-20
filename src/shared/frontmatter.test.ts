// Frontmatter tests cover shared Markdown frontmatter parsing helpers.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, test } from "vitest";
import {
  applyOpenClawManifestInstallCommonFields,
  parseFrontmatterBool,
  parseOpenClawManifestInstallBase,
  resolveOpenClawManifestBlock,
  resolveOpenClawManifestCommonFields,
} from "./frontmatter.js";

describe("shared/frontmatter", () => {
  test("parseFrontmatterBool respects explicit values and fallback", () => {
    expect(parseFrontmatterBool("true", false)).toBe(true);
    expect(parseFrontmatterBool("false", true)).toBe(false);
    expect(parseFrontmatterBool(undefined, true)).toBe(true);
    expect(parseFrontmatterBool("maybe", false)).toBe(false);
  });

  test("resolveOpenClawManifestBlock returns undefined for invalid input", () => {
    expect(resolveOpenClawManifestBlock({ frontmatter: {} })).toBeUndefined();
    expect(
      resolveOpenClawManifestBlock({ frontmatter: { metadata: "not-json5" } }),
    ).toBeUndefined();
    expect(resolveOpenClawManifestBlock({ frontmatter: { metadata: "123" } })).toBeUndefined();
    expect(resolveOpenClawManifestBlock({ frontmatter: { metadata: "[]" } })).toBeUndefined();
    expect(
      resolveOpenClawManifestBlock({ frontmatter: { metadata: "{ nope: { a: 1 } }" } }),
    ).toBeUndefined();
  });

  it("normalizes manifest common fields without changing authored string values", () => {
    expect(
      resolveOpenClawManifestCommonFields(
        {
          always: false,
          emoji: " ",
          homepage: "",
          os: [" darwin ", "linux", ""],
          requires: {
            bins: "bun, node",
            anyBins: [" ffmpeg ", ""],
            env: ["OPENCLAW_TOKEN", " OPENCLAW_URL "],
            config: null,
          },
        },
        () => undefined,
      ),
    ).toEqual({
      always: false,
      emoji: " ",
      homepage: "",
      os: ["darwin", "linux"],
      requires: {
        bins: ["bun", "node"],
        anyBins: ["ffmpeg"],
        env: ["OPENCLAW_TOKEN", "OPENCLAW_URL"],
        config: [],
      },
      install: undefined,
    });
    expect(
      resolveOpenClawManifestCommonFields(
        { always: "false", emoji: 1, homepage: null, os: [], install: {} },
        () => undefined,
      ),
    ).toEqual({
      always: undefined,
      emoji: undefined,
      homepage: undefined,
      os: undefined,
      requires: undefined,
      install: undefined,
    });
  });

  it("parses and applies install common fields", () => {
    const parsed = parseOpenClawManifestInstallBase(
      {
        type: " Brew ",
        id: "brew.git",
        label: "Git",
        bins: [" git ", "git"],
      },
      ["brew", "npm"],
    );

    expect(parsed).toEqual({
      raw: {
        type: " Brew ",
        id: "brew.git",
        label: "Git",
        bins: [" git ", "git"],
      },
      kind: "brew",
      id: "brew.git",
      label: "Git",
      bins: ["git", "git"],
    });
    expect(parseOpenClawManifestInstallBase({ kind: "bad" }, ["brew"])).toBeUndefined();
    expect(
      applyOpenClawManifestInstallCommonFields<{
        extra: boolean;
        id?: string;
        label?: string;
        bins?: string[];
      }>({ extra: true }, expectDefined(parsed, "manifest install base")),
    ).toEqual({
      extra: true,
      id: "brew.git",
      label: "Git",
      bins: ["git", "git"],
    });
  });

  it("prefers explicit kind, ignores invalid common fields, and leaves missing ones untouched", () => {
    const parsed = parseOpenClawManifestInstallBase(
      {
        kind: " npm ",
        type: "brew",
        id: 42,
        label: null,
        bins: [" ", ""],
      },
      ["brew", "npm"],
    );

    expect(parsed).toEqual({
      raw: {
        kind: " npm ",
        type: "brew",
        id: 42,
        label: null,
        bins: [" ", ""],
      },
      kind: "npm",
    });
    expect(
      applyOpenClawManifestInstallCommonFields(
        { id: "keep", label: "Keep", bins: ["bun"] },
        parsed!,
      ),
    ).toEqual({
      id: "keep",
      label: "Keep",
      bins: ["bun"],
    });
  });

  it("maps install entries through the parser and filters rejected specs", () => {
    expect(
      resolveOpenClawManifestCommonFields(
        {
          install: [{ id: "keep" }, { id: "drop" }, "bad"],
        },
        (entry) => {
          if (
            typeof entry === "object" &&
            entry !== null &&
            (entry as { id?: string }).id === "keep"
          ) {
            return { id: "keep" };
          }
          return undefined;
        },
      ).install,
    ).toEqual([{ id: "keep" }]);
  });
});
