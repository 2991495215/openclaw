# Parked directive/config family changes

Do not open a PR from this branch as-is. It retains the pre-drop source snapshot
`374163d56497c29703ab2e7cbbc408f185127dd0` from PR #173394, including both the
dropped members below and the smaller speech/Voice Call cut retained for landing.
The latter must not be proposed twice. This branch is preservation evidence, not
a claim that the dropped changes caused or fixed either failure.

## Failing-test note

Exact-head CI run38797189603 failed:

- Job116637390824: `test/gateway.multi.e2e.test.ts`, “preserves scheduler runtime
  across a scheduler-disabled Gateway edit”: `cron.add` rejected because no
  route-compatible OpenAI authentication source was configured.
- Job116637385416: `src/gateway/server.sessions.create.durability.test.ts`,
  “recovers an acknowledged openclaw-control-ui first turn (worktree=true) before
  dispatch”: `chat.send` timed out, followed by hook/cleanup timeouts.

The coordinator required conservative import-graph removal, without another
baseline run. The trace follows static imports/exports including type edges,
literal dynamic/mock imports, tsconfig aliases, the subprocess source entry,
and real channel contract sidecars loaded by artifact name. It is an
over-approximation of imports, not a claim that every module executed.

Example chain: durability test → worktree service → config validation → secret
target registry → channel-contract API → official external fallback → channel
secret basic runtime. The contract API also resolves the actual bundled
secret-contract sidecars. Session-pending-input-history directly reaches the
normalization-core record-coerce module. Full witness chains remain in the
task's requested local coverage ledger.

## Dropped members preserved here

- Channel secret-assignment binding and collectors: core basic runtime, runtime
  shared collector, official external fallback; Buzz, GoogleChat, Matrix,
  Microsoft Teams, Nostr, and Slack sidecars; related tests/docs/ratchet entry.
- Shared undefined-property omission in normalization-core, its registration and
  speech SDK export, plus Azure/ElevenLabs/Fish/Google/Inworld/MiniMax/Microsoft/OpenAI/XAI
  and compatible-provider normalization callers and typed config guard cleanup.
- Reply exec/queue/inline directive cleanup and CLI config-input guard cleanup.
- TTS layered config, status, and settings cleanup, including its ratchet entry.
- Google/OpenRouter video-duration consolidation and its common owner/docs.
- Meeting-config consolidation: core browser meetings, Google Meet, private SDK
  owner and all package/export/path registrations and related tests/docs. Its
  package registration is reached by the graph, so the family was dropped whole.

These members require a separate diagnosis before any future proposal. UI and
SQLite-retirement failures had matching main evidence; neither was changed here.
No CI rerun, timeout increase, skip, suppression, or Phase E modification was used.
