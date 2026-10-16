import { onTestFinished, vi } from "vitest";
import type { resolveMcpTransport } from "../agents/mcp-transport.js";
import { startNodeHostMcpManager as startManager } from "./mcp.js";

const { clientConstructor, resolveTransport } = vi.hoisted(() => ({
  clientConstructor: vi.fn(),
  resolveTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: clientConstructor }));
// mock-isolation: Fixtures own transport lifetimes instead of opening real MCP connections.
vi.mock("../agents/mcp-transport.js", () => ({ resolveMcpTransport: resolveTransport }));

type TransportFixture = Pick<
  NonNullable<ReturnType<typeof resolveMcpTransport>>,
  "transport" | "transportType" | "connectionTimeoutMs" | "requestTimeoutMs" | "detachStderr"
>;

export function startNodeHostMcpManager(
  servers: Parameters<typeof startManager>[0],
  options: NonNullable<Parameters<typeof startManager>[1]> & {
    createClient: (serverName: string, options: { onToolsChanged: () => void }) => unknown;
    resolveTransport: (serverName: string) => TransportFixture | null;
    warn?: (message: string) => void;
  },
) {
  // Transport resolution and client construction share one synchronous startup step.
  let connectingServer = "";
  resolveTransport.mockImplementation((serverName: string) => {
    connectingServer = serverName;
    return options.resolveTransport(serverName);
  });
  clientConstructor.mockImplementation(function (
    _identity: unknown,
    clientOptions: { listChanged: { tools: { onChanged: () => void } } },
  ) {
    return options.createClient(connectingServer, {
      onToolsChanged: clientOptions.listChanged.tools.onChanged,
    });
  });
  const warnings = vi.spyOn(console, "warn").mockImplementation(options.warn ?? (() => {}));
  onTestFinished(() => warnings.mockRestore());
  return startManager(servers, {
    signal: options.signal,
    onDescriptorsChanged: options.onDescriptorsChanged,
  });
}
