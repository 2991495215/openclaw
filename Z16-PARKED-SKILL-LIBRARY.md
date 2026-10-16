# Parked z16 small-helper consolidation

PR #173431 originally proposed 808 net production lines removed at signed head
9eb718292dd97729e153b0261ecd39e6cf4fc58e. This branch preserves that reviewed cut.
Do not land it as-is: the coordinator instructed us to park changes reachable
from the unresolved skill-library request-timeout test instead of retaining an
unattributed failure in the landing candidate.

The owning CI parser and source-alias resolver traced
test/e2e/qa-lab/runtime/skill-library-worker-wire.e2e.test.ts through 14,192 source
files, including type-only edges conservatively. It reaches 211 changed files.
Restoring the shared owners also requires restoring connected consumers and
SDK/test/registration changes so removed exports are not left in use.

The landing branch restores 354 of 355 changed paths to main snapshot
5462f7f146436a50a56354dd39f8405eaeb5b60f, verified byte-for-byte. The follow-up
main-object AST/alias graph reaches 14,203 files, including sandbox/hash: that
helper is restored too. Only the independent LM Studio compatibility-list
shallow-copy removal remains in the landing PR (1 added/1 removed, 0 net LOC).
No timeout, assertion, retry, skip, SDK budget, or security boundary was relaxed.

The original helper-family inventory and provenance decisions remain useful,
but parked candidates are not claimed as landed. Phase E standalone session
memory backend, its factory, registry, expiry, federation and tests are protected.

The coordinator authorized one exact iPad Rust-download DNS job rerun; it passed
in run38825262926 attempt2/job116785668269. No second rerun. Previously matched
unrelated-PR/scheduled-main failures retain their accepted inherited attribution.
