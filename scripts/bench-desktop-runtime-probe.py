"""One synthetic-provider Gateway trial; no operator credentials or state."""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARKER = "DESKTOP_LAYOUT_BENCH_OK"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def fixture_config(root, port, provider_port):
    model = "layout-fixture"
    return {
        "gateway": {"mode": "local", "bind": "loopback", "port": port,
                    "auth": {"mode": "token", "token": "synthetic-bench-token"},
                    "controlUi": {"enabled": True}},
        "discovery": {"mdns": {"mode": "off"}},
        "models": {"mode": "replace", "catalogRefresh": {"enabled": False}, "providers": {
            "openai": {"baseUrl": f"http://127.0.0.1:{provider_port}/v1",
                       "apiKey": "synthetic-not-a-real-key", "api": "openai-responses",
                       "agentRuntime": {"id": "openclaw"}, "request": {"allowPrivateNetwork": True},
                       "models": [{"id": model, "name": "Synthetic benchmark", "api": "openai-responses",
                                   "reasoning": False, "input": ["text"], "contextWindow": 128000,
                                   "maxTokens": 512, "cost": {"input": 0, "output": 0,
                                                           "cacheRead": 0, "cacheWrite": 0}}]}}},
        "agents": {"defaults": {"workspace": str(root / "workspace"), "skipBootstrap": True,
                                "model": {"primary": "openai/" + model, "fallbacks": []},
                                "models": {"openai/" + model: {"agentRuntime": {"id": "openclaw"},
                                           "params": {"transport": "sse", "openaiWsWarmup": False}}},
                                "utilityModel": "", "timeoutSeconds": 120,
                                "modelPolicy": {"allow": ["openai/" + model]}}},
        "plugins": {"enabled": True, "allow": ["openai"], "slots": {"memory": "none"},
                    "entries": {"openai": {"enabled": True}}},
        "skills": {"allowBundled": []}, "tools": {"deny": ["*"]},
        "meta": {"migrations": {"modelPolicyAllowlist": True, "utilityModelSeparation": True}},
    }


