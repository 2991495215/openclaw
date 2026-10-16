# Parked wave-6 package and Synology cleanup

This branch is not ready for a PR or landing. It preserves the 28 source/test files dropped from bundle A under the operator's rule 8. No changelog, persisted schema, dependency, protocol version, or Phase E mechanism is changed.

The code packet is the exact inverse of the package/Synology restoration in `47777f82f97121ae7d50da0cd44956c94da66c22`, recovered from `c742b8ecfb4b861bd766b3f0dd419497091c908c`. All 28 restoration-base paths were byte-identical on this branch's fresh main base `49ecf708273078eee3b2f9257389f3c2495b5ebc` before application. This is preservation of the dropped proposal, not a new correctness or passing-proof claim.

The packet removes 25 production lines net (24 from z13 packages and one Synology `cleanupExpired()` call). Its complete code/test delta is +142/-154, or 12 lines removed net; this branch-only note is excluded from those counts. Lane credit: z13 and z10.

## Why it is parked

Bundle run 38828635628 failed the Synology outbound-media suite's global `afterAll` cleanup hook after 180 seconds. The serial head/base attempt did not settle attribution: the head remained in compiled-worker preparation without cases and the isolated baseline did not finish. No load-only timeout was treated as a product defect or passing replay. Every changed package file reachable from the test, related tests and the retired event-listener file were restored together, plus the changed Synology outbound-media source.

Bundle A's later exact-head run 38838042570 passed all 93 jobs after that restoration and the separately reviewed one-shot test repair. That green run does not validate this parked packet. An older API report found one additive internal compaction constant; its package inputs are restored away in the landable bundle and present again here.

## Best-effort tradeoffs accepted in the proposal

- Typed internal producer facts are consumed without duplicate inspection; external network, persisted input, depth, byte and authority boundaries remain.
- Same-callback re-registration may let an older disposer remove that callback's current registration. Read-only refusal bookkeeping can be released by an older successful read; server admission re-parks announced drains and write exclusion remains.
- Abandoned schema iterators own only task-local traversal sets and need no abort-only unwind. Normal cycle/depth checks remain.
- Exotic getters or `toJSON` that change typed compaction data during synchronous capture can be rejected at the next persisted read. Identity, output-token and escaped-envelope bounds remain at capture.

## Required before promotion

Fresh independent Keychain review on October 15 found a P2 correctness regression in the preserved gateway-client proposal: callback identity does not preserve subscription identity. A stale disposer can remove a replacement registration, and removing/re-adding a callback during dispatch can deliver an event that predates the replacement. This finding is not accepted as a tradeoff. The exact dropped packet is intentionally preserved here, not approved for landing; restore per-registration identity and prove stale-disposer and replacement-during-dispatch behavior before promotion.

Re-establish the Synology test and shared package lifecycle boundary on a qualified host using identical head/base configuration and serial execution; preserve teardown, FIFO, write settlement, authority and failure assertions. If attribution remains inconclusive, keep this packet parked. Passing an isolated replay alone is not a demonstrated cleanup fix.

Run touched type graphs and focused tests, the SDK API comparison, boundary/cycle/suppression checks and fresh independent review for the actual proposed head. Any future PR needs its own exact-head CI. Remove this branch-only note before proposing a landable change. No live channel/provider, credential or device proof is claimed here.
