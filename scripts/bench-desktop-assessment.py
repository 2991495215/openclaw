#!/usr/bin/env python3
"""Assemble signed assessment layouts from one immutable release application."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time


def run(command, log, **kwargs):
    started = time.monotonic()
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
    log.append({"command": [str(x) for x in command], "exit": result.returncode,
                "seconds": time.monotonic() - started,
                "output": result.stdout.decode(errors="replace")})
    if result.returncode:
        raise RuntimeError(log[-1]["output"])
    return result.stdout


def entitlements(app):
    return plistlib.loads(subprocess.check_output(
        ["codesign", "-d", "--entitlements", ":-", str(app)], stderr=subprocess.DEVNULL))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base", "trim-root", "archive-root", "fat-executable", "sidecar", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args()
    args.base = args.base.resolve(strict=True)
    args.output = args.output.resolve()
    lane = Path("/private/tmp/oc-zc2-bench")
    if not args.output.is_relative_to(lane) or args.output == lane or args.output.exists():
        parser.error("Output must be a new directory below /private/tmp/oc-zc2-bench")
    metadata = plistlib.loads((args.base / "Contents/Info.plist").read_bytes())
    if metadata["CFBundleIdentifier"] != "ai.openclaw.mac.tcctest":
        parser.error("Only the tcctest base application is allowed")
    base_entitlements = entitlements(args.base)
    args.output.mkdir(parents=True)
    receipts = {"base": str(args.base), "base_commit": metadata["OpenClawGitCommit"],
                "assessment_only": True, "variants": []}
    environment = dict(os.environ, DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer",
                       SIGN_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
                       PYTHONDONTWRITEBYTECODE="1", TMPDIR=str(lane / "tmp"))
    environment.pop("OPENCLAW_SKIP_MLX_TTS", None)
    environment["SDKROOT"] = environment["DEVELOPER_DIR"] + "/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
    signer = Path(__file__).resolve().parent / "codesign-mac-app.sh"
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    receipts["base_validation"] = []
    run(["codesign", "--verify", "--deep", "--strict", args.base], receipts["base_validation"])
    for name in ("B", "T", "A", "F"):
        log = []
        row = {"name": name, "commands": log, "success": False}
        receipts["variants"].append(row)
        app = args.output / name / "OpenClaw.app"
        app.parent.mkdir()
        try:
            started = time.monotonic()
            if libc.clonefile(os.fsencode(args.base), os.fsencode(app), 1):
                raise OSError(ctypes.get_errno(), "APFS clonefile")
            log.append({"operation": "APFS clonefile", "seconds": time.monotonic() - started})
            runtime = app / "Contents/Resources/runtime"
            if name == "T":
                owner = args.trim_root / "scripts/lib/desktop-runtime-prune.mjs"
                run(["node", owner, runtime / "lib/node_modules"], log)
            elif name == "A":
                owner = args.archive_root / "scripts/archive-mac-runtime.py"
                run(["/usr/bin/python3", owner, app], log, env=environment)
            elif name == "F":
                shutil.rmtree(runtime)
                (runtime / "bin").mkdir(parents=True)
                run(["/bin/cp", "-c", args.fat_executable.resolve(strict=True), runtime / "bin/bun"], log)
                run(["/bin/cp", "-cR", args.sidecar.resolve(strict=True), runtime / "bin/runtime"], log)
            # No build occurs here: each signer invocation owns a private app copy.
            run(["/bin/bash", signer, app], log, env=environment)
            run(["codesign", "--verify", "--deep", "--strict", app], log)
            signature = run(["codesign", "-dvv", app], log).decode()
            if "Authority=Developer ID Application:" not in signature or "runtime" not in signature:
                raise RuntimeError("Developer ID hardened runtime signature required")
            if entitlements(app) != base_entitlements:
                raise RuntimeError("Application entitlements changed")
            assessment = subprocess.run(["spctl", "-a", "-vv", str(app)], capture_output=True)
            row.update(app=str(app), app_source_commit=metadata["OpenClawGitCommit"],
                       success=True, signature=signature, spctl_exit=assessment.returncode,
                       spctl_output=(assessment.stdout + assessment.stderr).decode(errors="replace"))
        except Exception as error:
            row["error"] = str(error)
        (args.output / "assembly.json").write_text(json.dumps(receipts, indent=2) + "\n")
        print(json.dumps({k: v for k, v in row.items() if k != "commands"}), flush=True)
    variants = [{k: row[k] for k in ("name", "app", "app_source_commit")}
                for row in receipts["variants"] if row["success"]]
    (args.output / "manifest.json").write_text(json.dumps({"variants": variants}, indent=2) + "\n")


if __name__ == "__main__":
    main()
