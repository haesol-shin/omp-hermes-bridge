# Integration test: omp extension and Hermes plugin together

Run date: 2026-10-30, on `main` at `f4d15c9`. Real omp 18.14.0 with `omp/src/index.ts`, real Hermes gateway (v0.21.5 checkout) with the plugin copied from `hermes/`, real model turns on both sides. Covers `hermes/ACCEPTANCE.md` item 10 except the test channel (`deliver: log`, no chat platform).

## What was real and what was throwaway

- Real: omp binary and extension, Hermes gateway process, webhook adapter with the route `filters` from `hermes/README.md`, plugin hooks and tools, model turns (a cheap model through a local OpenAI-compatible endpoint), herdr 0.9.1.
- Throwaway, under the ignored `.tmp/`: `HERMES_HOME`, omp agent directory, queue root, herdr session, a random route secret, the gateway's own lock directory (`HERMES_GATEWAY_LOCK_DIR`; without it a second gateway on the same user refuses to start because it attaches to the running one).
- Only the webhook platform was enabled, on 127.0.0.1, `deliver: log`. No chat platform, no message to anyone. The model key came from the environment at process start and was never written to a file.
- Setup glue (config files, start script, scenario driver `drive.ts`, `dup.py`) is one-off and not in the repository.

## Results

| # | Scenario | How | Observed | Result |
| --- | --- | --- | --- | --- |
| 1 | `ended` | `omp --mode rpc -e omp/src/index.ts --model <model>` driven by `drive.ts` (one-off): `prompt` frame, wait for `agent_end` | Gateway logged a 202 for the signed POST, the plugin rewrote the prompt, one agent run, log delivery shows the agent's summary of the event. `outbox/` empty afterwards, registration `idle`. | pass, see finding 1 |
| 2 | `asked` | `drive.ts` prompt makes the model call `hermes_ask` (choices `staging`, `prod`, `timeout_s` 900) | Registration stayed `working`. Gateway run delivered "An omp session on `bridgehost` is asking:" to the log. `pending-questions.json` got the question with host, session id, text, choices. Answered through a real Hermes turn (`HERMES_HOME=<tmp>/hh hermes chat -Q -q "My answer is: use staging, not prod. Answer it with the omp_answer tool."`, same `HERMES_HOME`, plugin loaded, model called `omp_answer`; not through the gateway). `done/<msg_id>.json` has `delivered_at`; the omp model replied `ANSWER=use staging, not prod`. | pass |
| 3 | `omp_send` | `HERMES_HOME=<tmp>/hh hermes chat -Q -q "Use omp_sessions to find the running omp session on host bridgehost and send it the prompt: Reply with exactly: SEND-OK-7731"`; the turn called `omp_sessions`, then `omp_send` to the idle session | Prompt queued in `inbox/`, new omp turn started, model replied `SEND-OK-7731`, `done/` has `delivered_at`, a fresh `ended` event followed. | pass |
| 4 | Duplicate and bad signature | `python3 dup.py <tmp>/secret` (one-off): POSTs to `http://127.0.0.1:18644/webhooks/omp-bridge` with `X-Webhook-Timestamp`, `X-Webhook-Signature-V2` = hex HMAC-SHA256 of `<ts>.<body>`, `X-Request-ID` against the running gateway | First: 202. Replay with the same `X-Request-ID`: 200 `duplicate` (adapter cache, no agent run). Same `event_id` with a new `X-Request-ID`: 202, then `pre_gateway_dispatch skip: omp-bridge: duplicate event_id`, no agent run. Wrong signature, 400 s old timestamp, body changed after signing: 401 each. | pass |
| 5 | Under herdr 0.9.1 | `herdr --session <throwaway> server`; `workspace create`; `pane run w1:p1 ". <env>; omp -e omp/src/index.ts --model <model>"`; prompt typed with `pane send-text` and `send-keys Enter`; then `HERMES_HOME=<tmp>/hh hermes chat -Q -q "Send the prompt 'Reply with exactly: HERDR-SEND-OK-9042' to omp session <id> on host bridgehost using omp_send."` | Scenario 1: the plain prompt completed (`stopReason: stop`), gateway received `ended` and ran the agent. Scenario 3: `omp_send` prompt delivered to the idle session (`done/` has the msg id, the text is in the session file), second turn `stop`, second `ended` event handled. Evidence is gateway log, queue files and the omp session file, no screen reading for the result. An earlier herdr run was discarded: its first turn was interrupted by my Escape keys (a sign-in wizard in the fresh agent directory) and produced `failed`, not `ended`. The run above skipped the wizard before sending any prompt. | pass |

## Findings

1. **`[SILENT]` is not silent on the webhook route.** When the judging agent replies exactly `[SILENT]` for an `ended` event, the gateway (`gateway/run_turn.py`) rejects the marker because a webhook turn is not an internal turn, and replaces it with "The model returned only a silence marker for a message that needed a reply" (seen 3 times). The webhook adapter then delivers that warning to the route's `deliver` target. Resolved after this run by a design change, not by a fix: the room now wakes through `hermes/watch.py` (see "Waking a Hermes room" in [`hermes/README.md`](../hermes/README.md)). A watcher exit is an internal event, so `[SILENT]` stays silent there (per the watcher design; not exercised in this run). The webhook route is optional, and the warning remains on that route (upstream NousResearch/hermes-agent#118270).
2. First start of omp with a fresh agent directory opens the sign-in wizard in the TUI. Keys sent to it interrupt a prompt given on the command line. Not a bridge defect; skip the wizard before sending a prompt.

## Not tested

- A second machine, ssh transport, HTTPS or VPN between omp and Hermes.
- A real chat platform as `deliver` target and `mirror_to_session`; the `pre_llm_call` question note was exercised only through `hermes chat`, not through a chat session.
- `[SILENT]` suppression on a route that Hermes treats as machinery (see finding 1).
- `hermes/watch.py` and `bridge_watch`: added after this run; they are not part of these results.
- The live Hermes configuration and the real omp agent directory (out of scope).
