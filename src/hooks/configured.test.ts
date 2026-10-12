// Configured hook tests cover the closed allowlist and open discovery decisions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInternalHookSelection } from "./configured.js";

const readConfigMachineStateMock = vi.hoisted(() => vi.fn());

vi.mock("../state/config-machine-state-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/config-machine-state-async.js")>()),
  readConfigMachineStateAsync: readConfigMachineStateMock,
}));

describe("resolveInternalHookSelection", () => {
  beforeEach(() => {
    readConfigMachineStateMock.mockReset();
    readConfigMachineStateMock.mockReturnValue(undefined);
  });

  it("keeps CLI-shaped named entries closed when the master flag is enabled", async () => {
    expect(
      (
        await resolveInternalHookSelection({
          hooks: {
            internal: {
              enabled: true,
              entries: {
                enabled: { enabled: true },
                disabled: { enabled: false },
              },
            },
          },
        })
      ).names,
    ).toEqual(new Set(["enabled"]));

    expect(
      (
        await resolveInternalHookSelection({
          hooks: {
            internal: {
              enabled: true,
              entries: { disabled: { enabled: false } },
            },
          },
        })
      ).names,
    ).toEqual(new Set());
  });

  it("uses declared install hook names as an allowlist", async () => {
    readConfigMachineStateMock.mockReturnValue({
      pack: { source: "path", hooks: ["installed-one", "installed-two"] },
    });

    expect((await resolveInternalHookSelection({})).names).toEqual(
      new Set(["installed-one", "installed-two"]),
    );
  });

  it("keeps installs with unknown dynamic hook names open-ended", async () => {
    readConfigMachineStateMock.mockReturnValue({ pack: { source: "path" } });

    expect((await resolveInternalHookSelection({})).names).toBeNull();
  });
});
