# Changelog

All notable changes to omp-hermes-bridge are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Rewrite the top README for the current state and drop the experimental status note.
- After a gateway restart the Hermes plugin sends one re-arm turn per room that lists all its watches, not one turn per watch; a turn lists at most 50.

### Added
- Project skeleton: documentation, CI, and issue and pull request templates.
- Wire contract between the omp extension and the Hermes plugin, version 1: JSON schemas, examples, and delivery rules.
- omp extension (`omp/`): registers main sessions, sends turn-end events to the Hermes webhook with an outbox, delivers inbox prompts and answers, and adds the `hermes_ask` tool. Requires omp 18.10.4 or newer.
- Hermes plugin (`hermes/`): bridge event handling with duplicate file and notification rules, and the tools `omp_sessions`, `omp_send` and `omp_answer`.
- Session registration carries `runs_finished`, `last_run` and the open `question`; `hermes_ask` works without a webhook (the question is then only in the session file), and `omp_sessions` lists that question.
- `hermes/watch.py`: blocks until an omp session finishes a run, asks, ends or goes stale, then exits, so a Hermes room can wake through `terminal(background=true, notify_on_complete=true)`.
- Hermes plugin: tool `bridge_watch` and a watch list; after a gateway restart the plugin asks each room to re-arm its watchers (`allow_gateway_injection` required).
- End-to-end integration test results with a real omp and a real throwaway Hermes gateway (`docs/integration.md`).
