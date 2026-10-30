# omp-hermes-bridge

**Talk to running omp sessions from Hermes Agent.**

omp-hermes-bridge connects [omp](https://github.com/can1357/oh-my-pi) coding sessions that are already running with [Hermes Agent](https://github.com/NousResearch/hermes-agent). omp reports when a turn ends, fails, or asks a question. Hermes can send a prompt or an answer back into the session.

> Status: experimental. Only the wire contract in [`contract/`](contract/README.md) exists. The omp extension and the Hermes plugin are planned. There is no release yet.

## What it is not

- It does not start or control omp processes. It attaches to sessions you started.
- It does not send notifications. omp emits events; Hermes decides whether and where to notify you.
- It does not modify omp or Hermes. It uses only the public omp extension API and the public Hermes plugin API.
- A message from Hermes is never user approval inside omp.

## The problem

You run several omp sessions and talk to your assistant in a chat app. When a session finishes or stops with a question, nobody tells you until you look at the terminal. To answer, you have to go back to that terminal.

## How it will work (planned)

- **omp extension** (`omp/`): registers each main session in a local queue directory, sends `ended`, `failed`, `asked`, and `blocked` events to a Hermes webhook, and delivers inbox messages into the session. It keeps working when Hermes is absent.
- **Hermes plugin** (`hermes/`): lists sessions, sends prompts and answers, and turns events into decisions and notifications.
- **Delivery you can trust.** A message counts as delivered only when it is stored in the omp session record. A restart neither loses nor repeats a message.
- **Signed events.** Events use the Hermes webhook signature scheme with a timestamp window and an event id for duplicates.

## Requirements

- omp 18.x.
- Hermes Agent with the webhook platform enabled.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
