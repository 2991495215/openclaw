#!/bin/bash
# External XCTest and development-bundle pattern from mac-narration-proof/e0a75bdc3dd7.
set -euo pipefail
[[ ${CI:-} == true && ${GITHUB_ACTIONS:-} == true && ${RUNNER_OS:-} == macOS ]]
[[ ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
[[ $MAIN_SHA == 74ca496bf40e1e702e824aa597620b9e1798efab ]]
[[ $CANDIDATE_SHA == fbb30e598cdad1e284058798bc6c6b5eaf80f2e5 ]]
proof_repo="$(cd "$1" && pwd)"
output="$2"
helpers="$proof_repo/scripts/pr-177970-reproduction"
scratch="$(mktemp -d "$RUNNER_TEMP/saved-gateway.XXXXXX")"
mkdir -p "$output"
backend_pid=""
proxy_pid=""
case_state=""
cleanup() {
  for pid in "$proxy_pid" "$backend_pid"; do
    if [[ -n $pid ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
}
cleanup_all() {
  cleanup
  if [[ -n $case_state ]]; then rm -rf -- "$case_state"; fi
}
trap cleanup_all EXIT
{
  printf 'Proof revision: %s\nMain: %s\nCandidate: %s\n' "$(git -C "$proof_repo" rev-parse HEAD)" "$MAIN_SHA" "$CANDIDATE_SHA"
  sw_vers
  xcodebuild -version
  swift --version
  node --version
  printf 'Disposable GitHub-hosted VM. Synthetic loopback Gateway. No release or TCC proof.\n'
} > "$output/environment.txt"

project="$scratch/ui-tests"
mkdir -p "$project"
cp "$helpers/project.yml" "$helpers/SavedGatewayOpeningUITests.swift" "$helpers/NativeProofLaunchSupport.swift" "$project/"
xcodegen generate --spec "$project/project.yml" --project "$project" > "$output/project.log" 2>&1
xcode_args=(-project "$project/SavedGatewayProof.xcodeproj" -scheme SavedGatewayProof
  -destination 'platform=macOS' -derivedDataPath "$scratch/derived" -parallel-testing-enabled NO)
xcodebuild "${xcode_args[@]}" build-for-testing > "$output/runner-build.log" 2>&1

# Fail before compiling either OpenClaw revision if this VM cannot drive AppKit.
preflight="$scratch/DesktopPreflight.app"
mkdir -p "$preflight/Contents/MacOS"
swiftc -parse-as-library "$helpers/DesktopPreflightApp.swift" -o "$preflight/Contents/MacOS/DesktopPreflight"
python3 - "$preflight/Contents/Info.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as out:
    plistlib.dump({'CFBundleIdentifier':'ai.openclaw.proof.desktop-preflight',
                  'CFBundleExecutable':'DesktopPreflight','CFBundleName':'DesktopPreflight',
                  'CFBundleVersion':'1','CFBundleShortVersionString':'1',
                  'CFBundlePackageType':'APPL','NSPrincipalClass':'NSApplication'}, out)
PY
codesign --force --deep --sign - "$preflight" > "$output/preflight-signing.log" 2>&1
export TEST_RUNNER_OPENCLAW_PROOF_APP="$preflight"
xcodebuild "${xcode_args[@]}" test-without-building \
  -only-testing:SavedGatewayProofUITests/SavedGatewayOpeningUITests/testDesktopPreflight \
  -resultBundlePath "$output/preflight.xcresult" > "$output/preflight.log" 2>&1
xcrun xcresulttool export attachments --path "$output/preflight.xcresult" --output-path "$output/preflight-attachments"

git -C "$proof_repo" fetch --no-tags --depth=1 origin "$MAIN_SHA" "$CANDIDATE_SHA"
for stage in main candidate; do
  if [[ $stage == candidate ]]; then
    # A fixture failure or lack of a real baseline reproduction is not a reason
    # to spend another app build or report a successful fix.
    baseline_status=0
    python3 - "$output" <<'PY' || baseline_status=$?
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
paths = list((root/'main').glob('*/case-result.json'))
results = [json.loads(p.read_text()) for p in paths]
clean = len(paths) == 4 and all(
    (p.parent/'xctest.exit').read_text().strip() == '0' and
    json.loads((p.parent/'network-final.json').read_text()).get('backendFailures') == 0 and
    result['openingFinished'].get('backendFailures') == 0
    for p, result in zip(paths, results))
if not clean or not any(result['bugReproduced'] for result in results):
    status = 'not_reproduced' if clean and all(result['windowReady'] for result in results) else 'inconclusive'
    (root/'verdict.json').write_text(json.dumps({'status':status,'flows':results}, indent=2))
    raise SystemExit(42)
PY
    if [[ $baseline_status -eq 42 ]]; then exit 0; fi
    if [[ $baseline_status -ne 0 ]]; then exit "$baseline_status"; fi
  fi
  revision="$MAIN_SHA"; [[ $stage != candidate ]] || revision="$CANDIDATE_SHA"
  checkout="$scratch/$stage-source"
  git -C "$proof_repo" worktree add --detach "$checkout" "$revision"
  expected_tree="$(git -C "$checkout" rev-parse HEAD^{tree})"
  mkdir -p "$output/$stage"
  printf '%s\n%s\n' "$revision" "$expected_tree" > "$output/$stage/source.txt"
  (
    cd "$checkout"
    corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate
    pnpm install --frozen-lockfile --prefer-offline
    git diff --exit-code
    git diff --cached --exit-code
    test "$(git write-tree)" = "$expected_tree"
    test -z "$(git ls-files --others --exclude-standard -- apps/macos/Sources apps/shared)"
    if [[ $stage == main ]]; then
      printf '%s  %s\n' b75dbf19b1b19f8e0a5529cbc51563f6194cc29ae12d52450c32e83675704530 "$REUSED_MAIN_ARCHIVE" | shasum -a 256 -c
      mkdir -p "$checkout/dist"
      ditto -x -k "$REUSED_MAIN_ARCHIVE" "$checkout/dist"
      printf '%s  %s\n' 2778d903d14b37b7ace7a5711e22ac3f2c281b6fc4501dcbe78fbf5c7ae57ab4 "$checkout/dist/OpenClawSavedGatewayProof.app/Contents/MacOS/OpenClaw" | shasum -a 256 -c
      echo 'Reused verified main bundle from run39824266784; no main rebuild.'
    else
      # Startup runs the matching credential Doctor before enabling the app UI.
      # Use the maintained package owner so that runtime and native bytes agree.
      BUILD_CONFIG=debug BUILD_ARCHS="$(uname -m)" \
        BUNDLE_ID=ai.openclaw.mac.saved-gateway-proof.debug \
        SIGN_IDENTITY=- ALLOW_ADHOC_SIGNING=1 \
        OPENCLAW_SKIP_MLX_TTS=1 SKIP_PNPM_INSTALL=1 \
        OPENCLAW_PACKAGE_APP_ROOT="$checkout/dist/OpenClawSavedGatewayProof.app" \
        /bin/bash scripts/package-mac-app.sh
    fi
  ) > "$output/$stage/build.log" 2>&1
  app="$checkout/dist/OpenClawSavedGatewayProof.app"
  runtime="$app/Contents/Resources/runtime"
  test -x "$app/Contents/MacOS/OpenClaw"
  test -x "$runtime/bin/bun"
  test -f "$runtime/lib/node_modules/openclaw/openclaw.mjs"
  test "$(/usr/libexec/PlistBuddy -c 'Print :OpenClawGitCommit' "$app/Contents/Info.plist")" = "$revision"
  codesign --verify --deep --strict "$app" > "$output/$stage/signing.log" 2>&1
  shasum -a 256 "$app/Contents/MacOS/OpenClaw" "$runtime/bin/bun" > "$output/$stage/executable-hashes.txt"
  test "$(git -C "$checkout" write-tree)" = "$expected_tree"
  git -C "$checkout" diff --exit-code
  git -C "$checkout" diff --cached --exit-code
  test -z "$(git -C "$checkout" ls-files --others --exclude-standard -- apps/macos/Sources apps/shared)"

  fixture="$scratch/$stage-fixture"
  mkdir -p "$fixture"
  # The same trusted protocol fixture is used for both product revisions.
  git -C "$proof_repo" show "$MAIN_SHA:scripts/test-ios-shell-gateway.mjs" > "$fixture/backend.mjs"
  cp "$helpers/gateway.mjs" "$fixture/"
  node - "$proof_repo/package.json" "$fixture/package.json" <<'JS'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.writeFileSync(process.argv[3], JSON.stringify({private:true,dependencies:{ws:pkg.dependencies.ws},packageManager:pkg.packageManager}));
JS
  pnpm --dir "$fixture" install --ignore-scripts > "$output/$stage/fixture-install.log" 2>&1
  for native in false true; do
    for entry in menu settings; do
      case_dir="$output/$stage/$native-$entry"
      # Native IPC resolves HOME independently of OPENCLAW_STATE_DIR.
      # A nested runner HOME previously exceeded Darwin's 104-byte sun_path.
      case_state="$(mktemp -d /tmp/ocp.XXXXXX)"
      mkdir -p "$case_dir" "$case_state/home/Library/Preferences" "$case_state/home/Library/Keychains" "$case_state/state"
      app_home="$case_state/home"
      chmod 700 "$case_state" "$app_home" "$case_state/state"
      python3 - "$app_home" "$case_state/state" "$case_dir/socket-paths.json" <<'PYTHON'
import json, pathlib, sys
home, state = [pathlib.Path(value).resolve() for value in sys.argv[1:3]]
support = home/'Library/Application Support'
paths = {
    'macControl': home/'.openclaw-gatewayproof/mac-control.sock',
    'executionApprovals': state/'exec-approvals.sock',
    'cuaDriver': support/'OpenClaw/cua/0123456789abcdef/cua.sock',
    **{name: support/name/'bridge.sock' for name in ['OpenClaw', 'clawdbot', 'clawdis', 'moltbot']},
}
rows = {name: {'path': str(path), 'bytes': len(str(path).encode())} for name, path in paths.items()}
pathlib.Path(sys.argv[3]).write_text(json.dumps(rows, indent=2))
if any(row['bytes'] >= 104 for row in rows.values()):
    raise SystemExit('Synthetic HOME cannot support the native Unix socket paths')
PYTHON
      keychain="$app_home/Library/Keychains/proof.keychain-db"
      HOME="$app_home" CFFIXED_USER_HOME="$app_home" security create-keychain -p '' "$keychain"
      HOME="$app_home" CFFIXED_USER_HOME="$app_home" security unlock-keychain -p '' "$keychain"
      HOME="$app_home" CFFIXED_USER_HOME="$app_home" security set-keychain-settings "$keychain"
      HOME="$app_home" CFFIXED_USER_HOME="$app_home" security list-keychains -d user -s "$keychain"
      HOME="$app_home" CFFIXED_USER_HOME="$app_home" security default-keychain -d user -s "$keychain"
      HOME="$app_home" CFFIXED_USER_HOME="$app_home" defaults write ai.openclaw.mac.profile.gatewayproof openclaw.onboardingSeen -bool true
      HOME="$app_home" CFFIXED_USER_HOME="$app_home" defaults write ai.openclaw.mac.profile.gatewayproof openclaw.onboardingVersion -int 8
      node - "$case_state/state/openclaw.json" <<'JS'
require('node:fs').writeFileSync(process.argv[2],JSON.stringify({gateway:{mode:'remote',remote:{transport:'direct',url:'ws://127.0.0.1:19876',token:'synthetic-primary-token'}}}));
JS
      node "$fixture/backend.mjs" --port=19877 > "$case_dir/backend.log" 2>&1 &
      backend_pid=$!
      node "$fixture/gateway.mjs" > "$case_dir/proxy.log" 2>&1 &
      proxy_pid=$!
      for attempt in {1..30}; do
        if curl --fail --silent http://127.0.0.1:19879/state > "$case_dir/initial.json"; then break; fi
        kill -0 "$backend_pid" "$proxy_pid"
        sleep 1
      done
      curl --fail --silent http://127.0.0.1:19879/state > "$case_dir/initial.json"
      export TEST_RUNNER_OPENCLAW_PROOF_APP="$app"
      export TEST_RUNNER_OPENCLAW_PROOF_HOME="$app_home"
      export TEST_RUNNER_OPENCLAW_PROOF_STATE="$case_state/state"
      export TEST_RUNNER_OPENCLAW_PROOF_CONFIG="$case_state/state/openclaw.json"
      export TEST_RUNNER_OPENCLAW_PROOF_STAGE="$stage"
      export TEST_RUNNER_OPENCLAW_PROOF_NATIVE="$native"
      export TEST_RUNNER_OPENCLAW_PROOF_ENTRY="$entry"
      status=0
      case_started="$(date '+%Y-%m-%d %H:%M:%S')"
      printf '%s\n' "$case_started" > "$case_dir/startup-start.txt"
      xcodebuild "${xcode_args[@]}" test-without-building \
        -only-testing:SavedGatewayProofUITests/SavedGatewayOpeningUITests/testSavedGatewayOpening \
        -resultBundlePath "$case_dir/result.xcresult" > "$case_dir/xctest.log" 2>&1 || status=$?
      printf '%s\n' "$status" > "$case_dir/xctest.exit"
      case_finished="$(date '+%Y-%m-%d %H:%M:%S')"
      /usr/bin/log show --style json --start "$case_started" --end "$case_finished" --info \
        --predicate 'subsystem == "ai.openclaw" AND (category == "credentials" OR category == "mac-control")' \
        > "$case_state/startup.raw.json" 2> "$case_state/log-show.stderr" || true
      if [[ $status -ne 0 ]] && ! pgrep -f "$app/Contents/MacOS/OpenClaw" >/dev/null; then
        python3 - "$runtime" "$app_home" "$case_state/state" "$case_state/doctor.raw.json" <<'PYTHON'
import json, os, pathlib, signal, subprocess, sys
runtime, home, state, output = map(pathlib.Path, sys.argv[1:])
package = runtime/'lib/node_modules/openclaw'
environment = dict(os.environ, HOME=str(home), CFFIXED_USER_HOME=str(home),
    OPENCLAW_PROFILE='gatewayproof', OPENCLAW_STATE_DIR=str(state),
    OPENCLAW_CONFIG_PATH=str(state/'openclaw.json'), PATH=str(runtime/'bin'),
    OPENCLAW_SQLITE_LIBRARY=str(runtime/'lib/libsqlite3.dylib'))
command = [str(runtime/'bin/bun'), str(package/'openclaw.mjs'), '--profile', 'gatewayproof',
           'doctor', '--client-credentials', '--fix', '--non-interactive']
process = subprocess.Popen(command, cwd=package, env=environment, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, start_new_session=True)
try:
    stdout, stderr = process.communicate(timeout=300)
    report = dict(attempted=True, exitCode=process.returncode, timedOut=False,
                  stdout=stdout, stderr=stderr)
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
    report = dict(attempted=True, exitCode=process.returncode, timedOut=True)
output.write_text(json.dumps(report))
PYTHON
      fi
      (
        cd "$checkout"
        node --import ./scripts/tsx.mjs --input-type=module - "$case_state/startup.raw.json" "$case_dir/startup.json" "$case_state/doctor.raw.json" <<'JS'
import fs from 'node:fs';
import { redactSensitiveText } from './src/logging/redact.ts';
const [input, output, doctorPath] = process.argv.slice(2);
let records;
let available = true;
try { records = JSON.parse(fs.readFileSync(input, 'utf8')); }
catch { records = []; available = false; }
const doctor = fs.existsSync(doctorPath) ? JSON.parse(fs.readFileSync(doctorPath, 'utf8')) : {attempted:false};
for (const key of ['stdout','stderr']) {
  if (typeof doctor[key] === 'string') doctor[key] = redactSensitiveText(doctor[key], {mode:'tools'});
}
const selected = records.filter(row => row.subsystem === 'ai.openclaw' &&
  ['credentials', 'mac-control'].includes(row.category));
fs.writeFileSync(output, JSON.stringify({ records: selected.map(row => ({
  timestamp: row.timestamp, category: row.category,
  message: redactSensitiveText(String(row.eventMessage ?? ''), {mode:'tools'}),
})), available, doctor }, null, 2));
JS
      )
      kill -0 "$backend_pid" "$proxy_pid"
      curl --fail --silent http://127.0.0.1:19879/state > "$case_dir/network-final.json"
      cleanup; backend_pid=""; proxy_pid=""
      xcrun xcresulttool export attachments --path "$case_dir/result.xcresult" --output-path "$case_dir/attachments"
      if [[ $status -ne 0 && ! -f "$output/$stage/app.zip" ]]; then
        codesign --verify --deep --strict "$app"
        ditto -c -k --sequesterRsrc --keepParent "$app" "$output/$stage/app.zip"
        shasum -a 256 "$output/$stage/app.zip" > "$output/$stage/app.zip.sha256"
      fi
      python3 - "$case_dir" <<'PY'
import json, pathlib, shutil, sys
root = pathlib.Path(sys.argv[1]); directory = root/'attachments'
manifest = json.loads((directory/'manifest.json').read_text())
matches = [item for test in manifest for item in test['attachments'] if item['suggestedHumanReadableName'].startswith('case-result')]
if len(matches) != 1:
    raise SystemExit('No complete native-flow result; inspect XCTest/fixture diagnostics')
shutil.copyfile(directory/matches[0]['exportedFileName'], root/'case-result.json')
PY
      if pgrep -f "$app/Contents/MacOS/OpenClaw" > "$case_dir/unexpected-processes.txt"; then
        echo 'The app did not terminate; refusing to contaminate the next case.' >&2
        exit 1
      fi
      HOME="$app_home" CFFIXED_USER_HOME="$app_home" security delete-keychain "$keychain"
      rm -rf -- "$case_state"
      case_state=""
      if [[ $stage == candidate && $status -ne 0 ]]; then exit "$status"; fi
    done
  done
  git -C "$checkout" diff --exit-code
  test "$(git -C "$checkout" write-tree)" = "$expected_tree"
  test -z "$(git -C "$checkout" ls-files --others --exclude-standard -- apps/macos/Sources apps/shared)"
done
python3 - "$output" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
results = {stage:[json.loads(p.read_text()) for p in (root/stage).glob('*/case-result.json')]
           for stage in ['main','candidate']}
for stage in results:
    for path in (root/stage).glob('*/case-result.json'):
        if ((path.parent/'xctest.exit').read_text().strip() != '0' or
            json.loads((path.parent/'network-final.json').read_text()).get('backendFailures') != 0):
            raise SystemExit('Failed or backend-contaminated native-flow evidence')
if any(len(rows) != 4 for rows in results.values()):
    raise SystemExit('Incomplete native-flow evidence')
if not any(row['bugReproduced'] for row in results['main']):
    raise SystemExit('No baseline reproduction')
if any(row['bugReproduced'] or not row['windowReady'] for row in results['candidate']):
    raise SystemExit('Candidate did not repair the observed flow')
(root/'verdict.json').write_text(json.dumps({'status':'reproduced_and_candidate_verified','flows':results}, indent=2))
PY
