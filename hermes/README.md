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

- `omp_sessions(host_id?, include_ended?)`: reads `sessions/` locally or through `ssh <ssh_target>`. Marks a session `stale` when its `pid` is missing or not running, or `updated_at` is older than 10 minutes. Each session lists its `pending_questions`. Ended sessions are hidden by default. One unreachable host is reported in `errors` and does not hide the others.
- `omp_send(host_id, session_id, text)`: writes a `prompt` to `inbox/<session_id>/<msg_id>.json`.
- `omp_answer(host_id, session_id, reply_to?, text)`: writes an `answer`. `reply_to` may be left out when exactly one question of that session is open.

Writes follow the contract: `<msg_id>.json.tmp` in the same directory, then `rename`; directories 0700, files 0600; symbolic links are refused, including the root itself; a missing queue root is never created. Remote writes run a POSIX `sh` script over ssh with the message on stdin. Both tools refuse unknown and ended sessions.

## Limits

- Queued is not delivered. The tools report `queued`; omp confirms delivery in its own `done/` folder, and the plugin does not read it.
- Signature and timestamp window are enforced by the Hermes webhook adapter plus the route `filters`, not by plugin code (see Authentication). `Bridge.handle_request` and `signature.check` implement the same check for tests and for a future caller that has the headers.
- A duplicate is recorded before the agent runs. If Hermes stops between the two, that event is not re-processed after the restart.
- The `pid` of a remote session is checked with `kill -0` on the remote host. A process of another user there counts as not running.
- The remote login shell must be POSIX. Hosts are trusted: a registration file can name any `cwd` and `title`, which are passed to the agent as untrusted data.
- Only the local machine and ssh hosts are supported. No other transport.
