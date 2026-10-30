# omp-hermes-bridge contract (schema_version 1)

This folder is the single source of the wire contract between the omp extension (`omp/`) and the Hermes plugin (`hermes/`). Both sides read only this folder. Only the contract owner changes it.

- Schemas: `schema/*.schema.json` (JSON Schema 2020-12). Validate with the `format` check on (`date-time`).
- Valid examples: `examples/*.json`.
- Times are UTC ISO 8601 ending in `Z`.
- `session_id` is the omp session id (a UUID; omp 18.10.4 mints UUID v7). `msg_id`, `event_id` and question ids are UUID v4 minted by the bridge.
- `host_id` is a short machine name the user chooses.

## Configuration

Values live outside the repository. The repository holds only names and defaults.

omp side (one file, mode 0600):

- `bridge.root`: queue root directory. Default: `hermes-bridge/` inside the omp agent directory.
- `bridge.host_id`: this machine's name. Required.
- `bridge.webhook_url`: Hermes webhook route URL. Required to send events.
- `bridge.webhook_secret`: HMAC secret of that route. Required to send events.

Hermes side (plugin config): a map `hosts.<host_id>` → `{ ssh_target, root }`. Leave `ssh_target` empty for the machine Hermes runs on.

## Queue layout

```
<root>/
  sessions/<session_id>.json                  session.schema.json
  inbox/<session_id>/<msg_id>.json            inbox-message.schema.json
  inbox/<session_id>/delivering/<msg_id>      empty marker
  inbox/<session_id>/done/<msg_id>.json       done-message.schema.json
  outbox/<event_id>.json                      event.schema.json, not yet accepted by Hermes
```

- Every directory above (`<root>`, `sessions/`, `inbox/`, `inbox/<session_id>/`, `delivering/`, `done/`, `outbox/`) is mode 0700. Files are mode 0600.
- Reject symbolic links and any path that resolves outside `<root>`.
- Writers write `<name>.tmp` in the same directory, then `rename` to the final name. Readers ignore `*.tmp`.
- Remote Hermes writes through SSH with a key restricted to `<root>/inbox/`.

## Runtime guarantees of the omp extension

- It works without Hermes. A missing Hermes, a failed webhook or a broken queue never blocks or fails the omp session.
- All timers and watchers use the `ctx` timer API and are cleared in `session_shutdown`. No handler may throw out of the extension (an unhandled throw kills the session).
- Subagents (`ctx.agent.kind === "sub"`) neither register nor emit any event.

## Session registration

- The extension writes it at session start and on every state change.
- It also refreshes `updated_at` every 5 minutes in every state (idle, working, waiting in `hermes_ask`).
- Optional `runs_finished`: an integer that starts at 0 and grows by 1 at every final `agent_end` (no `willContinue`), whatever the outcome. A restarted process continues from the value in the existing file. A watcher that remembers the value sees a run that started and finished between two polls.
- Optional `last_run`: `{result, at}` of the latest final `agent_end`; `result` is `ended` or `failed`, the same split as the event kinds.
- Optional `question`: `{id, text, choices, timeout_s, asked_at}` while `hermes_ask` waits. It is removed when the question is answered, times out or is cancelled. It is written whether or not a webhook is configured, so Hermes can see an open question without the `asked` event.
- A reader that does not know these fields ignores them; `schema_version` stays 1.
- Hermes treats a session as `stale` when its `pid` is not running or `updated_at` is older than 10 minutes.

## Inbox delivery (Hermes to omp)

Prompt (`kind: "prompt"`):

