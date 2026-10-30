# omp-hermes-bridge

**Talk to running omp sessions from Hermes Agent.**

omp-hermes-bridge connects [omp](https://github.com/can1357/oh-my-pi) coding sessions that are already running with [Hermes Agent](https://github.com/NousResearch/hermes-agent). omp reports when a turn ends, fails, or asks a question. Hermes can send a prompt or an answer back into the session.

## What it is not

- It does not start or control omp processes. It attaches to sessions you started.
- It does not send notifications. omp emits events; Hermes decides whether and where to notify you.
- It does not modify omp or Hermes. It uses only the public omp extension API and the public Hermes plugin API.
- A message from Hermes is never user approval inside omp.

## The problem

You run several omp sessions and talk to your assistant in a chat app. When a session finishes or stops with a question, nobody tells you until you look at the terminal. To answer, you have to go back to that terminal.

## How it works

- **omp extension** (`omp/`): registers each main session as a file in a local queue directory, with its state, `runs_finished`, `last_run` and any open question. It reports `ended` and `failed` when a turn ends, and `asked` when the model calls its `hermes_ask` tool. It delivers prompts and answers from an inbox into the session. It keeps working when Hermes is absent.
- **Hermes plugin** (`hermes/`): the tools `omp_sessions`, `omp_send` and `omp_answer` list sessions and write prompts and answers into a session's inbox, locally or over ssh. The plugin also decides from each event whether to notify you (`notify`, `judge` or `suppress` per event kind).
- **Waking a room.** `hermes/watch.py` blocks until a session finishes a run, asks a question, ends or goes stale, then exits. A Hermes room starts it with `terminal(background=true, notify_on_complete=true)`, and its exit starts a new turn in that room. The tool `bridge_watch` keeps a watch list, so after a gateway restart the plugin asks each room to start its watchers again (this needs `allow_gateway_injection`, see [`hermes/README.md`](hermes/README.md)).
- **Webhook route (optional).** The extension can also POST signed events to a Hermes webhook route. The plugin then rewrites the prompt of the agent run for each event. The watcher and the session files work without it. A webhook run is a separate one-shot session, and its bare `[SILENT]` reply becomes a visible warning (finding 1 in [docs/integration.md](docs/integration.md)).
- **Delivery.** A message counts as delivered only when it is stored in the omp session record. After a crash, the session file decides whether a message is injected again.
- **Signed events.** Events use the Hermes webhook signature scheme with a timestamp window and an event id for duplicates.

## Limits

- Queued is not delivered: the Hermes tools report `queued`, and omp confirms delivery in its own `done/` folder.
- Only the local machine and ssh hosts are supported.
- omp side limits: [`omp/README.md`](omp/README.md#limits).
- What the integration test did not cover: "Not tested" in [docs/integration.md](docs/integration.md#not-tested).

## Requirements

- omp, in the version named in [`omp/README.md`](omp/README.md).
- Hermes Agent with the public plugin API (`register_tool`, `register_hook`, `get_config`). The webhook platform is needed only if you use the webhook route. `ssh` is needed only for a remote omp host.

## Install

- omp side: [`omp/README.md`](omp/README.md).
- Hermes side: [`hermes/README.md`](hermes/README.md).

## Integration test

[docs/integration.md](docs/integration.md) records the end-to-end run with a real omp and a real throwaway Hermes gateway.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
