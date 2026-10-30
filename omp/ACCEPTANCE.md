# Acceptance: omp extension

Spec section 1, "수락". Run on the Pi (arm64 Linux) against a real omp, with a throwaway agent directory, a throwaway queue root per scenario and a local webhook receiver (`scripts/webhook-listener.ts`) that checks the Generic V2 signature and the 300 s window exactly as `contract/README.md` says. Nothing touched the live Hermes or the real omp agent directory.

- omp binary: 18.14.0 (the machine's installed build). The API docs and sources read for the design are 18.10.4. Every behavior below was observed on 18.14.0.
- Model: a cheap model, named by `ACCEPT_MODEL`. Provider and agent directory contents are not recorded here.
- The driver removes `OMP_PROFILE`, `PI_PROFILE` and `PI_CONFIG_DIR` from the environment (a profile makes omp ignore `PI_CODING_AGENT_DIR`) and aborts when a session file lands outside the throwaway agent directory. After the review fixes (outbox no longer awaited by the poll tick, symlink checks on every queue access) `modes-rpc`, `inbox-idle`, `outbox`, `kill-2-after-idle-inject` and `subagent-silent` were run again with `OMP_PROFILE` set to a bogus value: all pass.
- Interactive mode: the TUI was driven through a pseudo-terminal (`script`), not typed by hand.

## Setup

```sh
export PI_CODING_AGENT_DIR=<worktree>/.tmp/agent   # throwaway; auth and model config copied in, never committed
export ACCEPT_MODEL=<cheap provider/model>
export ACCEPT_DIR=<worktree>/.tmp/accept
cd omp && bun scripts/accept.ts            # all scenarios, one JSON line each
cd omp && bun scripts/accept.ts <scenario> # one scenario
```

The throwaway `models.yml` also has a provider `deadprov` with `baseUrl: http://127.0.0.1:1/v1` (nothing listens there) for the failure case, and `retry.maxRetries: 2` so the failure case ends quickly. The scenario names below are the arguments of `scripts/accept.ts`. `scripts/accept.ts` starts the receiver, the omp process (`omp --mode rpc -e omp/src/index.ts`, `-p`, or the TUI) and the inbox writer (`scripts/inbox-send.ts`) itself.

## Results

Rows 1 to 7 come from one full run of `bun scripts/accept.ts` before the review fixes (17 scenarios, 17 pass). After the fixes, only the five scenarios named above were run again, and all pass. Row 8 is from the current head.

| # | Spec item | Command | Observed | Result |
| --- | --- | --- | --- | --- |
| 1a | Registration and turn-end event, `-p` | `bun scripts/accept.ts modes-print` | Reply `ok`; registration file `state: ended` afterwards; receiver accepted exactly one event `ended`, `summary: "ok"`; `outbox/` empty | pass |
| 1b | Same, RPC | `bun scripts/accept.ts modes-rpc` | Registration states sampled every 20 ms: `idle, working, idle, ended`; one `ended` event; process exit 0 | pass |
| 1c | Same, interactive (TUI through a pty) | `bun scripts/accept.ts modes-tui` | `script -qfc "omp -e omp/src/index.ts ..."` fed a prompt and Ctrl+C; states `idle, working, idle, ended`; one `ended` event | pass |
| 1d | Loads as an omp package directory (`omp.extensions` in `package.json`) | `omp -p -e <worktree>/omp --model $ACCEPT_MODEL "Reply with exactly: ok"` with a config without webhook | Session registered under the configured queue root; `outbox/` empty (no webhook, events dropped by design) | pass |
| 2a | Inbox prompt into an idle session | `bun scripts/accept.ts inbox-idle` | One new turn started; session file has one user message with `attribution: "agent"` starting with `[bridge msg_id=<id>]`; the model replied `inbox-idle-ok`; `done/<id>.json` has `delivered_at`; inbox file and `delivering/` marker gone | pass |
| 2b | Inbox prompt into a working session | `bun scripts/accept.ts inbox-working` | Registration `working` when written; injected as a follow-up (one agent loop); the marker message appears after the running tool's result in the session file, once; the model replied `second-done` | pass |
| 3a | `hermes_ask` question, then answer | `bun scripts/accept.ts ask-answered` | `asked` event with `question{id,text,choices:["A","B"],timeout_s:120}`; state stayed `working` while waiting; the answer became the `hermes_ask` tool result `[bridge msg_id=<id>]\nUse option B.` (a `toolResult` entry, not a follow-up); model replied `ANSWER=Use option B.`; `done/` has `delivered_at`; states `idle, working, idle` | pass |
| 3b | `hermes_ask` timeout, then late answer | `bun scripts/accept.ts ask-timeout` | `timeout_s: 5`; tool result `No answer from Hermes within 5 seconds. The question is cancelled; a later answer is dropped.`; the late answer produced `done/<id>.json` with `dropped: "late"`, `dropped_at`, no `delivered_at`; inbox file removed; 0 session entries for it | pass |
| 3c | Answer after the session ended | `bun scripts/accept.ts ask-session-ended` | Question open, stdin closed: registration `ended`; answer written after that; `omp --mode rpc --resume <session file>` then wrote `done/` with `dropped: "late"`; 0 session entries; resume started 0 turns | pass |
| 4 | Hermes receiver absent, then present | `bun scripts/accept.ts outbox` | Receiver down: omp ran two turns normally, registration `idle`, 2 files in `outbox/`; receiver started: both events accepted and `outbox/` empty 5 s later; 0 signature rejections | pass |
| 5a | Kill and restart, point 1: before injecting | `bun scripts/accept.ts kill-1-before-inject` | State built by hand because the window is microseconds: session killed with `kill -9`, inbox file plus `delivering/` marker written, session resumed. Injected once: 1 marker entry in the session file, `done/` written | pass (state constructed, not a real kill) |
| 5b | Point 2: right after injecting into an idle session | `bun scripts/accept.ts kill-2-after-idle-inject` | `kill -9` as soon as the marker line was in the session file: `done/` absent, marker and inbox file present; after resume 1 marker entry, 0 new turns, `done/` written | pass |
| 5c | Point 3: follow-up queued in a working session, not yet in the file | `bun scripts/accept.ts kill-3-followup-not-persisted` | `kill -9` while `sleep 40` ran and the marker existed: 0 entries in the session file; after resume 1 entry (injected again once), 1 turn started | pass |
| 6a | State table: success | `modes-rpc` (row 1b) | `idle, working, idle` + `ended` | pass |
| 6b | State table: failure (`stopReason: error`) | `bun scripts/accept.ts state-failure` | Unreachable provider, 2 retries: states `idle, working, idle` (no `idle` between retries); one `failed` event, `summary` = the provider's error message as given | pass |
| 6c | State table: abort | `bun scripts/accept.ts state-abort-streaming state-abort-tool` | Abort while streaming and while a tool ran: states `idle, working, idle`; one `failed` event each, `summary: "Interrupted by user"` | pass |
| 6d | State table: follow-up run (`willContinue: true`) | `state-failure` (probe `scripts/agent-kind-probe.ts` loaded too) | Extension saw `agent_start`, `agent_end` x3: the first two with `willContinue: true, stopReason: "error"`, the last without `willContinue`. No event and no `idle` for the first two, one `failed` for the last | pass |
| 6e | State table: question wait, shutdown, session switch | `ask-answered`, `modes-rpc`, `bun scripts/accept.ts session-switch` | Wait: `working`. Shutdown: `ended`, no event. `new_session` in RPC: old registration `ended`, new one `idle`, and an inbox prompt for the new session was delivered (the timer survives the switch) | pass |
| 7 | Subagents: 0 events | `bun scripts/accept.ts subagent-silent` | The model used the `task` tool; the probe extension saw the subagent session's `session_start`, `agent_start`, `agent_end` (`kind: "sub"`); `sessions/` has 1 file; both events sent belong to the main session | pass |
| 8 | Unit tests, incl. schema validation of every written file and event | `cd omp && bun install --frozen-lockfile && bun test` | 89 tests pass | pass |

## Experiments the spec asked for

- `willContinue` and `stopReason` on 18.14.0 match the docs. `stopReason` is on the last assistant message of `agent_end.messages`, not on the event. After a provider error with auto-retry, `agent_end` arrives with `willContinue: true` once per retry and the final one has no `willContinue`. A user abort gives `stopReason: "aborted"` with `errorMessage: "Interrupted by user"` both during streaming and during a tool call.
- Inside the `agent_end` handler `ctx.isIdle()` is still `false`, so the extension keeps its own state and does not read `isIdle()` there.
- One RPC `agent_end` frame covers all retries, while an extension sees one `agent_end` per retry. Hosts that count RPC frames and extensions that count `agent_end` events do not agree.

## Not tested

| Item | Why |
| --- | --- |
| Delivery to the real Hermes webhook route and its real signature check | The Hermes side is another chunk and the live Hermes is out of scope. The local receiver follows the contract text only. |
| Off-machine delivery over HTTPS or VPN | Needs a second machine. |
| `omp plugin install` / `plugin link` of the `omp/` directory | Writes outside the throwaway directory (user plugin settings). Row 1d loads the same directory manifest with `-e`. |
| A real kill inside the microsecond window between creating the marker and calling `sendUserMessage` | Cannot be aimed; row 5a builds the resulting state instead. |
| A `willContinue: true` that is not an error retry | Only the auto-retry case was reproducible. |

## Re-run after the official types change (2026-10-30)

`modes-rpc` and `inbox-idle` were run again on omp 18.14.0 with a throwaway agent directory under `.tmp/`, after `omp/src/types.ts` was replaced by the official `@oh-my-pi/pi-coding-agent` types (18.10.4) and `bun run typecheck` passed. Both pass: `modes-rpc` states `idle, working, idle, ended`, one `ended` event, exit 0; `inbox-idle` one new turn, one marker entry with `attribution: "agent"`, `done/` written. `bun test`: 89 pass.
