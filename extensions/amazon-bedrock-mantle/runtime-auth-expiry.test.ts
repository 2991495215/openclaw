import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { MANTLE_IAM_TOKEN_MARKER } from "./api.js";
import bedrockMantlePlugin from "./index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("refreshes runtime bearer auth when the signing IAM session expires before two hours", async () => {
  const dir = tempDirs.make("mantle-runtime-expiry-");
  const credentialsFile = path.join(dir, "credentials");
  const configFile = path.join(dir, "config");
  await writeFile(credentialsFile, "");
  await writeFile(configFile, "");
  for (const name of Object.keys(process.env).filter((key) => key.startsWith("AWS_"))) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("AWS_CONFIG_FILE", configFile);
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsFile);
  vi.stubEnv("AWS_REGION", "us-east-1");
  const now = Date.now();
  const firstSessionExpiry = now + 3_600_000;
  let generation = "A";
  let credentialRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/latest/api/token") {
      res.end("synthetic-token");
    } else if (req.url === "/latest/meta-data/iam/security-credentials/") {
      res.end("synthetic-role");
    } else if (req.url === "/latest/meta-data/iam/security-credentials/synthetic-role") {
      credentialRequests++;
      res.end(
        JSON.stringify({
          Code: "Success",
          AccessKeyId: `TEST_${generation}`,
          SecretAccessKey: "synthetic-secret",
          Token: `synthetic-session-${generation}`,
          Expiration: new Date(
            generation === "A" ? firstSessionExpiry : now + 14_400_000,
          ).toISOString(),
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback listener");
    }
    vi.stubEnv("AWS_EC2_METADATA_SERVICE_ENDPOINT", `http://127.0.0.1:${address.port}`);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    const prepare = provider.prepareRuntimeAuth;
    if (!prepare) {
      throw new Error("Runtime auth registration missing");
    }
    const model = {
      id: "openai.gpt-oss-120b",
      name: "GPT-OSS",
      provider: "amazon-bedrock-mantle",
      api: "openai-completions",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4096,
    } satisfies Parameters<typeof prepare>[0]["model"];
    const resolve = () =>
      prepare({
        provider: model.provider,
        modelId: model.id,
        model,
        apiKey: MANTLE_IAM_TOKEN_MARKER,
        authMode: "aws-sdk",
        env: { AWS_REGION: "us-east-1" },
      });
    const signingCredential = (token: string | undefined) => {
      expect(token).toMatch(/^bedrock-api-key-/);
      const signed = Buffer.from(token?.slice("bedrock-api-key-".length) ?? "", "base64").toString(
        "utf8",
      );
      return new URL(`https://${signed}`).searchParams.get("X-Amz-Credential")?.split("/")[0];
    };
    const first = await resolve();
    expect(signingCredential(first?.apiKey)).toBe("TEST_A");
    expect.soft(first?.expiresAt).toBeLessThanOrEqual(firstSessionExpiry);
    generation = "B";
    vi.setSystemTime(now + 3_660_000);
    const second = await resolve();
    expect.soft(signingCredential(second?.apiKey)).toBe("TEST_B");
    expect(credentialRequests).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
