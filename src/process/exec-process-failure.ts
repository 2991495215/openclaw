export type ExecProcessFailureKind =
  | "shell-command-not-found"
  | "shell-not-executable"
  | "overall-timeout"
  | "no-output-timeout"
  | "signal"
  | "aborted"
  | "runtime-error";