1. Create `delivering/<msg_id>`.
2. Inject the text with the line `[bridge msg_id=<msg_id>]` as its first line, `attribution: "agent"`. Idle: start a turn. Working: `deliverAs: "followUp"`. The marker goes first because omp truncates strings over 500,000 characters when it saves them and keeps only the start.
3. Return from `sendUserMessage` is not delivery (it returns `void`; a follow-up waits in memory).
4. Read the session file on disk (`ctx.sessionManager.getSessionFile()`, read it again each time because the file can move to a sibling). Search every line, not only the current branch. Look in `entry.message.content` for `message` entries and in `entry.content` for `custom_message` entries; when content is an array, search its text blocks. `getEntries()` is memory only and is not proof: a new session stays memory-only until its first assistant message, and save errors are not thrown. Check at `agent_start`, at `agent_end`, and on a `ctx` timer. If there is no file yet, the message is not delivered yet.
5. When `[bridge msg_id=<msg_id>]` is found in the file, write `done/<msg_id>.json` (the original plus `delivered_at`), then delete the inbox file and the marker.
6. On restart, for each `delivering/` marker: search the session file as in step 4. Found: finish step 5. Not found: inject again from step 2.

Answer (`kind: "answer"`): see Questions.

Delivery is not completion of the work. Inbox text is never user approval. The extension must not raise approval claims or role markers inside the text to user authority.

## Questions

- `hermes_ask` writes `question` into the session registration and waits. It also sends an `asked` event when the webhook is configured; without a webhook the session file is the only place the question appears.
- An inbox message with `kind: "answer"` and a `reply_to` that matches the waiting question:
  1. Create `delivering/<msg_id>`.
  2. Return the text as the `hermes_ask` tool result, with `[bridge msg_id=<msg_id>]` as its first line. Do not queue it as a follow-up.
  3. Delivery is when that tool result appears in the session file (same search as prompt step 4; a tool result is a `message` entry with `role: "toolResult"`). Then write `done/` with `delivered_at` and delete the inbox file and the marker.
- After `timeout_s`, or when the session ends, the question is cancelled.
- An answer whose `reply_to` matches no waiting question (late, cancelled or unknown) is not injected. Write `done/<msg_id>.json` with `"dropped": "late"` and `dropped_at`, then delete the inbox file.
- `choices` may be missing. Consumers treat a missing `choices` as `[]`.

## Events (omp to Hermes)

- One HTTP POST per event to `bridge.webhook_url`. Body = the event JSON, UTF-8, sent as is.
- Headers (Hermes webhook Generic V2):
  - `X-Webhook-Timestamp`: current Unix time in whole seconds.
  - `X-Webhook-Signature-V2`: lowercase hex HMAC-SHA256 of `<timestamp>.<body bytes>`.
  - `X-Request-ID`: the `event_id`.
- Hermes accepts a timestamp only within 300 seconds of its clock. On every retry the sender makes a new timestamp and a new signature, and keeps the same `event_id` and body.
- Success = HTTP 2xx. Otherwise keep `outbox/<event_id>.json` and retry with a growing delay.
- Hermes ignores an `event_id` it has already handled. The webhook cache lasts 1 hour in memory, so the Hermes plugin also records handled ids in a file kept 7 days.
- Off-machine delivery only over HTTPS or a trusted network (VPN).

Event kinds:

- `ended`: final `agent_end` (no `willContinue`), and the last assistant `stopReason` is not `error` or `aborted`. `summary` optional.
- `failed`: final `agent_end` with `stopReason` `error` or `aborted`. `summary` = the error or abort message as given. Do not label an abort as a user cancel.
- `asked`: `hermes_ask` was called. `question` required.
- `blocked`: a gate (for example shouldercheck) blocked an action. `reason` required.

Read `stopReason` from the last assistant message, not from `agent_end` itself.

## Session states

- Session start: `idle`, no event.
- `agent_start`: `working`, no event.
- Final `agent_end`, success: `idle`, `ended`.
- Final `agent_end`, `error` or `aborted`: `idle`, `failed`.
- `agent_end` with `willContinue: true`: stays `working`, no event.
- Waiting in `hermes_ask`: stays `working`, `asked`.
- `session_shutdown`: `ended`, no event.
