#!/usr/bin/env bash
set -euo pipefail

harness=/tmp/openclaw-release-harness
source "$harness/scripts/lib/openclaw-e2e-instance.sh"
artifacts="${OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT:?missing artifact root}"
runtime="/tmp/openclaw-installed-recovery"
mkdir -p "$runtime/tmp" "$runtime/state-tmp" "$runtime/npm-cache" "$artifacts"
run_artifacts="$(node --input-type=module -e '
  import { startInstalledRecoveryRun } from "/tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs";
  process.stdout.write(startInstalledRecoveryRun(process.argv[1]).directory);
' "$artifacts")"
export TMPDIR="$runtime/tmp" OPENCLAW_TEST_STATE_TMPDIR="$runtime/state-tmp"
export npm_config_prefix="$runtime/npm-prefix" NPM_CONFIG_PREFIX="$runtime/npm-prefix"
export npm_config_cache="$runtime/npm-cache" NPM_CONFIG_CACHE="$runtime/npm-cache"
export npm_config_fund=false npm_config_audit=false npm_config_loglevel=error
export PATH="$npm_config_prefix/bin:$PATH"
export CI=true OPENCLAW_NO_ONBOARD=1 OPENCLAW_NO_PROMPT=1 OPENCLAW_DISABLE_BONJOUR=1
export GATEWAY_AUTH_TOKEN_REF=installed-recovery-fixture-token
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_FUNCTION_B64:?missing test-state function}"
openclaw_test_state_create installed-recovery empty
openclaw_e2e_install_package "$run_artifacts/install.log" "current recovery writer" "$npm_config_prefix"
openclaw_e2e_maybe_timeout 180s openclaw config set gateway \
  "$(cat "$harness/scripts/e2e/lib/upgrade-survivor/config-recipe/gateway.json")" --strict-json
openclaw_e2e_maybe_timeout 180s openclaw config set plugins.enabled false --strict-json
node "$harness/scripts/e2e/lib/upgrade-survivor/installed-recovery.mjs" \
  "$run_artifacts" "$npm_config_prefix" "$OPENCLAW_CURRENT_PACKAGE_TGZ" "$OPENCLAW_CONFIG_PATH" \
  "$artifacts/installed-recovery.json"
