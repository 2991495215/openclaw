// Tests OpenClaw execution environment construction.
import { describe, expect, it } from "vitest";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  ensureOpenClawExecMarkerOnProcess,
  markOpenClawExecEnv,
  OPENCLAW_CLI_ENV_VAR,
} from "./openclaw-exec-env.js";

const OPENCLAW_CLI_ENV_VALUE = "1";

describe("markOpenClawExecEnv", () => {
  it("returns a cloned env object with the exec marker set", () => {
    const env = { PATH: "/usr/bin", OPENCLAW_CLI: "0" };
    const marked = markOpenClawExecEnv(env);

    expect(marked).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
    });
    expect(marked).not.toBe(env);
    expect(env.OPENCLAW_CLI).toBe("0");
  });
});

describe("ensureOpenClawExecMarkerOnProcess", () => {
  it.each([undefined, "0"])("sets the process marker from %s", (initial) => {
    const previous = process.env[OPENCLAW_CLI_ENV_VAR];
    if (initial === undefined) {
      deleteTestEnvValue(OPENCLAW_CLI_ENV_VAR);
    } else {
      setTestEnvValue(OPENCLAW_CLI_ENV_VAR, initial);
    }

    try {
      ensureOpenClawExecMarkerOnProcess();
      expect(process.env[OPENCLAW_CLI_ENV_VAR]).toBe(OPENCLAW_CLI_ENV_VALUE);
    } finally {
      if (previous === undefined) {
        deleteTestEnvValue(OPENCLAW_CLI_ENV_VAR);
      } else {
        setTestEnvValue(OPENCLAW_CLI_ENV_VAR, previous);
      }
    }
  });
});
