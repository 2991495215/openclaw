// Tests safe executable detection for shell command approval.
import { describe, expect, it } from "vitest";
import {
  listRiskyConfiguredSafeBins,
  validateSafeBinSemantics,
} from "./exec-safe-bin-semantics.js";

describe("exec safe-bin semantics", () => {
  it("rejects jq programs even when configured via path-like entries", () => {
    expect(validateSafeBinSemantics("jq")).toBe(false);
    expect(validateSafeBinSemantics("/usr/local/bin/jq")).toBe(false);
  });

  it("rejects awk and sed variants even when configured via path-like entries", () => {
    expect(validateSafeBinSemantics("/opt/homebrew/bin/gawk")).toBe(false);
    expect(validateSafeBinSemantics("C:\\Tools\\mawk.exe")).toBe(false);
    expect(validateSafeBinSemantics("nawk")).toBe(false);
    expect(validateSafeBinSemantics("/usr/local/bin/gsed")).toBe(false);
  });

  it("reports normalized risky configured safe bins once per executable family member", () => {
    expect(
      listRiskyConfiguredSafeBins([
        " Awk ",
        "/opt/homebrew/bin/gawk",
        "C:\\Tools\\mawk.exe",
        "nawk",
        "sed",
        "/usr/local/bin/gsed",
        "jq",
        "jq",
      ]),
    ).toEqual([
      {
        bin: "awk",
        warning:
          "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "gawk",
        warning:
          "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "gsed",
        warning:
          "sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "jq",
        warning:
          "jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "mawk",
        warning:
          "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "nawk",
        warning:
          "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "sed",
        warning:
          "sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
    ]);
  });
});
