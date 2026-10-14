#!/usr/bin/env python3
"""Compare signed executable scan costs with a single archived sidecar."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import signal
import statistics
import subprocess
import tempfile
import time

FLOOR = 10 * 2**30
NAMES = ("X0", "XJ", "XB", "XA")


def load_app():
    spec = importlib.util.spec_from_file_location(
        "bench_app", Path(__file__).with_name("bench-desktop-app.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def disk(root):
    value = shutil.disk_usage(root).free
    if value < FLOOR:
        raise RuntimeError(f"STOP: free disk {value} bytes is below 10 GiB")
    return value


def save(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def command(argv, root, receipts, env=None):
    """Guard disk while signing/archiving, with output outside pipe buffers."""
    started = time.monotonic()
    row = {"command": [str(x) for x in argv], "free_start": disk(root)}
    receipts.append(row)
    with tempfile.TemporaryFile() as output:
        child = subprocess.Popen(argv, stdout=output, stderr=subprocess.STDOUT,
                                 env=env, start_new_session=True)
        try:
            while child.poll() is None:
                disk(root)
                time.sleep(1)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            output.seek(0)
            row.update(exit=child.returncode, seconds=time.monotonic() - started,
                       output=output.read().decode(errors="replace"))
    if child.returncode:
        raise RuntimeError(row["output"])


def clone(source, target):
    subprocess.run(["/bin/cp", "-cR", str(source), str(target)], check=True)


def entitlements(path):
    return plistlib.loads(subprocess.check_output(
        ["codesign", "-d", "--entitlements", ":-", str(path)], stderr=subprocess.DEVNULL))


def assemble(args, app_module):
    base = args.base.resolve(strict=True)
    metadata = plistlib.loads((base / "Contents/Info.plist").read_bytes())
    if metadata["CFBundleIdentifier"] != "ai.openclaw.mac.tcctest":
        raise ValueError("Only the tcctest release shell is allowed")
    app_module.checked(["codesign", "--verify", "--deep", "--strict", str(base)])
    base_entitlements = entitlements(base)
    root = args.output / "variants"
    root.mkdir()
    result = {"base": str(base), "source_commit": metadata["OpenClawGitCommit"],
              "sidecar_zip": str(args.sidecar_zip), "variants": []}
    environment = dict(os.environ, DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer",
                       SIGN_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
                       TMPDIR=str(args.output / "tmp"), PYTHONDONTWRITEBYTECODE="1")
    for key in ("OPENCLAW_SKIP_MLX_TTS", "ALLOW_ADHOC_SIGNING", "DISABLE_LIBRARY_VALIDATION",
                "SKIP_TEAM_ID_CHECK", "OPENCLAW_MAC_SIGNING_VARIANT"):
        environment.pop(key, None)
    suffixes = {"XJ": "", "XB": "-bytecode", "XA": "-aot"}
    for name in NAMES:
        row = {"name": name, "commands": [], "free_before_build": disk(root)}
        result["variants"].append(row)
        command(["df", "-g", str(Path.home())], root, row["commands"])
        app = root / name / "OpenClaw.app"
        app.parent.mkdir()
        try:
            clone(base, app)
            runtime = app / "Contents/Resources/runtime"
            if name == "X0":
                command(["/usr/bin/python3", args.archive_owner, app], root, row["commands"], environment)
            else:
                shutil.rmtree(runtime)
                (runtime / "bin").mkdir(parents=True)
                clone(args.fat_root / ("openclaw-standalone" + suffixes[name]), runtime / "bin/bun")
                clone(args.sidecar_zip, runtime / "bin/runtime.zip")
            command(["/bin/bash", args.signer, app], root, row["commands"], environment)
            command(["codesign", "--verify", "--deep", "--strict", app], root, row["commands"])
            if entitlements(app) != base_entitlements:
                raise RuntimeError("Shell entitlements changed")
            signature = app_module.checked(["codesign", "-dvv", str(app)]).stderr.decode()
            if "Authority=Developer ID Application:" not in signature or "runtime" not in signature:
                raise RuntimeError("Developer ID hardened runtime required")
            exe = runtime / "bin/bun"
            exe_entitlements = entitlements(exe)
            if not all(exe_entitlements.get(key) for key in (
                    "com.apple.security.cs.allow-jit",
                    "com.apple.security.cs.allow-unsigned-executable-memory",
                    "com.apple.security.cs.disable-library-validation")):
                raise RuntimeError("Runtime executable lacks release Bun entitlements")
            row.update(app=str(app), signature=signature, entitlements=exe_entitlements,
                       executable_bytes=exe.stat().st_size, inventory=app_module.inventory(app))
            archive = root / (name + ".zip")
            command(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive],
                    root, row["commands"])
            row["zip_bytes"] = archive.stat().st_size
            archive.unlink()
            row["success"] = True
        finally:
            save(args.output / "assembly.json", result)
        print(json.dumps({k: v for k, v in row.items() if k not in ("commands", "signature")}), flush=True)
    return result


def execute(exe, work, timeout):
    work.mkdir()
    environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(work),
                   "TMPDIR": str(work), "CODEX_HOME": str(work / "codex"),
                   "CLAUDE_CONFIG_DIR": str(work / "claude"),
                   "OPENCLAW_STATE_DIR": str(work / "state"),
                   "OPENCLAW_CONFIG_PATH": str(work / "state/openclaw.json"),
                   "OPENCLAW_NO_RESPAWN": "1", "NO_COLOR": "1"}
    row = {"started": time.time(), "load_start": os.getloadavg(), "success": False}
    started = time.monotonic()
    child = subprocess.Popen([str(exe), "--version"], cwd=work, env=environment,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, err = child.communicate(timeout=timeout)
        row.update(seconds=time.monotonic() - started, exit=child.returncode,
                   stdout=out.decode(errors="replace"), stderr=err.decode(errors="replace"),
                   success=child.returncode == 0 and bool(out.strip()))
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        out, err = child.communicate()
        row.update(error="exec timed out", elapsed_s=time.monotonic() - started,
                   stdout=out.decode(errors="replace"), stderr=err.decode(errors="replace"))
    finally:
        row["load_end"] = os.getloadavg()
    return row


def measure(args, assembly, app_module):
    result = {"schema": 1, "status": "running", "assembly": assembly,
              "host": {"platform": platform.platform(), "cpu_count": os.cpu_count()},
              "trials": [], "summary": {}}
    path = args.output / "scan-results.json"
    for index in range(1, args.trials + 1):
        for variant in assembly["variants"]:
            for order in ("open-first", "exec-first"):
                disk(args.output)
                root = args.output / f"trial-{index}-{variant['name']}-{order}"
                root.mkdir()
                app = root / "OpenClaw.app"
                clone(Path(variant["app"]), app)
                exe = app / "Contents/Resources/runtime/bin/bun"
                try:
                    # Explicitly unquarantined; quarantine is a separate rejected cohort.
                    subprocess.run(["xattr", "-dr", "com.apple.quarantine", str(app)], capture_output=True)
                    phases = ("fresh-open", "after-open-exec", "repeat-open", "repeat-exec")
                    if order == "exec-first":
                        phases = ("first-exec", "first-exec-repeat")
                    for phase in phases:
                        work = root / phase
                        profile = f"exescan-{variant['name'].lower()}-{index}-{time.time_ns()}"
                        try:
                            if phase.endswith("open"):
                                row = app_module.boundary(app, work, profile, args.timeout)
                            else:
                                row = execute(exe, work, args.timeout)
                            row.update(variant=variant["name"], index=index, order=order, phase=phase)
                            result["trials"].append(row)
                            save(path, result)
                            print(json.dumps(row), flush=True)
                        finally:
                            app_module.cleanup(profile, work)
                finally:
                    app_module.stop_native(app)
                    shutil.rmtree(root)
    for name in NAMES:
        result["summary"][name] = {}
        for phase in ("fresh-open", "after-open-exec", "repeat-open", "repeat-exec",
                      "first-exec", "first-exec-repeat"):
            rows = [r for r in result["trials"] if r["variant"] == name and r["phase"] == phase]
            values = [value for r in rows if r["success"]
                      if isinstance(value := r.get("seconds", r.get("open_to_entry_output_s")), (int, float))]
            result["summary"][name][phase] = {"attempts": len(rows), "n": len(values),
                "median": statistics.median(values) if values else None,
                "min": min(values) if values else None, "max": max(values) if values else None}
    result["status"] = "complete"
    save(path, result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("assemble", "measure"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--archive-owner", type=Path)
    parser.add_argument("--sidecar-zip", type=Path)
    parser.add_argument("--fat-root", type=Path)
    parser.add_argument("--signer", type=Path, default=Path(__file__).with_name("codesign-mac-app.sh"))
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=240)
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "tmp").mkdir(exist_ok=True)
    if args.trials < 5:
        parser.error("At least five interleaved trials required")
    app = load_app()
    if args.phase == "assemble":
        if any(getattr(args, key) is None for key in ("base", "archive_owner", "sidecar_zip", "fat_root")):
            parser.error("Assembly requires base, archive-owner, sidecar-zip and fat-root")
        assemble(args, app)
    else:
        assembly = json.loads((args.output / "assembly.json").read_text())
        if not all(r.get("success") for r in assembly["variants"]) or len(assembly["variants"]) != 4:
            parser.error("All four signed variants must be assembled first")
        measure(args, assembly, app)


if __name__ == "__main__":
    main()
