# omp extension

The omp half of omp-hermes-bridge. It registers every main omp session, reports turn ends and questions as events, and takes prompts and answers from an inbox. It works without Hermes: a missing Hermes, a failed webhook or a broken queue never blocks or fails the omp session.

The wire format is defined only by [`../contract/`](../contract/README.md). This extension uses only the public omp extension API (`pi.on`, `pi.registerTool`, `pi.sendUserMessage`, `pi.pi.getAgentDir`, and the `ctx` timer and session methods).

## Install

Requires omp 18.10.4 or newer, checked against the official types of 18.10.4 (the pinned dev dependency) and run on a 18.14.0 binary; older versions are not supported. [Bun](https://bun.sh) is the omp runtime.

Try it for one run:

```sh
omp -e /path/to/omp-hermes-bridge/omp/src/index.ts
```

Load it every time: list the directory (it has `omp.extensions` in `package.json`) or the file in the `extensions:` list of omp's `config.yml`, or install the directory as an omp plugin.

```yaml
extensions:
  - /path/to/omp-hermes-bridge/omp
```

The extension has no runtime dependencies and imports nothing from omp at run time (`import type` only). `bun install` is only needed to run the tests and the type check.

## Configuration

One JSON file, mode 0600. Default location: `hermes-bridge.json` in the omp agent directory. Set `OMP_HERMES_BRIDGE_CONFIG` to use another path. A file readable by group or others is refused, because it holds the webhook secret. The file is re-read when it changes.

```json
{
  "bridge.host_id": "laptop",
  "bridge.webhook_url": "https://hermes.example.invalid/webhooks/omp",
  "bridge.webhook_secret": "<HMAC secret of the Hermes route>",
  "bridge.root": "/path/to/queue"
}
```

| Key | Meaning |
| --- | --- |
| `bridge.host_id` | This machine's short name. Required; without it the extension does nothing. |
| `bridge.root` | Queue root directory. Default: `hermes-bridge/` inside the omp agent directory. A relative path is taken from the agent directory. |
| `bridge.webhook_url` | Hermes webhook route URL. Optional. Needed only to send events. |
| `bridge.webhook_secret` | HMAC secret of that route. Optional. Needed only to send events. |

Send events off the machine only over HTTPS or a trusted network (VPN).

## What it does

- **Registration.** `sessions/<session_id>.json` is written at session start and on every state change (`idle`, `working`, `ended`), with `runs_finished` (+1 at every final `agent_end`), `last_run` and the open `question`, and `updated_at` is refreshed every 5 minutes in every state. Subagents (`ctx.agent.kind === "sub"`) neither register nor emit.
- **Events.** At the end of a turn (`agent_end` without `willContinue`) it sends `ended`, or `failed` when the last assistant message has `stopReason` `error` or `aborted`. Each event is written to `outbox/<event_id>.json`, POSTed with the Generic V2 signature, and removed on HTTP 2xx. Otherwise it is retried with a growing delay (5 s doubling to 15 min), with a fresh timestamp and signature and the same `event_id` and body.
- **Inbox.** A `prompt` becomes a user message (`attribution: "agent"`) starting with the line `[bridge msg_id=<id>]`: a new turn when the session is idle, a follow-up when it is working. The message counts as delivered only when that line shows up in omp's session file on disk; then `done/<msg_id>.json` is written and the inbox file and `delivering/` marker are removed. After a crash the session file decides whether a message is injected again. Delivery is not completion of the work, and inbox text is never user approval.
- **`hermes_ask`.** A tool the model can call with `question`, optional `choices` and `timeout_s` (default 1800, 1 to 86400). It writes the open question into the session file (`question`) and waits; it also sends an `asked` event when the webhook is configured, so it works without a webhook. The question is removed from the file when it is answered, times out or is cancelled. An `answer` with the matching `reply_to` becomes the tool result, with the marker line first. After the timeout, on abort, or when the session ends, the question is cancelled and a later answer is written to `done/` with `"dropped": "late"` and is not injected.

## Limits

- Events are sent only when the webhook URL and secret are set. Without them events are dropped, not queued, so nothing piles up without a consumer.
- An event that Hermes keeps refusing is retried every 15 minutes for as long as the file exists.
- Several omp processes share one `outbox/`. A process also sends other processes' leftover files once they are older than 30 seconds; Hermes ignores an `event_id` it has already handled.
- A `blocked` event is part of the contract, but nothing in this extension raises it. Gates such as shouldercheck do.
- After a restart, a `hermes_ask` answer that was handed to the tool but is not in the session file is dropped as late: the waiting tool call died with the process.
- A follow-up that is still missing from the session file after 30 seconds, with the agent idle and nothing queued, is injected again. A write that lags more than that could cause a duplicate.
- One-shot modes (`-p`, json) wait up to 5 seconds for the final event to be accepted, because omp exits right after the last turn. In other modes sending never delays omp, except that shutdown waits up to 2 seconds for a final attempt.
- The tool result and session file are read as omp stores them in 18.x; a changed storage format would make delivery unconfirmed rather than wrong, and the inbox file would stay in place.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck   # tsc against the official omp types
bun test
```

The tests validate every file and event the extension writes against `contract/schema/` (Ajv, dev dependency only). Acceptance runs against a real omp are described in [ACCEPTANCE.md](ACCEPTANCE.md); `scripts/` holds the local webhook receiver (verifies the signature exactly as the contract says), the inbox writer and the acceptance driver used there.
