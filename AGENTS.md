# AGENTS.md

Instructions for coding agents working in this repository.

## Commands

```sh
uv sync --locked
uv run ruff check
uv run ruff format --check
uv run pytest
```

Run all of them before you report a change as done.

## Rules

- Read [CONTRIBUTING.md](CONTRIBUTING.md) first. It is the source for code style, commits, and pull requests.
- `contract/` is the wire format. Do not change it in a code pull request. If code needs a contract change, stop and report it.
- `omp/` uses only the public omp extension API. `hermes/` uses only the public Hermes plugin API. Do not import either harness's internals.
- The omp extension must never break or block an omp session. No handler may throw.
- Keep the change minimal. Do not refactor unrelated code.
- Tests use synthetic fixtures. Use `.invalid` hosts and placeholder paths, never real accounts, chat ids, or local paths.

## Before you publish

- Ask the maintainer before you post an issue, a comment, or a pull request, and before you merge.
- Search your diff for personal values, tokens, and absolute local paths.
- Add a `CHANGELOG.md` line under `Unreleased` if users can see the change.
- Write commit messages, pull requests, issues, and comments in plain style:
  - Describe the change and the reason without a subject ("Add X", "X failed because Y").
  - Use "I" only for what you actually ran or checked. Do not use "we".
  - Do not use em-dashes.
