---
summary: "Bounded portable research and explicitly enabled provider-managed research"
title: "Deep Research"
read_when:
  - Researching a question across sources or supplied documents
  - Configuring Google managed research
---

Deep Research is a bundled, opt-in plugin with a lazy `deep_research`
tool. Enable `plugins.entries.deep-research.enabled` and allow `deep_research`
through the existing tool policy. It does not resolve research credentials, read job state, or make research
network requests at startup. Existing plugin allowlists and agent tool policy
still apply. Disable it with `plugins.entries.deep-research.enabled: false`.

## Choose an engine

| Engine               | Execution                                                   | Evidence                                                           | Configuration                                             |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `portable` (default) | Ordinary API completions plus configured search/fetch tools | Retrieved text, exact quotations, fallible model support audit     | Existing model and web-tool configuration                 |
| `google`             | Google's managed Deep Research Interactions service         | Provider-attributed report citations; not locally fetched passages | Explicit research enablement and a pinned API-key profile |

The portable engine does not require Codex, native function calling, or a
vendor-specific agent. Model overrides obey existing plugin LLM policy.
`requiredAuthMode: "oauth"` requires that mode through the existing auth owner;
it never silently falls back to an API key. This feature does not implement a
Codex research RPC or a private ChatGPT OAuth client. Codex API-key, Codex OAuth,
and ChatGPT plan-usage/token-sharing qualification are separate.

## Start and inspect research

Call the tool with a stable idempotency key for one request:

```json
{
  "action": "start",
  "idempotencyKey": "river-report-1",
  "request": {
    "question": "Compare the reported river restoration totals.",
    "engine": "portable",
    "asOf": "2026",
    "output": "A concise comparison with unresolved differences",
    "sources": { "urls": ["https://example.org/report"] },
    "budget": { "modelCalls": 8, "searches": 6, "fetches": 12, "parallelism": 2 }
  }
}
```

Keep the returned `jobId`. Subsequent calls use
`{ "action": "status" | "result" | "resume" | "cancel", "jobId": "..." }`.
`{ "action": "capabilities" }` reports the portable route and the explicitly
activated managed adapter; availability is not a live entitlement check.

A repeated start with the same key returns the existing job without resubmitting.
Changing the request under that key is rejected. Results are returned as tool
responses; the plugin never sends a separate channel message. Repeated result
reads return the same saved report, so there is no independently retried delivery.

## Portable evidence and budgets

All exploration branches share the model/search/fetch counters. Defaults are
8 model calls, 6 searches, 12 fetches, 2 parallel fetches, and a 180-second global
deadline. Maximums are 30, 20, 40, 4, and 900 seconds. Each model response requests
at most 4,096 output tokens. Token totals are observed, not a hard token or dollar
cap. Search and fetch use the originating session's normal tool policy.

Use `sources.allowDomains` / `denyDomains` to select accepted evidence.
Denied domains take precedence. These are evidence filters, not a network
firewall: search and redirect transports retain their own network policies.
Duplicate source text counts once. The retained corpus is limited to 60,000
UTF-8 bytes; omitted or unreadable material is reported as a gap.

Supply `sources.documents: [{ "title": "...", "text": "..." }]` for local-text
research. Documents disable public search by default; explicitly set
`sources.web: true` for mixed research. Explicit URLs may still be fetched.

Findings require substantive exact quotations and a separate model support/
contradiction check. Derived values additionally require mechanically checked
inputs, units, dates, and arithmetic. These checks do not establish truth or
completeness. Missing evidence, malformed model responses, inaccessible sources,
and exhausted budgets produce partial results with explicit gaps.

## Google managed research

Configure an existing Google API-key auth profile. No new auth store is used.

```json5
{
  plugins: {
    entries: {
      google: {
        config: {
          research: { enabled: true, profileId: "google:research" },
        },
      },
    },
  },
}
```

Then start with `request.engine: "google"`. The provider uses the documented
Gemini Interactions API and `deep-research-preview-04-2026`, with background
execution, storage enabled, web search and URL context. API billing and provider
storage apply. The same profile is required for start, poll, and cancel; a
profile change blocks reconciliation until the original profile is restored.

Google research rejects supplied documents/URLs, local source restrictions,
model/auth overrides, and hard call/search/token budgets. Use portable research
when those controls are required. For this engine, `durationMs` limits a single
local polling window (at most 60 seconds), not remote runtime or spend. A running
remote job returns paused and can be resumed with fresh conversation authority.
The provider's internal research budget is not controlled by OpenClaw.

## Recovery and cancellation

Job state and completed operation receipts use the existing plugin state store,
with a seven-day retention window and a capacity of 32 retained jobs per conversation generation. Restart
does not recreate the original caller's authority or silently continue paid work.
Explicitly resume in the same conversation generation. Reset/deletion/revocation
prevents old invocations from publishing or performing new effects.

An interrupted operation without a recorded receipt is not automatically
repeated. A managed submission with no recoverable remote handle is
`indeterminate`; inspect the provider account instead of starting it again.
Do not create a new idempotency key as an automatic retry for such a job.

Cancellation intent is persisted before stopping local work. Once a managed start
is admitted, cancellation waits for its receipt and then cancels that handle; it
does not discard the receipt by aborting the local request. Managed cancellation
is confirmed only by a terminal provider response; an HTTP success or aborted
local request does not prove the remote job stopped. A paused cancellation must
be resumed to reconcile it. Provider completion can win the cancellation race;
the observed final state is returned honestly.

## Qualification

Deterministic tests cover the controller, evidence ledger, registered provider
transport, recovery, and cancellation. They do not establish live provider
access, cancellation latency, billing, retention compliance, or research quality.
No native-service or OAuth live qualification is implied. See
[Research adapters](/plugins/research-adapters) for the versioned provider contract.
