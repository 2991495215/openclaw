import { expect, test } from "vitest";
import {
  extractShellCommandFromArgv,
  formatExecCommand,
  resolveSystemRunCommandRequest,
} from "./system-run-command.js";

test("formats command arguments without losing whitespace", () => {
  expect(formatExecCommand(["echo", "hi there"])).toBe('echo "hi there"');
  expect(formatExecCommand(["runner "])).toBe('"runner "');
});

test.each([
  { argv: ["busybox", "sh", "-c", "echo hi"], expected: "echo hi" },
  { argv: ["bash", "script.sh"], expected: null },
])("extracts the shell payload for $argv", ({ argv, expected }) => {
  expect(extractShellCommandFromArgv(argv)).toBe(expected);
});

test("keeps rawless sh -lc fail-closed", () => {
  expect(extractShellCommandFromArgv(["/bin/sh", "-lc", "echo hi"])).toBeNull();
});

test.each([
  { command: ["nu", "--EXECUTE=echo"], shellPayload: "echo", previewText: "echo" },
  { command: ["nu", "--EXECUTE", "echo"], shellPayload: null, previewText: null },
  { command: ["nu", "--execute =echo", "tail"], shellPayload: "echo", previewText: "echo" },
  { command: ["nu", "", "--execute", "echo", "tail"], shellPayload: "echo", previewText: "echo" },
  { command: ["nu", "-c", "first", "--", "tail"], shellPayload: "first", previewText: "first" },
  { command: ["nu", "--", "--execute=echo"], shellPayload: null, previewText: null },
  { command: ["nu", "--execute=   ", "-c", "later"], shellPayload: null, previewText: null },
  {
    command: ["nu", "-c", "first", "--execute=second", "tail"],
    shellPayload: "second",
    previewText: null,
  },
])(
  "preserves Nushell payload and preview binding for $command",
  ({ command, shellPayload, previewText }) => {
    expect(resolveSystemRunCommandRequest({ command })).toMatchObject({
      ok: true,
      shellPayload,
      previewText,
    });
    const bound = resolveSystemRunCommandRequest({ command, rawCommand: shellPayload ?? "echo" });
    expect(bound).toMatchObject(
      previewText === null
        ? { ok: false, details: { code: "RAW_COMMAND_MISMATCH" } }
        : { ok: true, shellPayload, previewText },
    );
  },
);

test("normalizes non-string argv and empty requests", () => {
  expect(resolveSystemRunCommandRequest({})).toMatchObject({
    ok: true,
    argv: [],
    commandText: "",
  });
  expect(resolveSystemRunCommandRequest({ command: ["echo", 123, false, null] })).toMatchObject({
    ok: true,
    argv: ["echo", "123", "false", "null"],
    commandText: "echo 123 false null",
  });
});

test.each`
  name                          | command                                                                              | rawCommand
  ${"cmd trailing arguments"}   | ${["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"]}                             | ${"echo"}
  ${"shell positional argv"}    | ${["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"]}                    | ${'$0 "$1"'}
  ${"opaque positional argv"}   | ${["tcsh", "-c", "source $argv[1]", "/tmp/evil.csh"]}                                | ${"source $argv[1]"}
  ${"environment prelude"}      | ${["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo hi"]}            | ${"echo hi"}
  ${"interactive bash"}         | ${["/bin/bash", "-i", "-c", "/usr/bin/printf ok"]}                                   | ${"/usr/bin/printf ok"}
  ${"interactive nushell"}      | ${["nu", "--interactive", "--execute", "/usr/bin/printf ok"]}                        | ${"/usr/bin/printf ok"}
  ${"attached nushell execute"} | ${["nu", "--interactive", "--execute=/usr/bin/printf ok"]}                           | ${"/usr/bin/printf ok"}
  ${"fish init command"}        | ${["/usr/bin/fish", "--init-command=/tmp/payload.fish", "-c", "/usr/bin/printf ok"]} | ${"/usr/bin/printf ok"}
`("rejects $name approval-display mismatch", ({ command, rawCommand }) => {
  expect(resolveSystemRunCommandRequest({ command, rawCommand })).toMatchObject({
    ok: false,
    message: expect.stringContaining("rawCommand does not match command"),
    details: { code: "RAW_COMMAND_MISMATCH" },
  });
});

test("keeps PowerShell command-with-args payloads bound", () => {
  expect(
    resolveSystemRunCommandRequest({
      command: ["pwsh", "-cwa", "Write-Output", "hi"],
      rawCommand: "Write-Output hi",
    }),
  ).toMatchObject({
    ok: true,
    shellPayload: "Write-Output hi",
    previewText: "Write-Output hi",
  });
});
