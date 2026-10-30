# omp-bridge: Hermes plugin

Hermes half of omp-hermes-bridge. It turns omp session events into a notification decision and lets Hermes list sessions and send a prompt or an answer into a running omp session. The wire format is [`contract/`](../contract/README.md). Runtime code uses only the Python standard library and the public Hermes plugin API (`register_tool`, `register_hook`, `get_config`).

## Install

1. Copy this folder to `<HERMES_HOME>/plugins/omp-bridge/` (the folder name is the plugin name).
2. Enable it: `hermes plugins enable omp-bridge`.
3. Add a webhook route to `platforms.webhook.extra.routes` (Hermes config). The secret is the omp side's `bridge.webhook_secret`; the route name must be in `routes` below:

   ```yaml
   platforms:
     webhook:
       enabled: true
       extra:
         routes:
           omp-bridge:
             secret: "<same as bridge.webhook_secret>"
             filters:   # REQUIRED: pins the signed-timestamp scheme, see "Authentication"
               - {field: headers, regex: '(?i)"x-webhook-signature-v2"'}
               - {field: headers, regex: '(?i)"x-webhook-timestamp"'}
               - not: {field: headers, regex: '(?i)"(?:x-gitlab-token|x-hub-signature-256|linear-signature|svix-[a-z]+|webhook-(?:id|timestamp|signature)|x-webhook-signature)"'}
             deliver: "<your channel>"
             deliver_extra: { chat_id: "<your chat id>" }
   ```

   `deliver` and `deliver_extra` decide where a notification goes. The plugin never names a channel. Use a test channel first.
4. Restart the gateway.
5. For a remote omp host, create an SSH key that may only write `<root>/inbox/` and read `<root>/sessions/` there (for example a forced command or `restrict` with a wrapper), and set `ssh_target` for that host.

Check the install without a gateway: `hermes plugins doctor <HERMES_HOME>/plugins/omp-bridge`.

## Config

Under `plugins.entries.omp-bridge.settings` in Hermes `config.yaml`:

| Key | Default | Meaning |
|---|---|---|
| `hosts` | `{}` | `host_id` to `{ssh_target, root}`. Empty `ssh_target` = this machine. `root` is required: the omp side's `bridge.root`. A leading `~/` is expanded on the machine that owns the queue. |
| `routes` | `["omp-bridge"]` | Webhook route names that carry bridge events. Other routes are left alone. |
| `notify` | see below | Per event kind: `notify`, `judge` or `suppress`. |
| `ssh_command` | `ssh` | ssh executable, may include options (`ssh -F <file>`). |
| `state_dir` | `<HERMES_HOME>/plugin-data/omp-bridge` | Holds `seen-events.json` and `pending-questions.json`. |

`notify` defaults: `asked: notify`, `blocked: notify`, `ended: judge`, `failed: judge`.

- `notify`: the agent is told to relay the event to the user now. `asked` also gives the agent the question id for `omp_answer`.
- `judge`: the agent decides with its own notification rules whether the user needs to know; it replies exactly `[SILENT]` when not, and the webhook route then delivers nothing.
- `suppress`: the event is dropped without an agent run.

## Authentication

The contract requires the Generic V2 signature (`X-Webhook-Signature-V2` over `<timestamp>.<body>`) and a timestamp within 300 s. A Hermes plugin hook never sees request headers, so the plugin cannot check them itself; the Hermes webhook adapter does. The adapter, however, also accepts other schemes (V1 body-only HMAC without a timestamp, GitLab token, GitHub, Linear, Svix) and checks them first, so a request authenticated by one of those never reaches the V2 timestamp check.

The route `filters` above close that gap: Hermes drops a request unless it carries both V2 headers and none of the other scheme headers (matched case-insensitively). Then V2 is the only way in and the adapter enforces the signature and the 300 s window. `signature.ROUTE_FILTERS` is the single source of these filters; tests pin their behavior and the signature code. Without the filters the route is weaker than the contract. The plugin cannot detect a missing filter.

## Event handling

The plugin hooks `pre_gateway_dispatch`, which fires for every webhook run (the route authentication is above). For events of a configured route it validates the body against the contract, drops an `event_id` it has seen in the last 7 days (`seen-events.json`, survives restarts; the webhook cache is memory-only and lasts one hour), and rewrites the prompt of the agent run as above. The event text is passed as a fenced data block marked as untrusted and not user approval.

`Bridge.handle_request(headers, body, secret)` runs the whole pipeline, including the Generic V2 signature and the 300 s timestamp window (`signature.py`). The tests use it.

## Answering a question

An `asked` event is announced in its own one-shot webhook session, but the user answers in their normal chat session. The plugin therefore stores each open question (host, session, question id, text, choices) in `pending-questions.json` until `timeout_s` passes or `omp_answer` closes it, and a `pre_llm_call` hook adds the open questions to every non-webhook chat turn. The agent then has `host_id`, `session_id` and `reply_to` when the user answers in plain words. This needs no `mirror_to_session`. The note says the text is data from the session and that the agent must never answer for the user.

## Tools

- `omp_sessions(host_id?, include_ended?)`: reads `sessions/` locally or through `ssh <ssh_target>`. Marks a session `stale` when its `pid` is missing or not running, or `updated_at` is older than 10 minutes. Each session lists its `pending_questions`: those that came through the webhook and the open `question` of the session file, which exists without a webhook. Ended sessions are hidden by default. One unreachable host is reported in `errors` and does not hide the others.
- `omp_send(host_id, session_id, text)`: writes a `prompt` to `inbox/<session_id>/<msg_id>.json`.
- `omp_answer(host_id, session_id, reply_to?, text)`: writes an `answer`. `reply_to` may be left out when exactly one question of that session is open.

