---
summary: "Versioned managed-research adapters over existing plugin RPC"
title: "Research adapters"
read_when:
  - Implementing or qualifying a managed research provider
---

`openclaw/plugin-sdk/research-adapter-contract` defines version 1 request,
descriptor, snapshot, and reply schemas, plus the typed `isResearchAdapterRequest`
ingress check. The Google provider consumes this contract through `google.research.v1`.
It is not a general adapter registry. The next stack layer connects the bundled
research feature to this explicitly selected endpoint.

The feature owns logical jobs, polling, cancellation intent, recovery, budgets,
and stable result publication. A provider owns its endpoint, authentication,
remote handle and attribution parsing. `describe` distinguishes a full managed
research service from ordinary native search tools. Search grounding alone is
not a managed-research capability.

Requests use `{ version: 1, action: "describe" | "start" | "poll" | "cancel" }`.
Start carries `question`, optional `output` and `asOf`; poll/cancel carry the
provider's opaque `handle`. RPC parameters wrap this as `request`, alongside
`sessionKey` and `agentId` for the existing session-access policy. Responses have
`version: 1` and either `ok: true, value` or `ok: false, state, reason`.
Unknown versions, shapes, services, and unsupported constraints fail explicitly.

Google is activated through `plugins.entries.google.config.research`, with
`enabled: true` and an existing `profileId`. Registration loads no credentials
and makes no network calls. The provider requires the same pinned API-key
profile for start, poll and cancel. It rejects OAuth and profile substitution.
Every external effect checks current session authority after preparation.

Provider citations attribute generated report text; they are not fetched source
passages. Their optional `startByte`/`endByte` offsets are UTF-8 bytes into the
report. Adapters must omit thought/tool traces, bound their outputs, preserve
partial states, and never infer successful cancellation from a successful HTTP
response alone. A create without a recorded remote receipt is indeterminate:
there is no automatic submission retry without documented provider idempotency.

The portable foundation is documented in the bundled deep-research README. No consumer OAuth, Codex managed-research RPC, or cross-auth-mode proof
is implied by this contract.
