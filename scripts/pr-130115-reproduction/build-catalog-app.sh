#!/bin/bash
# Preparation only: run from the reviewed native GUI proof after its desktop preflight.
set -euo pipefail

[[ ${CI:-} == true && ${GITHUB_ACTIONS:-} == true && ${RUNNER_OS:-} == macOS ]]
[[ ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
[[ $# -eq 4 ]]
source_root="$(cd "$1" && pwd -P)"
expected_sha="$2"
output="$3"
seed_receipt="$4"
[[ $expected_sha =~ ^[a-f0-9]{40}$ ]]
runner_temp="$(cd "$RUNNER_TEMP" && pwd -P)"
case "$source_root" in "$runner_temp"/*) ;; *) echo 'Product checkout must be disposable.' >&2; exit 2 ;; esac
case "$output" in "$runner_temp"/*) ;; *) echo 'Evidence must be under RUNNER_TEMP.' >&2; exit 2 ;; esac
[[ -n ${DEVELOPER_DIR:-} && -d "$DEVELOPER_DIR" ]]
mkdir -p "$output"
cd "$source_root"
[[ $(git rev-parse HEAD) == "$expected_sha" ]]
expected_tree="$(git rev-parse HEAD^{tree})"
git diff --exit-code
git diff --cached --exit-code

# Validate the real Codex seed and exact runtime version before installation or compilation.
node --input-type=module - "$seed_receipt" "$runner_temp" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [, , receipt, root] = process.argv;
if (!fs.realpathSync(receipt).startsWith(root + path.sep)) throw new Error('Seed receipt escaped RUNNER_TEMP');
const seed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
const source = fs.readFileSync('extensions/codex/src/app-server/version.ts', 'utf8');
const pinned = source.match(/export const CODEX_APP_SERVER_VERSION = "([^"]+)";/)?.[1];
if (!pinned || seed.version?.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] !== pinned ||
    seed.seedVersion !== 2 || seed.status !== 'visible_messages_read_by_fresh_codex_process' ||
    seed.modelResponseMode !== 'synthetic_loopback' || seed.externalModelRequestsPermitted !== false ||
    !(seed.turnsStarted >= 3) || seed.turnsStarted !== seed.fixtures?.length ||
    seed.syntheticModelResponses !== seed.turnsStarted || seed.networkCanaries?.deniedHits !== 0 ||
    !seed.networkCanaries?.deniedExit || seed.networkCanaries?.allowedResponse !== 'loopback-ready' ||
    !seed.fixtures.every(row => ['legacy', 'paginated'].includes(row.readback?.historyMode))) {
  throw new Error('Real visible seed readback and the selected product runtime pin are required before packaging');
}
if (!fs.realpathSync(seed.executable).startsWith(root + path.sep) ||
    createHash('sha256').update(fs.readFileSync(seed.executable)).digest('hex') !== seed.executableHash) {
  throw new Error('The Codex binary differs from the verified seed runtime');
}
JS

# Reuse the exact official package preserved by the preceding main-only run.
# The source pin, archive digest, native hashes and signature are checked again.
reused_bundle="$(cd "$REUSED_MAIN_BUNDLE" && pwd -P)"
case "$reused_bundle" in "$runner_temp"/*) ;; *) echo 'Reused bundle escaped RUNNER_TEMP.' >&2; exit 2 ;; esac
[[ $(sed -n '1p' "$reused_bundle/source.txt") == "$expected_sha" ]]
[[ $(sed -n '2p' "$reused_bundle/source.txt") == "$expected_tree" ]]
archive_hash="$(cat "$reused_bundle/main-app.sha256")"
[[ $archive_hash =~ ^[a-f0-9]{64}$ ]]
printf '%s  %s\n' "$archive_hash" "$reused_bundle/main-app.zip" | shasum -a 256 -c
mkdir -p "$source_root/dist"
ditto -x -k "$reused_bundle/main-app.zip" "$source_root/dist"
app="$source_root/dist/OpenClawCatalogProof.app"
[[ $(wc -l < "$reused_bundle/executable-hashes.txt" | tr -d ' ') == 2 ]]
expected_native_hash="$(sed -n '1s/ .*//p' "$reused_bundle/executable-hashes.txt")"
expected_bun_hash="$(sed -n '2s/ .*//p' "$reused_bundle/executable-hashes.txt")"
[[ $expected_native_hash =~ ^[a-f0-9]{64}$ && $expected_bun_hash =~ ^[a-f0-9]{64}$ ]]
printf '%s  %s\n' "$expected_native_hash" "$app/Contents/MacOS/OpenClaw" \
  "$expected_bun_hash" "$app/Contents/Resources/runtime/bin/bun" | shasum -a 256 -c
runtime="$app/Contents/Resources/runtime"
[[ -x "$app/Contents/MacOS/OpenClaw" && -x "$runtime/bin/bun" ]]
[[ -f "$runtime/lib/node_modules/openclaw/openclaw.mjs" ]]
[[ -f "$runtime/lib/libsqlite3.dylib" ]]
[[ $(/usr/libexec/PlistBuddy -c 'Print :OpenClawGitCommit' "$app/Contents/Info.plist") == "$expected_sha" ]]
codesign --verify --deep --strict "$app"
git diff --exit-code
git diff --cached --exit-code
[[ $(git rev-parse HEAD^{tree}) == "$expected_tree" ]]
[[ -z $(git ls-files --others --exclude-standard -- apps/macos/Sources apps/shared) ]]
shasum -a 256 "$app/Contents/MacOS/OpenClaw" "$runtime/bin/bun" > "$output/executable-hashes.txt"
printf '%s\n%s\n' "$expected_sha" "$expected_tree" > "$output/source.txt"
printf '%s\n' "$app" > "$output/app-path.txt"
printf '%s\n' 'Reused official package verified; runtime connection and catalog proof have not run.' > "$output/build-status.txt"
