# Ingress admission and recovery cursor

This experiment asks whether a fresh iMessage event can durably enter the
ingress queue and advance its recovery cursor with one worker request.
The cursor must never acknowledge an event before durable admission.

## Preregistered acceptance rule

- Flow: an isolated Gateway, the bundled iMessage plugin, synthetic JSON-RPC
  bridge, and loopback model provider. Use `scripts/bench-ingress-polling.mts`.
  Never use an operator's Messages database or Gateway state.
- Count first: attribute each fresh event's admission and recovery cursor to
  database, worker operation, executed SQL statements, and main-thread SQL.
  Keep boot, idle, event, and shutdown windows separate. Count all threads.
- Baseline attribution: 60 seconds idle, then ten sparse events on current main.
  Capture per-thread CPU profiles with the frozen SQL observer enabled.
  This first run establishes ownership and work counts, not a latency claim.
- Candidate win: strictly fewer admission/cursor worker requests per fresh
  event, no increase in SQL or main-thread work, and no weakened cursor,
  duplicate, failed-admission, restart, or stale-claim behavior.
- Comparison: five alternating baseline/candidate pairs, cold and warm reported
  separately. Report median, p95, minimum, and maximum for every metric.
- Dispatch latency: three ABBA blocks (12 arm runs), each containing ten events
  after 60 seconds idle and ten sparse events. For both cells, pooled candidate
  median and p95 must be at most `max(base * 1.10, base + 5 ms)`; every event
  must dispatch within five seconds. Report per-block medians and sample load.
  Any 20% adverse metric movement stops acceptance pending attribution.
- Wall-clock/CPU comparisons require the campaign timing lock and one-minute
  load below 24. After a 60-minute wait, report counts and CPU attribution only;
  do not claim latency acceptance. Counts, profiles, and tests need no timing lock.
- Preserve commit ordering. If stores differ, commit admission before cursor
  within the request; never combine separate databases into one transaction.
- Stop the implementation if fusion needs a new ownership contract between
  iMessage and ingress. Record the missing contract and measured baseline.
  Do not add an iMessage-specific core operation or bypass plugin-state ownership.

## Reproduction

Build the exact source head with the supported `qaRuntime` target, then run:

```sh
node --import ./scripts/tsx.mjs scripts/bench-ingress-polling.mts \
  --out "$INGRESS_PROOF" --observer "$FROZEN_OBSERVER" \
  --idle-seconds 60 --sparse-events 10 --cpu-profile
```

The output is synthetic. Extract statement shapes and operation counts, then
remove fixture databases, raw ledgers, and profiles. Retain only the small
aggregate report. If the pattern does not reproduce, stop this experiment.
