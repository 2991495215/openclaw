#!/usr/bin/env python3
"""Main-only native catalog campaign. All runtime state belongs to this disposable VM."""
import hashlib
import json
import importlib.util
import os
from pathlib import Path
import plistlib
import re
import shutil
import shlex
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request

MAIN = "d535d274183d19e2e838c7a7fc96063df676b368"
if not (sys.platform == "darwin" and os.environ.get("GITHUB_ACTIONS") == "true" and
        os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted" and os.environ.get("MAIN_SHA") == MAIN):
    raise SystemExit("This runner is restricted to the reviewed main-only disposable macOS campaign")
repo = Path(sys.argv[1]).resolve(strict=True)
output = Path(sys.argv[2]).resolve()
bundle_output = Path(sys.argv[3]).resolve()
runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
for target in (output, bundle_output):
    if not target.is_relative_to(runner_temp) or target == runner_temp:
        raise SystemExit("Output escaped RUNNER_TEMP")
    target.mkdir()
helpers = repo / "scripts/pr-130115-reproduction"
launch_support = helpers / "NativeProofLaunchSupport.swift"
expected_launch_hash = os.environ.get("LAUNCH_SUPPORT_SHA256")
if not expected_launch_hash or not launch_support.is_file() or hashlib.sha256(launch_support.read_bytes()).hexdigest() != expected_launch_hash:
    raise SystemExit("The reviewed shared launch/permission helper from owner 177970 is required before any build")
scratch = Path(tempfile.mkdtemp(prefix="cn.", dir=runner_temp))
home_root = Path(tempfile.mkdtemp(prefix="h", dir=runner_temp))
homes = {f"h{index}": home_root / str(index) for index in (1, 2, 3)}
for home in homes.values():
    home.mkdir(mode=0o700)
(output / "scratch-root.txt").write_text(str(scratch) + "\n")
for name in ("seed-home", "tmp", "bin", "a", "b", "c"):
    (scratch / name).mkdir(mode=0o700)
base_env = {key: os.environ[key] for key in ("PATH", "DEVELOPER_DIR", "HOME", "USER", "LOGNAME") if key in os.environ}
base_env.update({"TMPDIR": str(scratch / "tmp"),
                 "CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                 "RUNNER_OS": "macOS", "RUNNER_TEMP": str(runner_temp)})
reused_bundle = Path(os.environ["REUSED_MAIN_BUNDLE"]).resolve(strict=True)
if not reused_bundle.is_relative_to(runner_temp) or reused_bundle == runner_temp:
    raise SystemExit("Reused bundle escaped the disposable runner")
base_env["REUSED_MAIN_BUNDLE"] = str(reused_bundle)
steps = []
loopback = urllib.request.build_opener(urllib.request.ProxyHandler({}))
controller = None
app = None
codex = None
current_case = None
cleanup_failed = False
custody = None
custody_file = None
custody_stop = None
custody_thread = None
custody_error = None

def write_json(target, value):
    Path(target).write_text(json.dumps(value, indent=2) + "\n")

def file_hash(target):
    digest = hashlib.sha256()
    with Path(target).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

def run(args, log, env=None, check=True, timeout=None, cwd=None):
    log = Path(log)
    log.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with log.open("wb") as stream:
        result = subprocess.run([str(a) for a in args], env=env or base_env, cwd=cwd or scratch,
                                stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
    steps.append({"command": [str(a) for a in args], "seconds": round(time.monotonic() - started, 3),
                  "exit": result.returncode, "log": str(log)})
    write_json(output / "steps.json", steps)
    if check and result.returncode:
        raise RuntimeError(f"Step failed ({result.returncode}); inspect {log}")
    return result.returncode

def native_environment(home, state):
    return {**base_env, "HOME": str(home), "CFFIXED_USER_HOME": str(home),
            "OPENCLAW_PROFILE": "default", "OPENCLAW_STATE_DIR": str(state)}

def prepare_keychain(app_home, directory):
    # Security's legacy preferences writer does not create this parent directory.
    (app_home / "Library/Preferences").mkdir(parents=True, exist_ok=True, mode=0o700)
    keychains = app_home / "Library/Keychains"
    keychains.mkdir(parents=True, exist_ok=True, mode=0o700)
    keychain = keychains / "catalog-proof.keychain-db"
    environment = {**base_env, "HOME": str(app_home), "CFFIXED_USER_HOME": str(app_home)}
    commands = [["create-keychain", "-p", "", str(keychain)], ["unlock-keychain", "-p", "", str(keychain)],
                ["set-keychain-settings", str(keychain)], ["list-keychains", "-d", "user", "-s", str(keychain)],
                ["default-keychain", "-d", "user", "-s", str(keychain)]]
    for index, args in enumerate(commands):
        run(["/usr/bin/security", *args], directory / f"keychain-{index}.log", env=environment)
    for query in ("default-keychain", "list-keychains"):
        log = directory / f"keychain-{query}-readback.log"
        run(["/usr/bin/security", query, "-d", "user"], log, env=environment)
        found = [Path(value).resolve(strict=True) for value in shlex.split(log.read_text())]
        if found != [keychain.resolve(strict=True)]:
            raise RuntimeError("A fresh Security process did not read back the isolated keychain")
    service = "ai.openclaw.proof.keychain-canary"
    account = "synthetic-preflight"
    value = "synthetic-value-no-credential"
    run(["/usr/bin/security", "add-generic-password", "-a", account, "-s", service, "-w", value],
        directory / "keychain-canary-add.log", env=environment)
    try:
        readback = directory / "keychain-canary-read.log"
        run(["/usr/bin/security", "find-generic-password", "-a", account, "-s", service, "-w"],
            readback, env=environment)
        if readback.read_text().strip() != value:
            raise RuntimeError("Isolated default keychain did not persist the synthetic canary")
    finally:
        run(["/usr/bin/security", "delete-generic-password", "-a", account, "-s", service],
            directory / "keychain-canary-delete.log", env=environment)
    return keychain, environment


def start_custody(source):
    global custody, custody_file, custody_stop, custody_thread, custody_error
    if custody_file is not None:
        raise RuntimeError("Campaign process custody must not be replaced between phases")
    module_spec = importlib.util.spec_from_file_location("catalog_process_custody", helpers / "process-custody.py")
    custody = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(custody)
    custody_file = output / "process-custody.json"
    # Both roots exist before seeding and remain private for the entire campaign.
    # Future Codex, package, desktop and seeded-runtime executables all stay here;
    # ancestry also retains children running system tools after they reparent.
    custody.initialize(custody_file, source / "scripts/pr-lib/darwin-process-identity.py",
                       [scratch, home_root])
    custody_stop = threading.Event()
    custody_error = None

    def monitor():
        global custody_error
        while not custody_stop.wait(0.2):
            try:
                custody.refresh(custody_file)
            except Exception as error:
                custody_error = str(error)
                return

    custody_thread = threading.Thread(target=monitor, name="catalog-process-custody", daemon=True)
    custody_thread.start()


def owned_processes():
    if custody_file is None:
        raise RuntimeError("Process custody was not initialized; drainage has not been observed")
    state = custody.refresh(custody_file)
    if custody_error or state["issues"]:
        raise RuntimeError(f"Process census is inconclusive: {custody_error or state['issues']}")
    return custody.live_rows(state)


def signal_owned(row, name):
    custody.refresh(custody_file, (row["identity"], row["executable"], name))


def drain(final=False, phase=None):
    global controller, cleanup_failed, custody_thread
    if controller is not None:
        if controller.poll() is None:
            # The unreaped Popen child retains its PID; descendants are retained
            # separately in custody rather than inferred from a command title.
            controller.send_signal(signal.SIGTERM)
        try:
            code = controller.wait(timeout=100)
            cleanup_failed |= code != 0
        except subprocess.TimeoutExpired:
            controller.kill()
            controller.wait(timeout=10)
            cleanup_failed = True
        controller = None
    observations = []
    remaining = None
    try:
        for _ in range(11):
            remaining = owned_processes()
            observations.append({"at": time.time(), "remaining": remaining})
            if not remaining:
                break
            time.sleep(1)
        if remaining:
            cleanup_failed = True
            for row in remaining:
                signal_owned(row, "SIGTERM")
            time.sleep(3)
            for row in owned_processes():
                signal_owned(row, "SIGKILL")
            time.sleep(1)
        remaining = owned_processes()
        cleanup_failed |= bool(remaining)
    except Exception as error:
        cleanup_failed = True
        remaining = None
        observations.append({"at": time.time(), "inconclusive": str(error)})
    finally:
        if final and custody_thread:
            custody_stop.set()
            custody_thread.join(timeout=5)
            cleanup_failed |= custody_thread.is_alive()
            custody_thread = None
    target = (current_case or output) / "process-drain.json"
    passes = json.loads(target.read_text()) if target.exists() else []
    passes.append({"phase": phase or ("campaign-final" if final else "case-complete"),
                   "custodyFile": str(custody_file) if custody_file else None,
                   "status": "inconclusive" if remaining is None else "incomplete" if cleanup_failed else "drained",
                   "observations": observations, "forcedOrUnclean": cleanup_failed, "remaining": remaining})
    write_json(target, passes)
    if cleanup_failed:
        raise RuntimeError("Process drainage is incomplete or inconclusive; no state restoration or next case is allowed")

def interrupted(signum, _frame):
    raise KeyboardInterrupt(f"Interrupted by signal {signum}")

signal.signal(signal.SIGTERM, interrupted)

try:
    proof_head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    if proof_head != os.environ.get("GITHUB_SHA"):
        raise RuntimeError("Proof checkout differs from the workflow head")
    names = ("run-main.py", "CatalogModeUITests.swift", "NativeProofLaunchSupport.swift", "catalog-control.mjs",
             "process-custody.py", "catalog-observer.mjs", "gateway-proof-call.mjs", "prepare-case.mjs", "seed-codex.mjs", "seed-claude-files.mjs", "build-catalog-app.sh")
    write_json(output / "provenance.json", {"productMain": MAIN, "proofHead": proof_head,
               "helperSHA256": {name: file_hash(helpers / name) for name in names},
               "scope": "main only; actual native app and Gateways; no candidate or merge"})
    run(["git", "-C", repo, "fetch", "--no-tags", "--depth=1", "origin", MAIN], output / "source-fetch.log")
    source = scratch / "main"
    run(["git", "-C", repo, "worktree", "add", "--detach", source, MAIN], output / "source-checkout.log")
    version_source = source / "extensions/codex/src/app-server/version.ts"
    if hashlib.sha256(version_source.read_bytes()).hexdigest() != "5e456450f2f5d22f70158ab360fb80c8ebcc55fe6aaf19f5e5a53650deb999c9":
        raise RuntimeError("Product Codex version pin differs from reviewed input")
    standalone_roots = []
    for directory in (scratch, home_root):
        for ancestor in (directory, *directory.parents):
            for name in ("tsconfig.json", "jsconfig.json", "bunfig.toml", "package.json", "pnpm-workspace.yaml"):
                if (ancestor / name).exists():
                    raise RuntimeError(f"Runtime root inherits a project configuration: {ancestor / name}")
        standalone_roots.append(str(directory))
    write_json(output / "standalone-runtime-roots.json", {"roots": standalone_roots, "ancestorProjectConfigs": []})
    start_custody(source)
    owned_processes()  # Reject an unreadable census before the first durable child.
    architecture = subprocess.check_output(["uname", "-m"], text=True).strip()
    triples = {"arm64": ("aarch64-apple-darwin", "b293a0fcdd871900a44c0a4f40a1aa401b31e02854f790ebdb8bd5d1177fd1fe"),
               "x86_64": ("x86_64-apple-darwin", "d68e39d8f62639f33f7d00656554cb9c3ef7809e664a3827e62ab3ace3c21b21")}
    triple, digest = triples[architecture]
    archive = scratch / "codex.tar.gz"
    run(["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
         "--max-time", "120", f"https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-{triple}.tar.gz",
         "-o", archive], output / "codex-download.log")
    if file_hash(archive) != digest:
        raise RuntimeError("Official Codex asset digest mismatch")
    codex = scratch / "bin" / f"codex-{triple}"
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        if len(members) != 1 or members[0].name != codex.name or not members[0].isfile():
            raise RuntimeError("Unexpected official Codex archive layout")
        with codex.open("xb") as target:
            shutil.copyfileobj(tar.extractfile(members[0]), target)
    codex.chmod(0o755)
    stores = [{"label": label, "root": str(scratch / label / ".codex")} for label in ("a", "b", "c")]
    stores.append({"label": "implicit", "root": str(homes["h3"] / ".codex")})
    claude_stores = [{**store, "root": str(Path(store["root"]).with_name(".claude"))} for store in stores]
    for store in stores + claude_stores:
        Path(store["root"]).mkdir(mode=0o700)
    seed_output = output / "seed"
    seed_output.mkdir()
    seed_input = scratch / "seed-input.json"
    write_json(seed_input, {"executable": str(codex), "expectedVersion": "0.162.1", "home": str(scratch / "seed-home"),
                           "output": str(seed_output), "stores": stores})
    run(["node", helpers / "seed-codex.mjs", seed_input], output / "seed.log")
    claude_input = scratch / "claude-input.json"
    write_json(claude_input, {"home": str(scratch / "seed-home"), "output": str(seed_output), "stores": claude_stores})
    run(["node", helpers / "seed-claude-files.mjs", claude_input], output / "claude-inputs.log")
    drain(phase="seed-complete")
    # Preserve only synthetic sources after the campaign census confirms seed drainage.
    with tarfile.open(bundle_output / "synthetic-sources.tar.gz", "w:gz", dereference=False) as tar:
        for name in ("a", "b", "c"):
            tar.add(scratch / name, arcname=name)
        tar.add(homes["h3"], arcname="implicit-home")
    (bundle_output / "scratch-root.txt").write_text(str(scratch) + "\n")
    write_json(bundle_output / "home-roots.json", {key: str(value) for key, value in homes.items()})
    cases = [("shared", "h1", "a", "a"), ("distinct", "h2", "a", "c"), ("isolated-home", "h3", "implicit", "implicit")]
    for label, home, _, _ in cases:
        run(["xcrun", "swift", helpers / "native-path-preflight.swift"], output / f"paths-{label}.json",
            env=native_environment(homes[home], scratch / f"case-{label}" / "app/state"))
    project = scratch / "ui"
    project.mkdir()
    for name in ("project.yml", "CatalogModeUITests.swift", "NativeProofLaunchSupport.swift"):
        shutil.copy2(helpers / name, project / name)
    run(["xcodegen", "generate", "--spec", project / "project.yml", "--project", project], output / "project.log")
    xcode = ["/usr/bin/xcodebuild", "-project", project / "CatalogModeProof.xcodeproj", "-scheme", "CatalogModeProof",
             "-destination", "platform=macOS", "-derivedDataPath", scratch / "derived", "-parallel-testing-enabled", "NO"]
    run(xcode + ["build-for-testing"], output / "test-runner-build.log")
    preflight = scratch / "DesktopPreflight.app"
    (preflight / "Contents/MacOS").mkdir(parents=True)
    run(["swiftc", "-parse-as-library", helpers / "DesktopPreflightApp.swift", "-o", preflight / "Contents/MacOS/DesktopPreflight"], output / "desktop-build.log")
    with (preflight / "Contents/Info.plist").open("wb") as stream:
        plistlib.dump({"CFBundleIdentifier": "ai.openclaw.proof.catalog-preflight", "CFBundleExecutable": "DesktopPreflight",
                      "CFBundleName": "DesktopPreflight", "CFBundleVersion": "1", "CFBundleShortVersionString": "1",
                      "CFBundlePackageType": "APPL", "NSPrincipalClass": "NSApplication"}, stream)
    run(["codesign", "--force", "--deep", "--sign", "-", preflight], output / "desktop-sign.log")
    ui_env = {**base_env, "TEST_RUNNER_OPENCLAW_PREFLIGHT_APP": str(preflight)}
    run(xcode + ["test-without-building", "-only-testing:CatalogModeProofUITests/CatalogModeUITests/testDesktopPreflight",
                 "-resultBundlePath", output / "desktop.xcresult"], output / "desktop.log", env=ui_env)
    app = scratch / "installed/OpenClawCatalogProof.app"
    run(["/bin/bash", helpers / "build-catalog-app.sh", source, MAIN, output / "build", seed_output / "seed.json", app], output / "package-wrapper.log")
    write_json(bundle_output / "main-bundle-reference.json", {"runId": 39833929614, "artifactId": 12452308201,
               "artifactSHA256": "2be735384558987d132b48d28131ab4f886d920d974e3a7eec8652fabd74bb62",
               "mainAppSHA256": (reused_bundle / "main-app.sha256").read_text().strip()})
    shutil.copy2(output / "build/source.txt", bundle_output / "source.txt")
    shutil.copy2(output / "build/executable-hashes.txt", bundle_output / "executable-hashes.txt")
    scope_source = source / "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannelSupport.swift"
    if file_hash(scope_source) != "69fa976eb8dd6547702948341b92dc396a0d4aaa7d48cec0516efb9e348364e1":
        raise RuntimeError("Native scope source differs from the reviewed pin")
    scope_block = scope_source.read_text().split("public static let defaultOperatorConnectScopes: [String] = [", 1)[1].split("]", 1)[0]
    rpc_scopes = re.findall(r'^\s*"(operator\.[a-z]+)",?\s*$', scope_block, re.MULTILINE)
    if len(rpc_scopes) != 6 or len(set(rpc_scopes)) != 6:
        raise RuntimeError("Pinned native app scope contract could not be read")
    write_json(output / "gateway-scope-contract.json", {"main": MAIN, "source": str(scope_source),
               "sourceSHA256": file_hash(scope_source), "scopes": rpc_scopes, "callerIdentity": "cli",
               "priorTextCliEvidence": {"runId": 39846976479, "artifactId": 12455278799,
                                        "result": "catalog read rejected: missing scope operator.write"}})
    rpc_adapter = scratch / "rpc/gateway-proof-call.mjs"
    rpc_adapter.parent.mkdir(mode=0o700)
    shutil.copy2(helpers / rpc_adapter.name, rpc_adapter)
    results = []
    for label, home, mac_owner, local_owner in cases:
        current_case = output / label
        current_case.mkdir()
        app_home = homes[home]
        case_input = scratch / f"{label}-input.json"
        values = {"app": str(app), "appHome": str(app_home), "codexExecutable": str(codex),
                  "seed": str(seed_output / "seed.json"), "claudeSeed": str(seed_output / "claude-inputs.json"),
                  "caseRoot": str(scratch / f"case-{label}"), "output": str(current_case), "stage": "main",
                  "localPort": 19861, "remotePort": 19862, "controlPort": 19863,
                  "rpcAdapter": str(rpc_adapter), "rpcScopes": rpc_scopes,
                  "macOwner": mac_owner, "localOwner": local_owner, "remoteOwner": "b"}
        if label == "isolated-home":
            values["implicitMacHome"] = str(app_home)
        write_json(case_input, values)
        run(["node", helpers / "prepare-case.mjs", case_input], current_case / "prepare.log")
        launch_file = Path(values["caseRoot"]) / "launch.json"
        launch = json.loads(launch_file.read_text())
        control_spec = Path(launch["controlSpec"])
        control_values = json.loads(control_spec.read_text())
        if label == cases[0][0]:
            target = control_values["local"]
            run([target["executable"], rpc_adapter, target["entry"], "--check-import", "{}",
                 target["gatewayUrl"], "45000", json.dumps(rpc_scopes)], current_case / "public-sdk-import.json",
                env=target["rpcEnvironment"], cwd=target["home"], timeout=60)
            imported = json.loads((current_case / "public-sdk-import.json").read_text())
            if imported["scopes"] != rpc_scopes or imported["adapterSHA256"] != file_hash(helpers / rpc_adapter.name):
                raise RuntimeError("SDK caller differs from the reviewed helper or pinned native scopes")
            drain(phase="sdk-import-complete")
        keychain, security_env = prepare_keychain(app_home, current_case)
        for key, kind, value in (("openclaw.onboardingSeen", "-bool", "true"), ("openclaw.onboardingVersion", "-int", "8")):
            run(["defaults", "write", "ai.openclaw.mac.catalog-proof.debug", key, kind, value], current_case / f"defaults-{key}.log", env=security_env)
        control_values["processCustody"] = str(custody_file)
        control_values["pythonExecutable"] = sys.executable
        write_json(control_spec, control_values)
        with (current_case / "controller.log").open("wb") as log:
            controller = subprocess.Popen(["node", str(helpers / "catalog-control.mjs"), launch["controlSpec"]],
                                          env=base_env, cwd=values["caseRoot"], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(30):
            if controller.poll() is not None:
                raise RuntimeError("Controller exited before admission")
            try:
                with loopback.open(launch["controlURL"] + "/live", timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError("Controller did not bind its isolated loopback port")
        with loopback.open(launch["controlURL"] + "/ready", timeout=180) as response:
            (current_case / "gateway-ready.json").write_bytes(response.read())
        ui_env = {**base_env, "TEST_RUNNER_OPENCLAW_CATALOG_PLAN": launch["uiPlan"],
                  "TEST_RUNNER_OPENCLAW_CATALOG_CONTROL": launch["controlURL"]}
        status = run(["python3", helpers / "capture-native-launch.py", launch_file, current_case, "--", *xcode,
                      "test-without-building", "-only-testing:CatalogModeProofUITests/CatalogModeUITests/testLocalRemoteLocalCatalogAccess",
                      "-resultBundlePath", current_case / "result.xcresult"], current_case / "capture.log", env=ui_env, check=False)
        (current_case / "xctest.exit").write_text(str(status) + "\n")
        drain()
        run(["/usr/bin/security", "delete-keychain", keychain], current_case / "keychain-cleanup.log", env=security_env)
        if (current_case / "result.xcresult").exists():
            run(["xcrun", "xcresulttool", "export", "attachments", "--path", current_case / "result.xcresult",
                 "--output-path", current_case / "attachments"], current_case / "attachment-export.log")
        results.append({"case": label, "xctestExit": status, "cleanup": "drained", "proofVerdict": "requires-source-and-pixel-review"})
        write_json(output / "main-results.json", {"main": MAIN, "cases": results, "candidateExecuted": False,
                   "claudeProofScope": "synthetic file discovery and reading, not CLI execution", "mergeAllowed": False})
        if status != 0:
            raise RuntimeError("Native main case failed; diagnose it before spending another case")
    if any(result["xctestExit"] for result in results):
        raise RuntimeError("One or more native main cases were inconclusive; inspect retained evidence")
finally:
    drain(final=True)
