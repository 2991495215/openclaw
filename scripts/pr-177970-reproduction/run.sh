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
cleanup() {
  for pid in "$proxy_pid" "$backend_pid"; do
    if [[ -n $pid ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
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
cp "$helpers/project.yml" "$helpers/SavedGatewayOpeningUITests.swift" "$project/"
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
    pnpm install --frozen-lockfile --prefer-offline --optional \
      --filter '@openclaw/mermaid-renderer...' --filter '@openclaw/gateway-protocol...'
    node scripts/prepare-apple-mermaid.mjs
    git diff --exit-code
    test "$(git write-tree)" = "$expected_tree"
    test -z "$(git ls-files --others --exclude-standard -- apps/macos/Sources apps/shared)"
    swift build --package-path apps/macos --build-system native --product OpenClaw \
      --disable-keychain --disable-netrc --disable-index-store --jobs 3
  ) > "$output/$stage/build.log" 2>&1
  products="$(swift build --package-path "$checkout/apps/macos" --build-system native --show-bin-path)"
  app="$scratch/$stage-OpenClaw.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"
  cp "$products/OpenClaw" "$app/Contents/MacOS/OpenClaw"
  cp "$checkout/apps/macos/Sources/OpenClaw/Resources/Info.plist" "$app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier ai.openclaw.mac.saved-gateway-proof' "$app/Contents/Info.plist"
  for resource in "$products/"*.bundle; do
    [[ ! -d $resource ]] || cp -R "$resource" "$app/Contents/Resources/"
  done
  sparkle="$checkout/apps/macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
  test -d "$sparkle"
  cp -R "$sparkle" "$app/Contents/Frameworks/"
  compat="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-6.2/macosx/libswiftCompatibilitySpan.dylib"
  [[ ! -f $compat ]] || cp "$compat" "$app/Contents/Frameworks/"
  codesign --force --deep --sign - "$app" > "$output/$stage/signing.log" 2>&1
  shasum -a 256 "$products/OpenClaw" "$app/Contents/MacOS/OpenClaw" > "$output/$stage/executable-hashes.txt"
  test "$(git -C "$checkout" write-tree)" = "$expected_tree"
  git -C "$checkout" diff --exit-code
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
      case_state="$scratch/$stage-$native-$entry"
      mkdir -p "$case_dir" "$case_state/home/Library/Preferences" "$case_state/home/Library/Keychains" "$case_state/state"
      app_home="$case_state/home"
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
      export TEST_RUNNER_OPENCLAW_PROOF_FRAMEWORKS="$app/Contents/Frameworks:$products"
      export TEST_RUNNER_OPENCLAW_PROOF_STAGE="$stage"
      export TEST_RUNNER_OPENCLAW_PROOF_NATIVE="$native"
      export TEST_RUNNER_OPENCLAW_PROOF_ENTRY="$entry"
      status=0
      xcodebuild "${xcode_args[@]}" test-without-building \
        -only-testing:SavedGatewayProofUITests/SavedGatewayOpeningUITests/testSavedGatewayOpening \
        -resultBundlePath "$case_dir/result.xcresult" > "$case_dir/xctest.log" 2>&1 || status=$?
      printf '%s\n' "$status" > "$case_dir/xctest.exit"
      kill -0 "$backend_pid" "$proxy_pid"
      curl --fail --silent http://127.0.0.1:19879/state > "$case_dir/network-final.json"
      cleanup; backend_pid=""; proxy_pid=""
      xcrun xcresulttool export attachments --path "$case_dir/result.xcresult" --output-path "$case_dir/attachments"
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
