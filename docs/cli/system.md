---
doc-schema-version: 1
summary: "CLI reference for `openclaw system` (session events and presence)"
read_when:
  - You want to submit a session event without creating an automation
  - You want to inspect system presence entries
  - You are replacing retired heartbeat CLI commands
title: "System"
---

# `openclaw system`

System-level helpers for the Gateway: submit session events and view presence.
Use `openclaw automations` to manage recurring checks and migrated heartbeat jobs.

All `system` subcommands use Gateway RPC and accept the shared client flags:

| Flag                    | Default                              | Description                                                                                                           |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `--url <url>`           | `gateway.remote.url` when configured | Gateway WebSocket URL.                                                                                                |
| `--port <port>`         | none                                 | Local Gateway port.                                                                                                   |
| `--token <token>`       | none                                 | Gateway token, if required.                                                                                           |
| `--password <password>` | none                                 | Gateway password, if required.                                                                                        |
| `--timeout <ms>`        | `30000`                              | RPC timeout in milliseconds.                                                                                          |
| `--expect-final`        | off                                  | Accepted as a shared client flag, but has no effect on system commands.                                               |
| `--json`                | off                                  | Print JSON for `system event`, which otherwise prints `ok`. `system presence` always prints the raw RPC JSON payload. |

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system event --text "Check for urgent follow-ups" --mode now --url ws://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
openclaw automations list --all
openclaw system presence
```

## `system event`

Submit a system event to the agent's **main** session by default. Use `--mode now`
to request ordinary session processing. It works without a periodic monitor or
an enabled automation scheduler.

The command returns when the Gateway accepts the event, not when the session
turn finishes. `--expect-final` does not wait for an agent response.

Pass `--session-key` to target a specific session, for example to relay an
async-task completion back to the channel that started it. Prefer an
agent-qualified key. For example, if the `ops` agent is configured:

```bash
openclaw system event --text "Deploy finished" --session-key agent:ops:main --mode now
```

The retained `next-heartbeat` mode is the compatibility default. An untargeted
request defers to the corresponding scheduled automation; an unavailable target
returns an actionable result. A request with an explicit `--session-key` retains
its immediate behavior even with `--mode next-heartbeat`. Prefer `--mode now`
for immediate work and an automation's own schedule for delayed work.

Flags:

- `--text <text>`: required system event text.
- `--mode <mode>`: `now` or the deprecated `next-heartbeat` default.
- `--session-key <sessionKey>`: optional; target a specific agent session
  instead of the agent's main session. The Gateway rejects malformed
  agent-qualified keys, keys for unknown agents, targets that conflict with the
  caller's agent scope, and subagent sessions. Rejected targets do not fall back
  to the main session.

<a id="system-heartbeat-lastenabledisable" />

## Replacing heartbeat commands

`system heartbeat last|enable|disable` has been removed. Inspect the migrated
job's run history or enable and disable that job directly:

```bash
openclaw automations list --all
openclaw automations runs <jobId> --limit 50
openclaw automations enable <jobId>
openclaw automations disable <jobId>
```

External protocol v4 integrations retain deprecated `last-heartbeat` and
`set-heartbeats` adapters backed by ordinary automation state. Those adapters
apply only to the corresponding migrated or default jobs. They do not control all
automations or block immediate session follow-ups. See
[Heartbeat migration](/gateway/heartbeat).

## `system presence`

List the current system presence entries the Gateway knows about, including
nodes and instances.

## Notes

- Requires a running Gateway reachable through your current local or remote
  configuration.
- Queued system events are ephemeral and do not survive a Gateway restart.

## Related

- [CLI reference](/cli)
- [Automations CLI](/cli/cron)
- [Heartbeat migration](/gateway/heartbeat)
