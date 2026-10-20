import type { RouteLocation } from "@openclaw/uirouter";
import { onTestFinished, vi } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import type { ApplicationRouter, RouteId } from "../app-routes.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import type { ShellNavigationOwner } from "./app-shell-navigation.ts";
import { createApplicationConfigCapability } from "./config.ts";
import type { ApplicationContext } from "./context.ts";

export type ShellRouteCommitState = {
  runtime: { context: ApplicationContext };
  activeSessionKey: string;
  didConsiderNativeRouteRestore: boolean;
  shellNavigation: ShellNavigationOwner;
};

export type ShellCustodianRouteState = {
  custodianMinimizeRequestId: number;
  shellNavigation: ShellNavigationOwner;
};

export type ShellKeyboardState = {
  element: HTMLElement;
  runtime: { context: ApplicationContext };
};

export function resetAppHostTestGlobals(): void {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "webkit");
  document.documentElement.classList.remove(
    "openclaw-native-macos",
    "openclaw-native-nav",
    "openclaw-native-web-chrome",
  );
  vi.unstubAllGlobals();
}

export type TestOptionalCustomElement = {
  tagName: string;
  label: string;
  loadModule: () => Promise<unknown>;
};

let lazyElementSequence = 0;

export function createLazyElementSpec(
  label: string,
  options: { firstError?: Error } = {},
): TestOptionalCustomElement {
  lazyElementSequence += 1;
  const tagName = `openclaw-app-host-lazy-${lazyElementSequence}`;
  let attempt = 0;
  return {
    tagName,
    label,
    loadModule: async () => {
      attempt += 1;
      if (attempt === 1 && options.firstError) {
        throw options.firstError;
      }
      customElements.define(tagName, class extends HTMLElement {});
    },
  };
}

/**
 * Replay is gated on the rendered element; harnesses that model "rendered as
 * soon as the module defines the tag" install this stub on the fake shell.
 */
export function stubRenderedWhenDefined(shell: object): void {
  Object.defineProperty(shell, "queryRenderedElement", {
    configurable: true,
    value: (tagName: string) =>
      customElements.get(tagName) ? document.createElement(tagName) : null,
  });
}

export function committedRouterState(
  routeId: RouteId,
  pathname: string,
  data?: unknown,
): ReturnType<ApplicationRouter["getState"]> {
  const location = { pathname, search: "", hash: "" } satisfies RouteLocation;
  return {
    location,
    resolvedLocation: location,
    status: "success",
    matches: [{ routeId, location, data }],
    pendingMatches: [],
    cachedMatches: [],
  } as unknown as ReturnType<ApplicationRouter["getState"]>;
}

export function createShellConfigFixture() {
  const config = createApplicationConfigCapability({ resourceBasePath: "" });
  config.refresh = vi.fn(async () => null);
  return config;
}

export function createRosterRefreshContext(params: {
  previous: AgentsListResult;
  next: AgentsListResult;
  selectedId: string;
}) {
  const source = createApplicationGateway();
  source.publish({
    ...source.gateway.snapshot,
    client: createTestGatewayClient(vi.fn(async () => params.next)),
    phase: "connected",
  });
  const agents = createAgentCapability(source.gateway);
  agents.state.agentsList = params.previous;
  const agentSelection = createAgentSelectionCapability(source.gateway, agents);
  agentSelection.set(params.selectedId);
  onTestFinished(() => {
    agentSelection.dispose();
    agents.dispose();
  });
  const refreshList = vi.spyOn(agents, "refreshList");
  const invalidateFiles = vi.spyOn(agents, "invalidateFiles");
  const invalidateIdentity = vi.fn();
  const ensureIdentity = vi.fn(async () => undefined);
  const setSelection = vi.spyOn(agentSelection, "set");
  const refreshConfig = vi.fn(async () => null);
  const context = {
    config: createShellConfigFixture(),
    agents,
    agentIdentity: {
      invalidate: invalidateIdentity,
      ensure: ensureIdentity,
    },
    agentSelection,
    runtimeConfig: {
      state: { configFormDirty: false },
      refresh: refreshConfig,
    },
  } as unknown as ApplicationContext;
  return {
    context,
    refreshList,
    invalidateFiles,
    invalidateIdentity,
    ensureIdentity,
    setSelection,
    refreshConfig,
  };
}
