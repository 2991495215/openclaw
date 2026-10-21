/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { AppsPage } from "./apps-page.tsx";

vi.mock("../../app/lazy-custom-element.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/lazy-custom-element.ts")>()),
  ensureCustomElementDefined: vi.fn(),
}));

beforeEach(() => vi.mocked(ensureCustomElementDefined).mockReset());

function mountApps() {
  const [search, setSearch] = createSignal("?server=parts&tool=library");
  const { gateway, publish } = createApplicationGateway();
  const request = createGatewayRequestMock(async () => ({
    servers: [
      {
        serverName: "parts",
        label: "Parts library",
        entrypoints: [
          {
            title: "Library",
            toolName: "library",
            resourceUri: "ui://parts/library",
            entrypoint: { type: "global" },
          },
        ],
      },
    ],
  }));
  publish({
    ...gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    sessionKey: "agent:main:one",
    hello: gatewayHelloForMethods(["mcp.app.discover"]),
  });
  // The fixture supplies the discovery, navigation and selection capabilities used here.
  const context = {
    gateway,
    navigate: vi.fn(),
    agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    sessions: { describe: async () => ({ session: { key: "agent:main:one" } }) },
  } as unknown as ApplicationContext;
  const mounted = mountSolid(() => <AppsPage appSearch={search()} />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  return { ...mounted, setSearch };
}

it("waits for the conversation registration and retries a failed import", async () => {
  const first = createDeferred();
  const retry = createDeferred();
  vi.mocked(ensureCustomElementDefined)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(retry.promise);
  const mounted = mountApps();
  const { container } = mounted;
  await waitForSolid(() => expect(ensureCustomElementDefined).toHaveBeenCalledOnce());
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");
  expect(container.querySelector("openclaw-chat-pane")).toBeNull();

  first.reject(new Error("Conversation download failed"));
  await waitForSolid(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Conversation download failed",
    ),
  );
  mounted.getByRole("button", { name: "Try again" }).click();
  await waitForSolid(() => expect(ensureCustomElementDefined).toHaveBeenCalledTimes(2));
  expect(container.querySelector("openclaw-chat-pane")).toBeNull();
  retry.resolve();
  await waitForSolid(() =>
    expect(container.querySelector("openclaw-chat-pane")?.mcpAppLaunch).toMatchObject({
      sessionKey: "agent:main:one",
      serverName: "parts",
    }),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("retires a failed registration when the app route closes", async () => {
  const first = createDeferred();
  vi.mocked(ensureCustomElementDefined)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(undefined);
  const { container, setSearch } = mountApps();
  await waitForSolid(() => expect(ensureCustomElementDefined).toHaveBeenCalledOnce());
  setSearch("");
  await waitForSolid(() => expect(container.querySelector(".apps-page")).not.toBeNull());
  first.reject(new Error("Retired conversation download"));
  await waitForSolid(() =>
    expect(container.textContent).not.toContain("Retired conversation download"),
  );
  setSearch("?server=parts&tool=library");
  await waitForSolid(() => expect(container.querySelector("openclaw-chat-pane")).not.toBeNull());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
