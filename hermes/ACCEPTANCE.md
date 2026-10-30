# Acceptance: Hermes plugin (standalone items)

Run from the repository root. Run date: 2026-10-30. "Pass" means the command exited 0 with every selected test passing. Tests use synthetic data and a throwaway state directory.

| # | Item | Command | Result |
|---|---|---|---|
| 1 | The four contract example events (ended, failed, asked, blocked) pass the signature check and the schema | `uv run pytest tests/test_hermes_events.py -k contract_examples_pass` | pass (4 passed) |
| 2 | They route by the rules: asked and blocked notify the user directly, ended and failed are judged with `[SILENT]` as the way out, config can suppress | `uv run pytest tests/test_hermes_events.py -k "asked_goes or blocked_goes or ended_and_failed or can_suppress"` | pass (5 passed) |
| 3 | A wrong signature (and a changed body) is rejected | `uv run pytest tests/test_hermes_events.py -k "bad_signature or body_changed"` | pass (2 passed) |
| 4 | A timestamp older or newer than 300 s is rejected, 300 s is accepted | `uv run pytest tests/test_hermes_events.py -k "timestamp_outside or window_edge"` | pass (6 passed) |
| 5 | A repeated `event_id` is rejected, also after a restart; ids expire after 7 days | `uv run pytest tests/test_hermes_events.py -k "repeated_event_id or seven_days"` | pass |
| 6 | The gateway hook rewrites bridge events, drops duplicates, leaves other routes alone | `uv run pytest tests/test_hermes_events.py -k hook_` | pass (6 passed) |
| 7 | `omp_sessions`, `omp_send`, `omp_answer` against a queue directory, locally and through ssh (a fake ssh runs the remote script in a local shell) | `uv run pytest tests/test_hermes_tools.py` | pass |
| 8 | The plugin loads in the deployed Hermes (v0.21.5 checkout) with a throwaway `HERMES_HOME` under `.tmp/` | `hermes plugins doctor <HERMES_HOME>/plugins/omp-bridge` (copy of `hermes/`) | pass: 3 tools, 2 hooks registered |
| 9 | Real Hermes plugin manager dispatches `pre_gateway_dispatch` to the plugin with a real `MessageEvent`: first asked event rewritten, second skipped as duplicate. The Hermes webhook adapter accepts the same V2 signature and rejects a 400 s old timestamp | one-off script run with the Hermes checkout's Python and the throwaway `HERMES_HOME`; not kept in the repository | pass |
| 9a | Real HTTP through the Hermes webhook adapter (aiohttp test server, route with `signature.ROUTE_FILTERS`): valid V2 gives an agent run; old timestamp and bad signature give 401; V1 without timestamp, a valid GitLab token alone, and a valid GitLab token with a bad V2 (also lower-case header names) are ignored with no agent run | one-off script run with the Hermes checkout's Python; not kept in the repository | pass: 202 / 401 / 401 / ignored x4, agent runs 1 / 0 |
| 9b | The route filters accept V2 in any header case and reject every other auth scheme, also next to V2 | `uv run pytest tests/test_hermes_events.py -k "route_filters or header_value_cannot"` | pass |
| 9c | A symbolic-link queue root is neither read nor written, locally and through ssh | `uv run pytest tests/test_hermes_tools.py -k symlinked_root` | pass (4 passed) |
| 9c2 | A symbolic-link ssh root written with a trailing `/` is still refused; a real root with `/` works | `uv run pytest tests/test_hermes_tools.py -k trailing_slash` | pass |
| 9d | An `asked` question reaches the user's chat turn with host, session and question id, survives a restart, expires `timeout_s` after the event's `at` (a late retry that is already expired is not routed), and `omp_answer` closes it | `uv run pytest tests/test_hermes_tools.py -k "question or pending or without_reply_to"` | pass |
| 10 | A running gateway with the webhook route enabled, a model turn and a test channel | none | not tested: needs a gateway with provider credentials and a test channel; outside this job's scope (no live Hermes, no real message). Hermes does it at merge. |
| 11 | ssh to a different machine | none | not tested: no second machine. Only the fake-ssh run in item 7. |
