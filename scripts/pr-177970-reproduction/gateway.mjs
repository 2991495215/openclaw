// Proof-only network adapter around the repository's existing synthetic Gateway.
// It delays actual health requests; it never calls an app lifecycle owner.
import { createServer, request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { WebSocket, WebSocketServer } from "ws";

const backendPort = 19877;
const events = [];
const sockets = new Map();
const held = new Map();
const waiters = new Set();
let armed = false;
let serial = 0;
let closedWhileHeld = 0;
let backendFailures = 0;

function record(kind, details = {}) {
  events.push({ kind, atMs: performance.now(), ...details });
  for (const notify of waiters) notify();
}

function state() {
  return {
    armed,
    held: held.size,
    closedWhileHeld,
    backendFailures,
    savedConnections: [...sockets.values()].filter((socket) => socket.saved).length,
    events,
  };
}

function release() {
  armed = false;
  for (const { upstream, bytes } of held.values()) {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes);
  }
  held.clear();
  record("released");
}

function startGateway(port, saved) {
  const server = createServer((req, res) => {
    if (req.method === "GET" && new URL(req.url, "http://127.0.0.1").pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end("<!doctype html><title>Reproduction server</title><h1>Synthetic Gateway ready</h1>");
      record("document", { saved });
      return;
    }
    const forwarded = httpRequest(
      { hostname: "127.0.0.1", port: backendPort, path: req.url, method: req.method },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    forwarded.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(forwarded);
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (client) => {
    const id = ++serial;
    const upstream = new WebSocket(`ws://127.0.0.1:${backendPort}`);
    let upstreamInitiatedClose = false;
    const methods = new Map();
    sockets.set(id, { saved, client, upstream });
    record("socket-open", { id, saved });
    upstream.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString());
      const method = message.id ? methods.get(message.id) : undefined;
      if (message.type === "res" && message.ok && method === "models.list") {
        message.payload = {
          models: [{ id: "synthetic-model", provider: "fixture", name: "Synthetic model" }],
        };
      }
      if (
        message.type === "res" &&
        message.ok &&
        method === "config.get" &&
        message.payload?.config?.agents
      ) {
        message.payload.config.agents.defaults.model.primary = "fixture/synthetic-model";
      }
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
    });
    client.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.type === "req") {
        methods.set(message.id, message.method);
        record("request", { id, saved, method: message.method });
        if (saved && armed && message.method === "health") {
          held.set(`${id}:${message.id}`, { id, upstream, bytes });
          record("health-held", { id });
          return;
        }
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes);
      else upstream.once("open", () => upstream.send(bytes));
    });
    client.once("close", (code) => {
      const wasHeld = [...held.values()].some((entry) => entry.id === id);
      if (saved && armed && wasHeld && !upstreamInitiatedClose) closedWhileHeld++;
      for (const [key, entry] of held) if (entry.id === id) held.delete(key);
      sockets.delete(id);
      record("socket-close", { id, saved, wasHeld, code, upstreamInitiatedClose });
      upstream.close();
    });
    upstream.once("close", () => {
      record("upstream-close", { id });
      if (client.readyState === WebSocket.OPEN) {
        upstreamInitiatedClose = true;
        backendFailures++;
        client.close();
      }
    });
    upstream.on("error", () => {
      upstreamInitiatedClose = true;
      backendFailures++;
      record("upstream-error", { id });
      client.close();
    });
    client.on("error", () => record("client-error", { id }));
  });
  server.listen(port, "127.0.0.1");
  return { server, websocket };
}

const gateways = [startGateway(19876, false), startGateway(19878, true)];
const control = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  const route = new URL(req.url, "http://127.0.0.1").pathname;
  const reply = () => res.end(JSON.stringify(state()));
  if (req.method === "POST" && route === "/arm") {
    if (held.size !== 0) {
      res.writeHead(409);
      reply();
      return;
    }
    armed = true;
    closedWhileHeld = 0;
    backendFailures = 0;
    events.length = 0;
    record("armed");
    reply();
  } else if (req.method === "POST" && route === "/release") {
    release();
    reply();
  } else if (req.method === "POST" && route === "/checkpoint") {
    if (armed || held.size !== 0) {
      res.writeHead(409);
      reply();
      return;
    }
    events.length = 0;
    record("checkpoint");
    reply();
  } else if (req.method === "GET" && ["/await-held", "/await-cold"].includes(route)) {
    const notify = () => {
      const ready =
        route === "/await-held"
          ? held.size > 0
          : ![...sockets.values()].some((socket) => socket.saved);
      if (ready) {
        clearTimeout(deadline);
        waiters.delete(notify);
        reply();
      }
    };
    const deadline = setTimeout(() => {
      waiters.delete(notify);
      res.writeHead(408);
      reply();
    }, 8000);
    res.once("close", () => {
      clearTimeout(deadline);
      waiters.delete(notify);
    });
    waiters.add(notify);
    notify();
  } else if (req.method === "GET" && route === "/observe-cleanup") {
    // The shipped menu probe has a 3-second deadline. This external observation
    // window permits its cancellation/cleanup to finish before releasing I/O.
    const timer = setTimeout(reply, 4000);
    res.once("close", () => clearTimeout(timer));
  } else if (req.method === "GET" && route === "/state") {
    reply();
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Unknown proof control" }));
  }
});
control.listen(19879, "127.0.0.1");

function stop() {
  release();
  for (const { client, upstream } of sockets.values()) {
    client.terminate();
    upstream.terminate();
  }
  for (const { websocket, server } of gateways) {
    websocket.close();
    server.close();
  }
  control.close();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
