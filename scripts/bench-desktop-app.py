#!/usr/bin/env python3
"""Signed app inventory and open-to-native-entry bounds on fresh APFS clones."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time

EXPECTED = b"OpenClaw elevation rename requires absolute source and destination paths\n"


def checked(command, **kwargs):
    return subprocess.run(command, check=True, capture_output=True, **kwargs)


def stop_native(app):
    executable = str(app / "Contents/MacOS/OpenClaw")
    def pids():
        rows = subprocess.check_output(["ps", "-axo", "pid=,comm="], text=True).splitlines()
        return [int(fields[0]) for row in rows
                if len(fields := row.strip().split(None, 1)) == 2 and fields[1] == executable]
    for sig in (15, 9):
        for pid in pids():
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 3
        while pids() and time.monotonic() < deadline:
            time.sleep(0.05)
    if pids():
        raise RuntimeError("Diagnostic app still running; retain the trial copy")


def inventory(app):
    files = links = logical = allocated = 0
    for directory, dirs, names in os.walk(app):
        for name in dirs + names:
            entry = Path(directory) / name
            stat = entry.lstat()
            if entry.is_symlink():
                links += 1
            elif entry.is_file():
                files += 1
                logical += stat.st_size
                allocated += stat.st_blocks * 512
    return {"regular_files": files, "symlinks": links, "logical_bytes": logical,
            "allocated_bytes_not_unique_extents": allocated}


def cleanup(profile, root):
    actions = []
    for base in ("ai.openclaw.gateway-profiles", "ai.openclaw.onboarding-route-binding", "ai.openclaw.tls-pinning"):
        service = base + ".profile." + profile
        while True:
            result = subprocess.run(["security", "delete-generic-password", "-s", service], capture_output=True)
            if result.returncode == 44:
                break
            if result.returncode != 0:
                raise RuntimeError(f"Keychain cleanup failed for {service}: exit {result.returncode}")
            actions.append(service)
    for base in ("ai.openclaw.mac", "ai.openclaw.mac.tcctest"):
        domain = base + ".profile." + profile
        subprocess.run(["defaults", "delete", domain], capture_output=True)
        (Path.home() / "Library/Preferences" / (domain + ".plist")).unlink(missing_ok=True)
    state = Path.home() / (".openclaw-" + profile)
    if state.exists():
        shutil.rmtree(state)
    lock = Path(f"/private/tmp/openclaw-{os.getuid()}-app-instances/ai.openclaw.mac.profile.{profile}.lock")
    lock.unlink(missing_ok=True)
    shutil.rmtree(root)
    return actions


def boundary(app, work, profile, timeout):
    work.mkdir()
    stderr = work / "stderr"
    stdout = work / "stdout"
    environment = {"HOME": str(work), "CFFIXED_USER_HOME": str(work),
                   "OPENCLAW_PROFILE": profile, "OPENCLAW_STATE_DIR": str(work / "state"),
                   "OPENCLAW_CONFIG_PATH": str(work / "state/openclaw.json"),
                   "CODEX_HOME": str(work / "codex"), "CLAUDE_CONFIG_DIR": str(work / "claude"),
                   "TMPDIR": str(work), "NSUnbufferedIO": "YES"}
    command = ["/usr/bin/open", "-n", "-W", "-g", "--stdout", str(stdout), "--stderr", str(stderr)]
    for key, value in environment.items():
        command.extend(["--env", key + "=" + value])
    command.extend([str(app), "--args", "--elevation-rename-exclusive"])
    row = {"profile": profile, "load_start": os.getloadavg(), "started": time.time(), "success": False}
    started = time.monotonic()
    process = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        while time.monotonic() - started < timeout:
            if stderr.exists() and stderr.read_bytes():
                row["open_to_entry_output_s"] = time.monotonic() - started
                break
            if process.poll() is not None:
                break
            time.sleep(0.005)
        else:
            raise TimeoutError("Native diagnostic entrypoint did not respond")
        out, err = process.communicate(timeout=10)
        row.update(open_exit=process.returncode, expected_entry_output=stderr.exists() and stderr.read_bytes() == EXPECTED,
                   stdout_empty=not stdout.exists() or not stdout.read_bytes(), open_output=(out + err).decode())
        if not row["expected_entry_output"]:
            raise RuntimeError("Unexpected diagnostic response")
        row["success"] = True
    except Exception as error:
        row["error"] = str(error)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        if process is not None and "open_output" not in row:
            out, err = process.communicate(timeout=5)
            row["open_output"] = (out + err).decode(errors="replace")
        stop_native(app)
        row["load_end"] = os.getloadavg()
        row["diagnostic_stdout"] = stdout.read_text(errors="replace") if stdout.exists() else ""
        row["diagnostic_stderr"] = stderr.read_text(errors="replace") if stderr.exists() else ""
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--trials", default=5, type=int)
    parser.add_argument("--timeout", default=120, type=float)
    args = parser.parse_args()
    args.output = args.output.resolve()
    if args.trials < 5:
        parser.error("At least five trials required")
    args.output.mkdir(parents=True, exist_ok=True)
    variants = json.loads(args.manifest.read_text())["variants"]
    result = {"distributions": {}, "trials": []}
    for variant in variants:
        if not variant.get("app"):
            continue
        app = Path(variant["app"]).resolve()
        variant["app"] = str(app)
        checked(["codesign", "--verify", "--deep", "--strict", str(app)])
        metadata = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        if metadata["CFBundleIdentifier"] != "ai.openclaw.mac.tcctest":
            raise ValueError("Only the tcctest bundle is allowed")
        if metadata.get("OpenClawGitCommit") != variant["app_source_commit"]:
            raise ValueError("The signed app does not match the pinned source commit")
        architecture = checked(["lipo", "-archs", str(app / "Contents/MacOS/OpenClaw")]).stdout.decode().strip()
        if architecture != "arm64":
            raise ValueError("This comparison requires an arm64-only app")
        signature = checked(["codesign", "-dvv", str(app)]).stderr.decode()
        if "Authority=Developer ID Application:" not in signature or "runtime" not in signature:
            raise ValueError("Developer ID and hardened runtime are required")
        row = inventory(app)
        row["source_commit"] = metadata["OpenClawGitCommit"]
        row["architecture"] = architecture
        row["signature"] = signature
        archive = args.output / (variant["name"] + ".zip")
        started = time.monotonic()
        checked(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(archive)])
        row.update(zip_bytes=archive.stat().st_size, zip_seconds=time.monotonic() - started)
        archive.unlink()
        result["distributions"][variant["name"]] = row
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    for index in range(1, args.trials + 1):
        for variant in variants:
            if not variant.get("app"):
                continue
            root = args.output / f"trial-{index}-{variant['name']}"
            root.mkdir()
            copy = root / "OpenClaw.app"
            if libc.clonefile(os.fsencode(variant["app"]), os.fsencode(copy), 1):
                raise OSError(ctypes.get_errno(), "APFS clonefile")
            try:
                for phase in ("fresh", "repeat"):
                    profile = f"bench-{variant['name'].lower()}-{index}-{phase}-{time.time_ns()}"
                    work = root / phase
                    try:
                        row = boundary(copy, work, profile, args.timeout)
                        row.update(variant=variant["name"], index=index, phase=phase)
                        result["trials"].append(row)
                    finally:
                        cleanup(profile, work)
                    (args.output / "app-results.json").write_text(json.dumps(result, indent=2) + "\n")
                    print(json.dumps(row), flush=True)
            finally:
                stop_native(copy)
                checked(["/bin/rm", "-rf", str(root)])


if __name__ == "__main__":
    main()
