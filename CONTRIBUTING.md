# Contributing

Thank you for your interest in omp-hermes-bridge. The rules are short.

## Before you start

- Open an issue to report a bug or to propose work you are not going to implement yourself.
- If you are going to implement a change yourself, do not open an issue for it first. Open the pull request directly. For a new feature or a larger change, start a discussion in [Discussions](https://github.com/haesol-shin/omp-hermes-bridge/discussions) before you write code, so the approach is agreed.
- If an issue for the change already exists, link it from the pull request.

## Development

The project uses [uv](https://docs.astral.sh/uv/).

```sh
uv sync --locked
uv run ruff check
uv run ruff format --check
uv run pytest
```

CI runs the same commands. A pull request must pass all of them.

## Code style

- Contract first. `contract/` is the only source of the wire format. Put a contract change in its own commit before the code that depends on it, and name it in the pull request body.
- The omp extension (`omp/`) uses only the public omp extension API. The Hermes side (`hermes/`) uses only the public Hermes plugin API.
- The omp extension must keep working when Hermes is absent.
- Keep changes minimal and focused. One function does one thing.
- Tests must fail when the behavior they cover breaks.
- Comments explain why, not what.
- Python: Ruff rules `E`, `F`, `I`, `C901` (max complexity 15), line length 100.

## Commits

A commit message explains why the code is the way it is. The diff already shows what changed, so write only what the diff cannot tell a future reader.

- Title: [Conventional Commits](https://www.conventionalcommits.org/), `type(scope): summary` in the imperative, in English, 72 characters or fewer (about 50 is best). No trailers.
- Body: up to three bullets, each one line of 72 characters or fewer:
  1. The problem or the reason for the change.
  2. The new behavior, described as behavior, not as a file list.
  3. A rejected alternative, only when another approach looks more natural (`Rejected: ...`).
- Do not list files, restate the diff, describe the review process, or paste test results. Test results go in the pull request.

Example:

```
fix(omp): confirm delivery only from the session record

- A prompt written to the inbox was reported as delivered too early
- Delivery now counts only when the omp session record stores it
- Rejected: trusting the inbox move, because a crash can lose it
```

## Pull requests

Pull request titles use the same `type(scope): summary` format as commit titles.

The pull request body is the evidence for merging this change now: tests run, CI, review, linked issue if any, and known limits. It stays on GitHub and is reached through the `#number` in the commit title.

- Fill in the pull request template. If an issue exists, link it with `Closes #`.
- Add one line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) when the change is visible to users.
- Do not commit secrets, personal values, or local paths. Use placeholders in examples.
- Merging: squash only. The squash title is `type(scope): pull request title (#number)` and the squash body follows the commit rules above.
- Merge only after the maintainer approves the current head, and pin it: `gh pr merge <number> --squash --match-head-commit <approved SHA>`. A new commit after approval needs a new approval.

## Using AI tools

AI tools are welcome. You are responsible for what you submit:

- Check the result and attach evidence (test output, logs, or the review that found no issues).
- Make sure you can explain the change and maintain it.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
