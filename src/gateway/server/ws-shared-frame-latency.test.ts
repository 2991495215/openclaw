import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { ClientOptions, RawData } from "ws";
import * as Ws from "../../../packages/gateway-client/src/websocket.test-support.js";
import { acquireTestPortBlock, type TestPortClaim } from "../../test-utils/port-claims.js";
import { SerializedGatewayFrame } from "../serialized-json.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { makeClient } from "../server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "./client-registry.js";
import { GATEWAY_PER_MESSAGE_DEFLATE, installGatewayDeflateCodec } from "./ws-compression.js";
import { installGatewayDeflateCodec as installBaseline } from "./ws-compression.latency-baseline.test-support.js";
import { createGatewayWebSocketTransport } from "./ws-transport.js";
import type { GatewayWsClient } from "./ws-types.js";

// Temporary, synthetic comparison: real zlib and real sockets, no owner substitution.
const nativeWork = vi.hoisted(() => ({ resets: 0, fallback: 0 }));
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    createDeflateRaw: (...args: Parameters<typeof actual.createDeflateRaw>) => {
      const stream = actual.createDeflateRaw(...args);
      const reset = stream.reset.bind(stream);
      stream.reset = (...resetArgs: Parameters<typeof stream.reset>) => {
        nativeWork.resets += 1;
        return reset(...resetArgs);
      };
      return stream;
    },
    deflateRawSync: (...args: Parameters<typeof actual.deflateRawSync>) => {
      nativeWork.fallback += 1;
      return actual.deflateRawSync(...args);
    },
  };
});

type Version = "baseline" | "candidate";
type Trace = {
  frames: Array<Buffer | SerializedGatewayFrame>;
  outputs: Array<Buffer | SerializedGatewayFrame>;
};
type Peer = {
  peer: Ws.WebSocket;
  stream: import("node:net").Socket;
  client: GatewayWsClient;
};
type Sample = {
  version: Version;
  phase: "owner-cold" | "warm" | "single";
  round: number;
  broadcasts: number;
  recipients: number;
  nativeDeflations: number;
  fallbackDeflations: number;
  dispatchMs: number;
  cpuMs: number;
  deliveryMs: number;
  wireBytes: number;
  outputBackingBuffers: number;
  outputBackingBytes: number;
};
let activeVersion: Version = "baseline";
let trace: Trace | undefined;
let claim: TestPortClaim | undefined;
let server: Ws.WebSocketServer | undefined;
const sockets = new Set<Ws.WebSocket>();
const shared: Peer[] = [];
let narrow: Peer;
let uncompressed: Peer;

async function connect(perMessageDeflate: ClientOptions["perMessageDeflate"]): Promise<Peer> {
  const accepted = once(server!, "connection");
  const peer = new Ws.WebSocket(`ws://127.0.0.1:${claim!.port}`, { perMessageDeflate });
  sockets.add(peer);
  const opened = once(peer, "open");
  const [socket, request] = (await accepted) as [Ws.WebSocket, import("node:http").IncomingMessage];
  sockets.add(socket);
  await opened;
  const codecs = {
    baseline: installBaseline(socket)!,
    candidate: installGatewayDeflateCodec(socket)!,
  };
  expect(codecs.baseline).toBeDefined();
  expect(codecs.candidate).toBeDefined();
  expect(codecs.baseline.acceptsDeflatedSegments).toBe(codecs.candidate.acceptsDeflatedSegments);
  const transport = createGatewayWebSocketTransport(socket, request.socket, {
    acceptsDeflatedSegments: codecs.baseline.acceptsDeflatedSegments,
    compress(frame) {
      const output = codecs[activeVersion].compress(frame);
      trace?.frames.push(frame);
      trace?.outputs.push(output ?? frame);
      return output;
    },
  });
  const { client } = makeClient(`synthetic-${sockets.size}`, "operator", ["operator.read"]);
  client.socket = transport;
  client.preparedRecipientProfileId = "synthetic-shared";
  return { peer, stream: request.socket, client };
}

beforeAll(async () => {
  claim = await acquireTestPortBlock({ offsets: [0] });
  server = new Ws.WebSocketServer({
    host: "127.0.0.1",
    port: claim.port,
    perMessageDeflate: GATEWAY_PER_MESSAGE_DEFLATE,
  });
  await once(server, "listening");
  for (let index = 0; index < 8; index++) {
    shared.push(await connect({ serverMaxWindowBits: 15 }));
  }
  narrow = await connect({ serverMaxWindowBits: 10 });
  uncompressed = await connect(false);
});

afterAll(async () => {
  trace = undefined;
  for (const socket of sockets) {
    socket.terminate();
  }
  if (server?.address()) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await claim?.release();
});

function payload(id: number) {
  const value = {
    runId: `synthetic-${String(id).padStart(6, "0")}`,
    sessionKey: "agent:main:synthetic",
    state: "final",
    message: { role: "assistant", content: [{ type: "text", text: "" }] },
  };
  value.message.content[0]!.text = "x".repeat(1000 - Buffer.byteLength(JSON.stringify(value)));
  expect(Buffer.byteLength(JSON.stringify(value))).toBe(1000);
  return value;
}

