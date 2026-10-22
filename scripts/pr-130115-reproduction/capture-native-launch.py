#!/usr/bin/env python3
"""Collect real native startup diagnostics around the external XCTest invocation."""
import datetime
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

if (os.environ.get("GITHUB_ACTIONS") != "true" or
        os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or sys.platform != "darwin"):
    raise SystemExit("Use only the disposable macOS GUI runner")
if len(sys.argv) < 5 or sys.argv[3] != "--" or sys.argv[4] != "/usr/bin/xcodebuild":
    raise SystemExit("Usage: capture-native-launch.py launch.json output -- /usr/bin/xcodebuild ...")

runner_root = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)

def owned(value):
    result = Path(value).resolve(strict=True)
    if not result.is_relative_to(runner_root) or result == runner_root:
        raise ValueError("Diagnostic path escaped RUNNER_TEMP")
    return result

launch_file = owned(sys.argv[1])
output = owned(sys.argv[2]) / "startup-diagnostics"
output.mkdir()  # Never replace an earlier invocation's evidence.
launch = json.loads(launch_file.read_text())
app_home = owned(launch["appEnvironment"]["HOME"])
app_tmp = owned(launch["appEnvironment"]["TMPDIR"])
predicate = 'subsystem == "ai.openclaw"'
started = datetime.datetime.now().astimezone()
receipt = {"started": started.isoformat(), "command": sys.argv[4:],
           "doctorOutputCoverage": "Native startup forwards at most 4000 characters of the selected error; full Doctor stdout is not exposed.",
           "proofVerdict": "not_assessed"}
test = None
stream = None

def stop_owned_process(process):
    if process is not None and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)

def interrupted(signum, frame):
    raise KeyboardInterrupt(f"Interrupted by signal {signum}")

signal.signal(signal.SIGTERM, interrupted)
try:
    with (output / "unified-live.json").open("wb") as live, (output / "unified-live.stderr").open("wb") as errors:
        stream = subprocess.Popen(["/usr/bin/log", "stream", "--style", "json", "--level", "debug",
                                   "--predicate", predicate], stdout=live, stderr=errors, start_new_session=True)
        try:
            with (output / "xctest.log").open("wb") as log:
                test = subprocess.Popen(sys.argv[4:], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                receipt["xctestExit"] = test.wait()
        finally:
            stop_owned_process(test)
            stop_owned_process(stream)
            receipt["logStreamExit"] = stream.returncode
finally:
    # The persisted log covers the interval even if the stream was still attaching at launch.
    with (output / "unified-persisted.json").open("wb") as persisted, (output / "unified-persisted.stderr").open("wb") as errors:
        try:
            result = subprocess.run(["/usr/bin/log", "show", "--style", "json", "--info", "--debug",
                                     "--start", started.strftime("%Y-%m-%d %H:%M:%S"),
                                     "--predicate", predicate], stdout=persisted, stderr=errors, timeout=30)
            receipt["logShowExit"] = result.returncode
        except subprocess.TimeoutExpired:
            receipt["logShowError"] = "Timed out after 30 seconds"
    diagnostics = app_home / "Library/Logs/OpenClaw"
    copied = []
    if diagnostics.exists():
        owned(diagnostics)
        for source in diagnostics.glob("diagnostics*.jsonl*"):
            owned(source)
            if source.is_file():
                shutil.copy2(source, output / source.name)
                copied.append(source.name)
    receipt["nativeFileLogs"] = copied
    # Only interrupted ShellExecutor invocations can leave these files. Normal completion removes them.
    residual = []
    for directory in app_tmp.glob("openclaw-shell-*"):
        owned(directory)
        for name in ("stdout", "stderr"):
            source = directory / name
            if source.is_file():
                owned(source)
                target = output / f"{directory.name}-{name}.residual"
                shutil.copy2(source, target)
                residual.append(target.name)
    receipt["residualShellOutput"] = residual
    receipt["finished"] = datetime.datetime.now().astimezone().isoformat()
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2))

if receipt.get("xctestExit") != 0:
    raise SystemExit(receipt.get("xctestExit") or 1)
if receipt.get("logShowExit") != 0:
    raise SystemExit("Native log collection failed; startup diagnostics are incomplete")
