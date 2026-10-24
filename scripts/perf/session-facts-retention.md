# Selected session-facts retention

`session-facts-retention.mjs` exercises the actual
`server-plugin-session-facts.ts` and `session-facts-read.ts` owners with a synthetic
projection, fixed caller authority, and ready PR responses. It does not start a
Gateway, open databases, authenticate a user, or contact GitHub. Integration tests
in `src/gateway/server-plugins.session-facts.test.ts` cover those owners with the
real projection and session fixture.

Run on the benchmark host with Node 26.12 and `--expose-gc`. `--owner-dir` names a
source tree containing both owner files at their usual `src/gateway/` paths. The
script uses the same loader and collaborators for each revision, records SHA-256
hashes of the loaded source, and adds only a diagnostic accessor for its private
cache. The shared immutable-data owner comes from the script's checkout.

```sh
node --expose-gc scripts/perf/session-facts-retention.mjs \
  --owner-dir /path/to/baseline --sessions 10800 --page 40
node --expose-gc scripts/perf/session-facts-retention.mjs \
  --owner-dir /path/to/candidate --sessions 10800 --page 40 --expect-bound
```

The workload prepares all synthetic selection targets before capture, warms two
read scopes, then alternates their 40-row rosters over 10,800 distinct sessions.
Prepared materialized rows end with each read; this represents archived pages
whose materialized rows can leave the projection. Four forced collections with
event-loop yields precede and follow the rotation. The script records cache entry
counts at quarter-way checkpoints and after the full rotation. `--expect-bound`
asserts the union of both retained rosters after every page.

One key then reenters the selection. Its PR result must be available after one
facts read, and the next unchanged read must do no additional facts work. This
checks recomputation work, not GitHub request counts: the PR I/O fixture already
has a ready result.

For paired measurements, run five fresh baseline/candidate process pairs under
an exclusive quiet slot, swap even/odd CPU sets and launch order, and use the
shared production guard. Pass the same fresh `--start-file` to both processes,
with `--side base` or `--side candidate`; each writes a `.SIDE.ready` marker after
warmup. Once both markers exist, write a future epoch-millisecond timestamp to
the start file. Both sides wait for that time before capture.

Acceptance: the candidate retains only the union of current rosters, reduces
post-GC retained heap, preserves PR output, and uses one facts read on reentry /
zero on the following unchanged read. Report all five samples and their spread.
`retainedHeapDeltaBytes` is the whole-process post-GC change from the warmed
fixture, not an exact dominator size. `releasedCacheBytes` is the post-GC drop when
the diagnostic clears the PR-facts cache after the reentry check; objects still
held by live scopes remain. Weak-container backing capacity and engine noise can
remain in either measurement. This workload makes no latency, allocation-rate,
promotion, GC-pause, or whole-Gateway performance claim.