function receive(peer: Ws.WebSocket, count: number, signal: AbortSignal) {
  const messages: string[] = [];
  let dispose = () => {};
  const promise = new Promise<string[]>((resolve, reject) => {
    const fail = (error: Error) => {
      dispose();
      reject(error);
    };
    const closed = () => fail(new Error("Synthetic recipient closed before delivery"));
    const aborted = () => fail(new Error("Synthetic delivery aborted"));
    const message = (data: RawData, binary: boolean) => {
      if (binary) {
        fail(new Error("Expected a JSON text frame"));
        return;
      }
      messages.push(rawDataToString(data));
      if (messages.length === count) {
        dispose();
        resolve(messages);
      }
    };
    dispose = () => {
      peer.off("message", message);
      peer.off("error", fail);
      peer.off("close", closed);
      signal.removeEventListener("abort", aborted);
    };
    peer.on("message", message);
    peer.once("error", fail);
    peer.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
    }
  });
  void promise.catch(() => {});
  return { promise, dispose };
}

function backing(outputs: Trace["outputs"]) {
  const buffers = new Set<ArrayBufferLike>();
  for (const output of outputs) {
    for (const bytes of output instanceof SerializedGatewayFrame ? output.segments : [output]) {
      buffers.add(bytes.buffer);
    }
  }
  return {
    outputBackingBuffers: buffers.size,
    outputBackingBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
  };
}

async function measure(
  version: Version,
  phase: Sample["phase"],
  round: number,
  peers: Peer[],
  broadcaster: ReturnType<typeof createGatewayBroadcaster>,
  values: ReturnType<typeof payload>[],
  initialSeq: number,
  signal: AbortSignal,
): Promise<Sample> {
  activeVersion = version;
  const pending = peers.map(({ peer }) => receive(peer, values.length, signal));
  const beforeBytes = peers.reduce((sum, peer) => sum + peer.stream.bytesWritten, 0);
  const observed: Trace = { frames: [], outputs: [] };
  trace = observed;
  nativeWork.resets = 0;
  nativeWork.fallback = 0;
  const startedCpu = process.cpuUsage();
  const started = performance.now();
  let dispatchMs: number;
  let cpuMs: number;
  let nativeDeflations: number;
  let fallbackDeflations: number;
  try {
    for (const value of values) {
      broadcaster.broadcast("chat", value);
    }
    dispatchMs = performance.now() - started;
    const cpu = process.cpuUsage(startedCpu);
    cpuMs = (cpu.user + cpu.system) / 1000;
    nativeDeflations = nativeWork.resets + nativeWork.fallback;
    fallbackDeflations = nativeWork.fallback;
  } catch (error) {
    for (const delivery of pending) {
      delivery.dispose();
    }
    throw error;
  } finally {
    trace = undefined;
  }
  try {
    const messages = await Promise.all(pending.map((delivery) => delivery.promise));
    const deliveryMs = performance.now() - started;
    expect(observed.frames).toHaveLength(values.length * peers.length);
    for (const [index, value] of values.entries()) {
      const frame = observed.frames[index * peers.length];
      expect(frame).toBeInstanceOf(SerializedGatewayFrame);
      if (!(frame instanceof SerializedGatewayFrame)) {
        throw new Error("Broadcaster did not preserve segmented frame ownership");
      }
      expect(frame.byteLength).toBeGreaterThanOrEqual(1024);
      expect(Math.max(...frame.segments.map((segment) => segment.byteLength))).toBeLessThan(1024);
      for (let recipient = 0; recipient < peers.length; recipient++) {
        expect(observed.frames[index * peers.length + recipient]).toBe(frame);
        expect(JSON.parse(messages[recipient]![index]!)).toEqual({
          type: "event",
          event: "chat",
          payload: value,
          seq: initialSeq + index,
          recipientProfileId: "synthetic-shared",
        });
      }
      if (version === "candidate" && peers.every((peer) => shared.includes(peer))) {
        const output = observed.outputs[index * peers.length];
        expect(Buffer.isBuffer(output)).toBe(true);
        if (Buffer.isBuffer(output)) {
          // The retained cache owns the complete sync-flush output, including its four-byte trailer.
          expect(output.buffer.byteLength).toBe(output.byteLength + 4);
          for (let recipient = 1; recipient < peers.length; recipient++) {
            expect((observed.outputs[index * peers.length + recipient] as Buffer).buffer).toBe(
              output.buffer,
            );
          }
        }
      }
    }
    const sample: Sample = {
      version,
      phase,
      round,
      broadcasts: values.length,
      recipients: peers.length,
      nativeDeflations,
      fallbackDeflations,
      dispatchMs,
      cpuMs,
      deliveryMs,
      wireBytes: peers.reduce((sum, peer) => sum + peer.stream.bytesWritten, 0) - beforeBytes,
      ...backing(observed.outputs),
    };
    console.log("WS_SHARED_FRAME_SAMPLE", JSON.stringify(sample));
    return sample;
  } finally {
    for (const delivery of pending) {
      delivery.dispose();
    }
  }
}