Writes follow the contract: `<msg_id>.json.tmp` in the same directory, then `rename`; directories 0700, files 0600; symbolic links are refused, including the root itself; a missing queue root is never created. Remote writes run a POSIX `sh` script over ssh with the message on stdin. Both tools refuse unknown and ended sessions.

## Waking a Hermes room

`watch.py` blocks until an omp session needs attention, prints a short report and exits. Started from a room with `terminal(background=true, notify_on_complete=true)`, its exit makes Hermes start a new turn in the room that launched it. The completion is an internal event, so a reply of `[SILENT]` stays silent, and a busy room gets the turn after the current one.

```
terminal(background=true, notify_on_complete=true,
         command="python <HERMES_HOME>/plugins/omp-bridge/watch.py --host laptop --session <session_id> --since <runs_finished>")
```

Read `runs_finished` with `omp_sessions` before you act (`omp_send`, `omp_answer`) and pass it as `--since`, so a run that finishes before the watcher's first read still counts. The watcher only reads the session file, locally or through the same ssh path as `omp_sessions`; it never writes.

Stops (exit 0, report on stdout):

- `runs_finished` is greater than the baseline (`--since`, else the value at the first read). An idle session at start therefore means "tell me when the next run finishes".
- The session is `ended`, is `stale` (same rule as `omp_sessions`), or its file disappeared.
- A `question` is open whose id is not the `--answered <question_id>` given at start. Pass `--answered` when you re-arm right after `omp_answer`, so the old question that is still in the file does not stop the new watcher.

Other options: `--now` reports the current state at once; `--timeout <s>` (default 82800) ends a forgotten watcher with exit 3 and a line saying nothing happened, so the room can start a new one; `--interval <s>` (default 30, minimum 5). Exit 2 is a usage error or an unknown host or session, exit 1 any other error. A session file without `runs_finished` (older extension) falls back to "idle after working was seen", and the report says short runs can be missed.

The watcher reads the plugin settings from `$HERMES_HOME/config.yaml` (`plugins.entries.omp-bridge.settings`: `hosts`, `ssh_command`) or from the file given with `--config`; a `.yaml` file needs PyYAML, which Hermes ships, and a `.json` file needs nothing.

The report is a hint. After a gateway restart the output and exit code of a recovered watcher are lost, so the room re-reads `omp_sessions` before it acts.

The webhook route is optional for this. A webhook run is a separate one-shot Hermes session with no room context, and its bare `[SILENT]` reply turns into a visible warning (upstream NousResearch/hermes-agent#118270, open). The watcher and the session file need neither the route nor `pending-questions.json`.

### Surviving a gateway restart

After a restart Hermes recovers a running watcher as detached, but its output and exit code are lost, and a watcher that exited while the gateway was down is not reported. The plugin therefore keeps a watch list.

- `bridge_watch(action="add", session_key, command)` after you start a watcher, `remove(watch_id)` when its final state is handled, `list`. Records live in `watches.json` in `state_dir` (mode 0600, atomic writes): `watch_id`, `session_key`, the exact command line, `started_at`.
- `session_key` is the documented key of the room you are in: `agent:main:telegram:dm:<chat_id>`, with `:<thread_id>` for a topic, `agent:main:<platform>:group:<chat_id>:<user_id>` for groups. See [Per-Platform Session Tracking](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md) and [Injecting Messages](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md). The plugin only checks the shape (`agent:<profile>:<platform>:...`); `inject_message` accepts or rejects the key, and the gateway logs an unknown one. Hermes offers no public way for a tool to read its own key, so the room supplies it from the platform, chat and thread it knows.
- At plugin load a daemon thread calls `inject_message(text, session_key=...)` for each record every 5 seconds until it returns `True` or 10 minutes pass (then the record stays for the next start). The text says the gateway restarted, the watcher may be gone, to re-read the state and re-arm with the exact command if the work still runs; it is data, not a user instruction.
- The owner must allow it: set `allow_gateway_injection: true` under `plugins.entries.omp-bridge.settings` (checked by this plugin) and `plugins.entries.omp-bridge.allow_gateway_injection: true` (checked by Hermes). Without the first, the plugin logs one warning and does nothing.
- Limit: `inject_message` has no public way to tell a gateway from a CLI. In a CLI session with leftover records the text would go to that CLI; the records come from rooms, so keep them only where a gateway runs.

## Limits

- Queued is not delivered. The tools report `queued`; omp confirms delivery in its own `done/` folder, and the plugin does not read it.
- Signature and timestamp window are enforced by the Hermes webhook adapter plus the route `filters`, not by plugin code (see Authentication). `Bridge.handle_request` and `signature.check` implement the same check for tests and for a future caller that has the headers.
- A duplicate is recorded before the agent runs. If Hermes stops between the two, that event is not re-processed after the restart.
- The `pid` of a remote session is checked with `kill -0` on the remote host. A process of another user there counts as not running.
- The remote login shell must be POSIX. Hosts are trusted: a registration file can name any `cwd` and `title`, which are passed to the agent as untrusted data.
- Only the local machine and ssh hosts are supported. No other transport.
