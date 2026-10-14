#!/bin/bash
# Assessment bundle only: the native child-launch contract is not integrated.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${1:-}" != --locked ]]; then
  exec lockf -k -t "${BENCH_BUILD_LOCK_TIMEOUT:-600}" \
    "$HOME/.cache/codex-task-runs/bun-runtime-replacement-20260929/mac-build.lock" \
    /bin/bash "$0" --locked "$@"
fi
shift
if [[ "$#" != 4 ]]; then
  echo "Usage: $0 <template.app> <fat-executable> <slim-runtime> <new-output.app>" >&2
  exit 2
fi
TEMPLATE="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1")"
EXECUTABLE="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$2")"
SIDECAR="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$3")"
OUTPUT="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$4")"
case "$OUTPUT" in
  /private/tmp/oc-zc2-bench/*.app) ;;
  *) echo "Output must be a new app below /private/tmp/oc-zc2-bench" >&2; exit 2 ;;
esac
[[ ! -e "$OUTPUT" && ! -L "$OUTPUT" && -d "$TEMPLATE" && -f "$EXECUTABLE" && -d "$SIDECAR" ]]
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export SDKROOT="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
export SIGN_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)"
unset OPENCLAW_SKIP_MLX_TTS
/bin/bash "$ROOT/scripts/apple-release-source-check.sh" \
  --root "$ROOT" --expected-commit "$(git -C "$ROOT" rev-parse HEAD)"
/usr/bin/codesign --verify --deep --strict "$TEMPLATE"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$TEMPLATE/Contents/Info.plist")" == ai.openclaw.mac.tcctest ]]
/bin/cp -cR "$TEMPLATE" "$OUTPUT"
# Mutating a copied root symlink would mutate the original template instead.
[[ -d "$OUTPUT" && ! -L "$OUTPUT" &&
   -d "$OUTPUT/Contents" && ! -L "$OUTPUT/Contents" &&
   -d "$OUTPUT/Contents/Resources" && ! -L "$OUTPUT/Contents/Resources" ]]
RUNTIME="$OUTPUT/Contents/Resources/runtime"
/bin/rm -rf "$RUNTIME"
/bin/mkdir -p "$RUNTIME/bin"
/bin/cp -c "$EXECUTABLE" "$RUNTIME/bin/bun"
/bin/cp -cR "$SIDECAR" "$RUNTIME/bin/runtime"
# bin/bun receives the release signer's JIT entitlements; all nested native code
# is signed before the enclosing app. The unchanged native shell keeps its policy.
/bin/bash "$ROOT/scripts/codesign-mac-app.sh" "$OUTPUT"
/usr/bin/codesign --verify --deep --strict "$OUTPUT"
echo "Assessment bundle ready: $OUTPUT"