const broadcasterFor = (peers: Peer[]) =>
  createGatewayBroadcaster({
    clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
  });

it("measures shared short chat frames through real broadcast delivery", async ({ signal }) => {
  const sourceHashes = await Promise.all(
    ["ws-compression.latency-baseline.test-support.ts", "ws-compression.ts"].map(async (name) => ({
      name,
      sha256: createHash("sha256")
        .update(await readFile(new URL(name, import.meta.url)))
        .digest("hex"),
    })),
  );
  console.log(
    "WS_SHARED_FRAME_CONTEXT",
    JSON.stringify({
      sourceHashes,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: cpus().length,
      loadavg: loadavg(),
      payloadBytes: 1000,
      windowBits: 15,
      coldScope: "new broadcaster first frame; process and native codecs retained",
      cpuScope: "process CPU during synchronous broadcast loop; includes observer bookkeeping",
      memoryScope:
        "distinct compressed-output backing buffers retained by the observer; not process retained heap",
    }),
  );
  const samples: Sample[] = [];
  for (let round = 0; round < 6; round++) {
    const first = [payload(round * 100)];
    const warm = Array.from({ length: 30 }, (_, index) => payload(round * 100 + index + 1));
    const versions: Version[] =
      round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const version of versions) {
      const broadcaster = broadcasterFor(shared);
      samples.push(
        await measure(version, "owner-cold", round, shared, broadcaster, first, 1, signal),
      );
      samples.push(await measure(version, "warm", round, shared, broadcaster, warm, 2, signal));
      samples.push(
        await measure(
          version,
          "single",
          round,
          [shared[0]!],
          broadcasterFor([shared[0]!]),
          first,
          1,
          signal,
        ),
      );
    }
  }
  for (const sample of samples) {
    expect(sample.nativeDeflations).toBe(
      sample.broadcasts * (sample.version === "baseline" ? sample.recipients : 1),
    );
  }
  for (const round of [0, 1, 2, 3, 4, 5]) {
    for (const phase of ["owner-cold", "warm", "single"] as const) {
      const pair = samples.filter((sample) => sample.round === round && sample.phase === phase);
      expect(pair[0]!.wireBytes).toBe(pair[1]!.wireBytes);
    }
  }
  for (const version of ["baseline", "candidate"] as const) {
    const mixedPeers = [shared[0]!, narrow];
    const mixed = await measure(
      version,
      "owner-cold",
      6,
      mixedPeers,
      broadcasterFor(mixedPeers),
      [payload(999000)],
      1,
      signal,
    );
    expect(mixed.nativeDeflations).toBe(2);
    const plain = await measure(
      version,
      "owner-cold",
      7,
      [uncompressed],
      broadcasterFor([uncompressed]),
      [payload(999001)],
      1,
      signal,
    );
    expect(plain.nativeDeflations).toBe(0);
    activeVersion = version;
    const mutablePayload = payload(999002);
    mutablePayload.message.content[0]!.text += "x".repeat(64);
    const mutable = Buffer.from(JSON.stringify({ ...mutablePayload, marker: "a" }));
    expect(mutable.byteLength).toBeGreaterThanOrEqual(1024);
    nativeWork.resets = 0;
    nativeWork.fallback = 0;
    for (const marker of ["a", "b"]) {
      const expected = JSON.stringify({ ...mutablePayload, marker });
      mutable.write(expected);
      const received = receive(shared[0]!.peer, 1, signal);
      try {
        shared[0]!.client.socket.send(mutable, { binary: false });
        expect(await received.promise).toEqual([expected]);
      } finally {
        received.dispose();
      }
    }
    expect(nativeWork.resets + nativeWork.fallback).toBe(2);
  }
  const summary = (["owner-cold", "warm", "single"] as const).flatMap((phase) =>
    (["baseline", "candidate"] as const).map((version) => {
      const group = samples.filter(
        (sample) => sample.phase === phase && sample.version === version,
      );
      const distribution = (key: "dispatchMs" | "cpuMs" | "deliveryMs") => {
        const values = group.map((sample) => sample[key]).toSorted((a, b) => a - b);
        return {
          min: values[0],
          median: (values[2]! + values[3]!) / 2,
          p95: values[5],
          max: values[5],
        };
      };
      return {
        phase,
        version,
        n: group.length,
        dispatchMs: distribution("dispatchMs"),
        cpuMs: distribution("cpuMs"),
        deliveryMs: distribution("deliveryMs"),
      };
    }),
  );
  console.log("WS_SHARED_FRAME_SUMMARY", JSON.stringify({ summary, loadavg: loadavg() }));
});
