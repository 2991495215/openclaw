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

# A hand-assembled .app omits the private worker runtime. That would remove the
# producer under investigation and could look like a successful catalog repair.
corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate
pnpm install --frozen-lockfile --prefer-offline > "$output/install.log" 2>&1
BUILD_CONFIG=debug BUILD_ARCHS="$(uname -m)" \
  BUNDLE_ID=ai.openclaw.mac.catalog-proof.debug \
  SIGN_IDENTITY=- ALLOW_ADHOC_SIGNING=1 \
  OPENCLAW_SKIP_MLX_TTS=1 SKIP_PNPM_INSTALL=1 \
  OPENCLAW_PACKAGE_APP_ROOT="$source_root/dist/OpenClawCatalogProof.app" \
  /bin/bash scripts/package-mac-app.sh > "$output/package.log" 2>&1

app="$source_root/dist/OpenClawCatalogProof.app"
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
printf '%s\n' 'Packaged inputs verified; runtime connection and catalog proof have not run.' > "$output/build-status.txt"
