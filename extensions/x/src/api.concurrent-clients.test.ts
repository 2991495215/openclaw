import { expect, it } from "vitest";
import { createXApiClient, type XUser } from "./test-support/api.js";
import { createXTestSpend } from "./test-support/spend.js";

it("keeps interleaved client authentication and paid results isolated at native dispatch", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = createXApiClient({
    spend: createXTestSpend(),
    clientId: "first",
    clientSecret: "synthetic",
    refreshToken: "first-seed",
    saveRefreshToken: async () => {},
    fetch: async (url, init) => {
      if (url.endsWith("/oauth2/token")) {
        expect(
          new URLSearchParams(await new Response(init?.body).text()).get("refresh_token"),
        ).toBe("first-seed");
        entered.resolve();
        await release.promise;
        return Response.json({ access_token: "first-access" });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer first-access");
      return Response.json({ data: [{ id: "11", username: "first" }] });
    },
  });
  const second = createXApiClient({
    spend: createXTestSpend(),
    clientId: "second",
    clientSecret: "synthetic",
    refreshToken: "second-seed",
    saveRefreshToken: async () => {},
    fetch: async (url, init) => {
      if (url.endsWith("/oauth2/token")) {
        expect(
          new URLSearchParams(await new Response(init?.body).text()).get("refresh_token"),
        ).toBe("second-seed");
        return Response.json({ access_token: "second-access" });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer second-access");
      return Response.json({
        data: [
          { id: "22", username: "second" },
          { id: "23", username: "other" },
        ],
      });
    },
  });
  const firstRequest = first.getUsersByUsernames(["first"]);
  await entered.promise;
  let firstResult: XUser[] | undefined;
  try {
    await expect(second.getUsersByUsernames(["second", "other"])).resolves.toEqual([
      { id: "22", username: "second" },
      { id: "23", username: "other" },
    ]);
  } finally {
    release.resolve();
    firstResult = await firstRequest;
  }
  expect(firstResult).toEqual([{ id: "11", username: "first" }]);
  expect(await first.spend.status()).toMatchObject({ dayUsd: 0.01, cycleUsd: 0.01 });
  expect(await second.spend.status()).toMatchObject({ dayUsd: 0.02, cycleUsd: 0.02 });
});
