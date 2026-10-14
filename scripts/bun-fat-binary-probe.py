#!/usr/bin/env python3
"""Isolated desktop-layout experiment; synthetic HTTP provider, no real credentials."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARKER = "FAT_BINARY_ROUNDTRIP_OK"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--command", required=True, help="JSON array: executable and fixed arguments")
    parser.add_argument("--output", required=True)
    parser.add_argument("--port", type=int, default=19890)
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--trace-preload")
    parser.add_argument("--extra-preload")
    parser.add_argument("--config", help="Optional complete config for external-plugin trials")
    parser.add_argument("--read-docs", action="store_true", help="Ask the real read tool for bundled docs and a skill")
    args = parser.parse_args()
    if not 19890 <= args.port <= 19898:
        parser.error("Both Gateway and fixture ports must be within 19890–19899")
    command = json.loads(args.command)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    for name in ("home", "tmp", "workspace"):
        (output / name).mkdir()
    for port in (args.port, args.port + 1):
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))
    token = "fatbin-synthetic-gateway-token"
    model = "fatbin-fixture"
    config = {
        "gateway": {"mode": "local", "bind": "loopback", "port": args.port,
                    "auth": {"mode": "token", "token": token}, "controlUi": {"enabled": True}},
        "discovery": {"mdns": {"mode": "off"}},
        "models": {"mode": "replace", "catalogRefresh": {"enabled": False}, "providers": {
            "openai": {"baseUrl": f"http://127.0.0.1:{args.port + 1}/v1",
                       "apiKey": "synthetic-not-a-real-key", "api": "openai-responses",
                       "agentRuntime": {"id": "openclaw"}, "request": {"allowPrivateNetwork": True},
                       "models": [{"id": model, "name": "Synthetic layout fixture", "api": "openai-responses",
                                   "reasoning": False, "input": ["text"], "contextWindow": 128000,
                                   "maxTokens": 512, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}},
        "agents": {"defaults": {"workspace": str(output / "workspace"), "skipBootstrap": True,
                                "model": {"primary": "openai/" + model, "fallbacks": []},
                                "models": {"openai/" + model: {"agentRuntime": {"id": "openclaw"},
                                           "params": {"transport": "sse", "openaiWsWarmup": False}}},
                                "utilityModel": "", "timeoutSeconds": 120,
                                "modelPolicy": {"allow": ["openai/" + model]}}},
        "plugins": {"enabled": True, "allow": ["openai"], "entries": {"openai": {"enabled": True}}},
        "skills": {"allowBundled": []}, "tools": {"deny": ["*"]},
        "meta": {"migrations": {"modelPolicyAllowlist": True, "utilityModelSeparation": True}},
    }
    if args.config:
        config = json.loads(Path(args.config).read_text())
        config["gateway"]["port"] = args.port
        config["agents"]["defaults"]["workspace"] = str(output / "workspace")
    if args.read_docs:
        config["tools"] = {"allow": ["read"]}
    (output / "openclaw.json").write_text(json.dumps(config, indent=2) + "\n")
    env = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin", "HOME": str(output / "home"),
           "TMPDIR": str(output / "tmp"), "OPENCLAW_STATE_DIR": str(output),
           "OPENCLAW_CONFIG_PATH": str(output / "openclaw.json"), "CODEX_HOME": str(output / "codex"),
           "OPENCLAW_NO_RESPAWN": "1", "NODE_DISABLE_COMPILE_CACHE": "1", "NO_COLOR": "1"}
    if args.trace_preload:
        env["OPENCLAW_STANDALONE_TRACE_PRELOAD"] = str(Path(args.trace_preload).resolve())
        env["OPENCLAW_STANDALONE_TRACE"] = str(output / "trace.jsonl")
    if args.extra_preload:
        env["FATBIN_EXTRA_PRELOAD"] = str(Path(args.extra_preload).resolve())
    result = {"command": command, "runtime": args.runtime, "pass": False, "steps": [],
              "load_start": os.getloadavg(), "cpu_count": os.cpu_count()}
    receipts = []

    class Fixture(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            receipts.append({"path": self.path, "model": body.get("model"), "stream": body.get("stream"),
                             "marker": MARKER in json.dumps(body),
                             "tools": [item.get("name") for item in body.get("tools", [])]})
            if args.read_docs and len(receipts) == 1:
                calls = [{"type": "function_call", "id": f"fc_fatbin_{index}", "call_id": f"call_fatbin_{index}",
                          "name": "read", "arguments": json.dumps({"path": str(Path(args.runtime) / relative)})}
                         for index, relative in enumerate(("docs/install/bun.md", "skills/github/SKILL.md"))]
                events = [{"type": "response.output_item.added", "output_index": index, "item": item}
                          for index, item in enumerate(calls)]
                events += [{"type": "response.output_item.done", "output_index": index, "item": item}
                           for index, item in enumerate(calls)]
                events.append({"type": "response.completed", "response": {"id": "resp_fatbin_read", "status": "completed", "output": calls,
                              "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}})
                self.send_events(events)
                return
            if args.read_docs:
                tool_outputs = [item for item in body.get("input", []) if item.get("type") == "function_call_output"]
                result["read_tool_outputs"] = len(tool_outputs)
                text = json.dumps(tool_outputs)
                result["read_docs_ok"] = (
                    "primary, default, and recommended runtime" in text and
                    "name: github" in text and len(tool_outputs) == 2
                )
            message = {"type": "message", "id": "msg_fatbin", "role": "assistant", "status": "completed",
                       "content": [{"type": "output_text", "text": MARKER, "annotations": []}]}
            events = [
                {"type": "response.output_item.added", "output_index": 0, "item": {**message, "status": "in_progress", "content": []}},
                {"type": "response.output_text.delta", "item_id": message["id"], "output_index": 0, "content_index": 0, "delta": MARKER},
                {"type": "response.output_text.done", "item_id": message["id"], "output_index": 0, "content_index": 0, "text": MARKER},
                {"type": "response.output_item.done", "output_index": 0, "item": message},
                {"type": "response.completed", "response": {"id": "resp_fatbin", "status": "completed", "output": [message],
                 "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}},
            ]
            self.send_events(events)

        def send_events(self, events):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(("".join("data: " + json.dumps(event) + "\n\n" for event in events) + "data: [DONE]\n\n").encode())

    def run(label, arguments, timeout=180):
        started = time.monotonic()
        completed = subprocess.run(command + arguments, env=env, cwd=output, capture_output=True, timeout=timeout)
        (output / (label + ".stdout")).write_bytes(completed.stdout)
        (output / (label + ".stderr")).write_bytes(completed.stderr)
        result["steps"].append({"label": label, "seconds": time.monotonic() - started, "exit": completed.returncode})
        assert completed.returncode == 0, f"{label} failed; see {output / (label + '.stderr')}"
        return completed.stdout.decode()

    server = ThreadingHTTPServer(("127.0.0.1", args.port + 1), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    gateway = None
    try:
        run("version", ["--version"])
        run("config-validate", ["config", "validate"])
        run("skills", ["skills", "list", "--json"])
        stdout = (output / "gateway.stdout").open("wb")
        stderr = (output / "gateway.stderr").open("wb")
        started = time.monotonic()
        gateway = subprocess.Popen(command + ["gateway", "run", "--port", str(args.port)],
                                   env=env, cwd=output, stdout=stdout, stderr=stderr, start_new_session=True)
        deadline = started + 180
        while time.monotonic() < deadline:
            assert gateway.poll() is None, f"Gateway exited {gateway.returncode}"
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/readyz", timeout=1) as response:
                    if json.loads(response.read()).get("ready") is True:
                        break
            except (OSError, ValueError):
                pass
            time.sleep(.1)  # Live experiment readiness, outside the unit-test suite.
        else:
            raise TimeoutError("Gateway readiness")
        result["gateway_ready_seconds"] = time.monotonic() - started
        result["gateway_rss_kib"] = int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(gateway.pid)]).strip())
        health = json.loads(run("health", ["gateway", "health", "--url", f"ws://127.0.0.1:{args.port}", "--token", token, "--timeout", "60000", "--json"]))
        assert health["ok"] is True
        with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/", timeout=10) as response:
            html = response.read().decode()
            result["control_ui"] = {"status": response.status, "bytes": len(html)}
            assert "<html" in html.lower()
        assets = re.findall(r'(?:src|href)="([^" ]+\.(?:js|css))"', html)
        assert assets, "Control UI index has no referenced scripts or styles"
        result["control_ui"]["assets"] = []
        for asset in assets:
            url = f"http://127.0.0.1:{args.port}/" + asset.removeprefix("./").removeprefix("/")
            with urllib.request.urlopen(url, timeout=10) as response:
                data = response.read()
                assert response.status == 200 and data
                result["control_ui"]["assets"].append({"path": asset, "bytes": len(data)})
        agent = json.loads(run("agent", ["agent", "--agent", "main", "--session-id", "fatbin-trial", "--message", "Reply exactly: " + MARKER, "--json", "--timeout", "120"]))
        assert agent["status"] == "ok" and agent["summary"] == "completed"
        assert any(item.get("text") == MARKER for item in agent["result"]["payloads"])
        assert len(receipts) == (2 if args.read_docs else 1)
        assert all(item["stream"] is True and item["marker"] is True and
                   item["path"] == "/v1/responses" and item["model"] == model for item in receipts)
        if args.read_docs:
            assert result.get("read_docs_ok") is True, "Agent did not return two successful file reads"
        result["gateway_post_turn_rss_kib"] = int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(gateway.pid)]).strip())
        gateway.send_signal(signal.SIGTERM)
        result["gateway_exit"] = gateway.wait(timeout=30)
        assert gateway.returncode == 0
        gateway = None
        run("doctor", ["doctor", "--non-interactive"], timeout=180)
        result["pass"] = True
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        if gateway is not None:
            os.killpg(gateway.pid, signal.SIGTERM)
            try:
                gateway.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(gateway.pid, signal.SIGKILL)
                gateway.wait()
        server.shutdown()
        server.server_close()
        thread.join()
        result["provider_receipts"] = receipts
        result["load_end"] = os.getloadavg()
        (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