def fixture_handler(receipts):
    class Fixture(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            receipts.append({"time": time.monotonic(), "path": self.path,
                             "model": body.get("model"), "stream": body.get("stream"),
                             "marker": MARKER in json.dumps(body)})
            if self.path != "/v1/responses":
                self.send_error(404)
                return
            message = {"type": "message", "id": "msg_bench", "role": "assistant", "status": "completed",
                       "content": [{"type": "output_text", "text": MARKER, "annotations": []}]}
            events = [
                {"type": "response.output_item.added", "output_index": 0,
                 "item": {**message, "status": "in_progress", "content": []}},
                {"type": "response.output_text.delta", "item_id": message["id"],
                 "output_index": 0, "content_index": 0, "delta": MARKER},
                {"type": "response.output_text.done", "item_id": message["id"],
                 "output_index": 0, "content_index": 0, "text": MARKER},
                {"type": "response.output_item.done", "output_index": 0, "item": message},
                {"type": "response.completed", "response": {"id": "resp_bench", "status": "completed",
                 "output": [message], "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}},
            ]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(("".join("data: " + json.dumps(event) + "\n\n" for event in events)
                              + "data: [DONE]\n\n").encode())
    return Fixture


def process_usage(pid):
    fields = subprocess.check_output(["ps", "-o", "rss=,time=", "-p", str(pid)], text=True).split()
    parts = fields[1].replace("-", ":").split(":")
    seconds = sum(float(value) * (60 ** index) for index, value in enumerate(reversed(parts)))
    return {"rss_kib": int(fields[0]), "cpu_s": seconds}


def stop(process):
    if process is None:
        return None
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    # Helpers inherit the session and can survive an early parent exit.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return process.returncode


def measure(variant, output, timeout, doctor=False):
    output.mkdir(parents=True, exist_ok=False)
    state = output / "isolated"
    for name in ("home", "tmp", "workspace", "state", "codex", "claude"):
        (state / name).mkdir(parents=True, exist_ok=True)
    port, provider_port = free_port(), free_port()
    config = fixture_config(state, port, provider_port)
    (state / "config.json").write_text(json.dumps(config))
    env = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin", "HOME": str(state / "home"),
           "TMPDIR": str(state / "tmp"), "OPENCLAW_STATE_DIR": str(state / "state"),
           "OPENCLAW_CONFIG_PATH": str(state / "config.json"), "CODEX_HOME": str(state / "codex"),
           "CLAUDE_CONFIG_DIR": str(state / "claude"), "OPENCLAW_NO_RESPAWN": "1",
           "NODE_DISABLE_COMPILE_CACHE": "1", "NO_COLOR": "1"}
    row = {"load_start": os.getloadavg(), "phases": [], "success": False}
    receipts = []
    server = ThreadingHTTPServer(("127.0.0.1", provider_port), fixture_handler(receipts))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    command = variant["command"]
    gateway = None

    def run(label, arguments):
        started = time.monotonic()
        with (output / (label + ".stdout")).open("wb") as stdout, (output / (label + ".stderr")).open("wb") as stderr:
            process = subprocess.Popen(command + arguments, cwd=state, env=env,
                                       stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                process.wait(timeout=timeout)
            finally:
                code = stop(process)
        row["phases"].append({"name": label, "seconds": time.monotonic() - started, "exit": code,
                              "load": os.getloadavg()})
        return code, (output / (label + ".stdout")).read_text()

    def launch(label):
        nonlocal gateway
        started = time.monotonic()
        with (output / (label + ".stdout")).open("wb") as stdout, (output / (label + ".stderr")).open("wb") as stderr:
            gateway = subprocess.Popen(command + ["gateway", "run", "--port", str(port)],
                                       cwd=state, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        while time.monotonic() - started < timeout:
            if gateway.poll() is not None:
                raise RuntimeError(f"{label} exited {gateway.returncode}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/readyz", timeout=0.5) as response:
                    if json.loads(response.read()).get("ready") is True:
                        row[label + "_ready_s"] = time.monotonic() - started
                        return
            except (OSError, ValueError):
                pass
            time.sleep(0.05)  # Live readiness measurement, not a unit-test timer.
        raise TimeoutError(label + " readiness")

    try:
        launch("cold")
        usage = process_usage(gateway.pid)
        row.update(rss_ready_kib=usage["rss_kib"], cpu_ready_s=usage["cpu_s"])
        code, health = run("health", ["gateway", "health", "--url", f"ws://127.0.0.1:{port}",
                                     "--token", "synthetic-bench-token", "--timeout", "60000", "--json"])
        row["health_ok"] = code == 0 and json.loads(health).get("ok") is True
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as response:
            html = response.read().decode()
        assets = re.findall(r'(?:src|href)="([^" ]+\.(?:js|css))"', html)
        row["ui_assets"] = []
        for asset in assets:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/" + asset.removeprefix("./").lstrip("/"), timeout=10) as response:
                row["ui_assets"].append({"path": asset, "bytes": len(response.read()), "status": response.status})
        row["ui_ok"] = "<html" in html.lower() and bool(assets) and all(a["bytes"] > 0 for a in row["ui_assets"])
        started = time.monotonic()
        code, answer = run("agent", ["agent", "--agent", "main", "--session-id", "bench-trial",
                                     "--message", "Reply exactly: " + MARKER, "--json", "--timeout", "120"])
        row["agent_cli_s"] = time.monotonic() - started
        payload = json.loads(answer) if code == 0 else {}
        row["agent_ok"] = payload.get("status") == "ok" and any(
            item.get("text") == MARKER for item in payload.get("result", {}).get("payloads", []))
        row["agent_runtime_ms"] = payload.get("result", {}).get("meta", {}).get("durationMs")
        usage = process_usage(gateway.pid)
        row.update(rss_post_turn_kib=usage["rss_kib"], cpu_post_turn_s=usage["cpu_s"])
        row["cold_exit"] = stop(gateway)
        gateway = None
        launch("warm")
        row["warm_exit"] = stop(gateway)
        gateway = None
        if doctor:
            code, _ = run("doctor", ["doctor", "--non-interactive"])
            row["doctor_exit"] = code
        row["success"] = row["health_ok"] and row["ui_ok"] and row["agent_ok"] and all(
            r["stream"] is True and r["marker"] and r["path"] == "/v1/responses" for r in receipts) and bool(receipts)
    except Exception as error:
        row["error"] = str(error)
    finally:
        try:
            row["cleanup_exit"] = stop(gateway)
            if doctor and "doctor_exit" not in row:
                try:
                    row["doctor_exit"], _ = run("doctor", ["doctor", "--non-interactive"])
                except Exception as error:
                    row["doctor_error"] = str(error)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            row["provider_receipts"] = receipts
            row["load_end"] = os.getloadavg()
            shutil.rmtree(state)
            row["isolated_state_removed"] = not state.exists()
            (output / "result.json").write_text(json.dumps(row, indent=2) + "\n")
    return row
