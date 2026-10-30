# Changelog

All notable changes to omp-hermes-bridge are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Project skeleton: documentation, CI, and issue and pull request templates.
- Wire contract between the omp extension and the Hermes plugin, version 1: JSON schemas, examples, and delivery rules.
- omp extension (`omp/`): registers main sessions, sends turn-end events to the Hermes webhook with an outbox, delivers inbox prompts and answers, and adds the `hermes_ask` tool. Requires omp 18.10.4 or newer.
