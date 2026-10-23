import * as childProcess from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

it(
  "boots the built candidate with a published updater's occupied sandbox port, then reaps it",
  { timeout: 330_000 },
  async () => {
    const stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "canary-boundary-")),
    );
    const spawned = vi.mocked(childProcess.spawn);
    spawned.mockClear();
    const occupied = createServer();
    const spawn = spawned.getMockImplementation()!;
    const probes: string[] = [];
    const nativeFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      probes.push(new URL(input instanceof Request ? input.url : input).pathname);
      return nativeFetch(input, init);
    });
    let gatewayStderr = "";
    try {
      occupied.listen(0, "127.0.0.1");
      await once(occupied, "listening");
      const address = occupied.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an occupied TCP listener");
      }
      const config: OpenClawConfig = {
        gateway: { mode: "local" },
        mcp: { apps: { enabled: true, sandboxPort: address.port } },
      };
      spawned.mockImplementation((...args) => {
        if (Array.isArray(args[1]) && args[1].includes("--update-canary")) {
          // Published updaters retain this setting and only supply --update-canary.
          const configPath = args[2]?.env?.OPENCLAW_CONFIG_PATH;
          if (!configPath) {
            throw new Error("Missing candidate config path");
          }
          const copied: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
          writeFileSync(configPath, JSON.stringify({ ...copied, mcp: config.mcp }));
        }
        const child = spawn(...args);
        if (Array.isArray(args[1]) && args[1].includes("--update-canary")) {
          child.stderr?.on("data", (chunk: Buffer | string) => {
            gatewayStderr += String(chunk);
          });
        }
        return child;
      });
      const result = await validateUpdateCandidateCanary({
        root: process.cwd(),
        stateDir,
        config,
        env: { PATH: process.env.PATH },
        timeoutMs: 300_000,
      });
      expect(result).toMatchObject({ status: "ok", phase: "readiness" });
      expect(probes).toContain("/startupz");
      expect(probes).toContain("/readyz");
      expect(probes.indexOf("/startupz")).toBeLessThan(probes.indexOf("/readyz"));
      expect(gatewayStderr).toContain("openclaw-update-canary-progress: ");
      expect(occupied.listening).toBe(true);
      expect(await fs.readdir(stateDir)).toEqual([]);
      const callIndex = spawned.mock.calls.findIndex(
        ([, args]) => Array.isArray(args) && args.includes("--update-canary"),
      );
      const gateway = spawned.mock.results[callIndex]?.value as childProcess.ChildProcess;
      expect(gateway.pid).toBeGreaterThan(0);
      expect(() =>
        process.kill(process.platform === "win32" ? gateway.pid! : -gateway.pid!, 0),
      ).toThrow();
      const options = spawned.mock.calls[callIndex]?.[2] as childProcess.SpawnOptions;
      await expect(fs.access(options.env!.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      fetchSpy.mockRestore();
      if (occupied.listening) {
        await new Promise<void>((resolve, reject) => {
          occupied.close((error) => (error ? reject(error) : resolve()));
        });
      }
      spawned.mockImplementation(spawn).mockClear();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  },
);
