# Desktop runtime layout benchmark

The harness measures supplied, frozen artifacts. It does not build or modify the
operator's installed application, Gateway, LaunchAgents, or credentials.

Write a JSON manifest with a `variants` array. Each runtime entry supplies `name`,
`source_commit`, `runtime`, and a `command` array (executable followed by fixed
arguments). Use absolute paths for executable/file arguments in command arrays;
children run inside isolated directories. App entries supply `name`, `app`, and `app_source_commit`. A missing
command or app is skipped; record the build failure in the final report.

```sh
python3 scripts/bench-desktop-runtime.py manifest.json \
  --output /private/tmp/oc-zc2-bench/runtime --trials 5
python3 scripts/bench-desktop-app.py manifest.json \
  --output /private/tmp/oc-zc2-bench/apps --trials 5
```

Use fresh output directories for each campaign. Runtime trials interleave in
manifest order. Each trial has an empty HOME, state, workspace, Codex directory,
and Claude directory. The only provider is a loopback Responses SSE fixture;
the Gateway must return the exact synthetic marker. The first trial also runs
Doctor. The memory plugin is disabled so background embeddings cannot contaminate
the Responses measurement. Raw logs and numerical receipts remain; isolated state is deleted after
the trial. Processes run in owned sessions, which are stopped before cleanup.

Cold readiness starts at process creation and ends at the first successful
`/readyz` response. Warm readiness restarts the same runtime with that trial's
state. Polling adds at most approximately 50 ms plus request scheduling delay.
The agent CLI measurement includes client startup and the first synthetic turn;
the Gateway-reported duration is recorded separately. RSS and cumulative CPU
time come from `ps` for the Gateway process only, excluding worker processes.
Load averages are captured at trial and CLI phase boundaries. Doctor failures
do not erase completed timing measurements.

App measurements reject mismatched source commits, bundle IDs, architectures,
or signatures. Every pair uses a new APFS clone, then repeats that same copy.
Each launch uses a separate profile. `open -n -W` starts the existing invalid
`--elevation-rename-exclusive` diagnostic, which prints a fixed error immediately
after main dispatch and exits before initialization or any rename. The measured
interval is an upper bound from `open` to main, including LaunchServices and
up to approximately 5 ms of observation delay. It is not a literal main timestamp.
Profiles, their two possible defaults domains/plists, exact Keychain namespaces,
and copies are removed after each pair. Native removal of the app copy runs
outside the launch timing interval. The app's ZIP uses the release-style
`ditto --sequesterRsrc --keepParent` format; allocated bytes are not unique APFS
extents. These measurements do not prove first-run seeding or dashboard readiness.

Build apps with the canonical release packager under the shared macOS build
lock, pinned Xcode, arm64, `ai.openclaw.mac.tcctest`, no MLX skip, and a clean
exact-commit release source check. Alternatively, isolate bundle-layout cost
using one signed release base and the layout owners:

```sh
python3 scripts/bench-desktop-assessment.py --base /path/OpenClaw.app \
  --trim-root /path/trim-checkout --archive-root /path/archive-checkout \
  --fat-executable /path/openclaw-standalone --sidecar /path/runtime \
  --output /private/tmp/oc-zc2-bench/assessment
python3 scripts/bench-desktop-app.py \
  /private/tmp/oc-zc2-bench/assessment/manifest.json \
  --output /private/tmp/oc-zc2-bench/app-trials --trials 7
```

Assessment assembly uses private APFS copies and the canonical release signer,
without building or acquiring the build lock. It verifies deep/strict signatures,
Developer ID, hardened runtime, and unchanged app entitlements, and records
Gatekeeper assessment results. Unnotarized assessment bundles may be rejected by
Gatekeeper. B retains the base runtime; T applies the trim owner's pruning; A
uses the archive owner's packer; F substitutes the fat executable and sidecar.
The native shell remains the base version, so these layouts qualify distribution
and immediate-entry measurements only. First-run measurements require real
integrated apps. Record shell, layout-owner, and runtime source identities.

Compare fully successful runtime trials using sample count, median and minimum/maximum.
Keep failed trials' partial timings in the raw rows and report failure counts beside
the successful-trial summaries. App launch failures retain their diagnostics and
allow later trials to proceed after cleanup. Never convert missing or failed trials
to zero, combine different source cuts, or treat prior lane measurements as
trials from this campaign. Shared-host load and warm filesystem caches limit
causal claims even when ordering is interleaved. No cache purge is performed.
