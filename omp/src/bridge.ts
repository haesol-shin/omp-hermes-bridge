import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeConfig, ConfigResult } from "./config.ts";
import { type InboxMessage, parseInbox } from "./messages.ts";
import { type EventBody, type FetchLike, Outbox } from "./outbox.ts";
import { JSON_FILE, MARKER_FILE, Queue } from "./queue.ts";
import { markerLine, MarkerScanner } from "./scanner.ts";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import { errText, newId, truncate, utcNow } from "./util.ts";

/** What the bridge needs from omp; index.ts adapts the extension context to it. */
export interface Host {
  sendUserMessage(text: string, options: { deliverAs?: "followUp"; attribution: "agent" }): void;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  sessionFile(): string | undefined;
  sessionName(): string | undefined;
  setInterval(fn: () => void, ms: number): unknown;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  /** One-shot modes (print, json) may exit right after the last event, so sends are awaited there. */
  awaitSends: boolean;
}

export interface BridgeOptions {
  config: { get(): ConfigResult };
  fetch: FetchLike;
  now?: () => number;
  pid?: number;
  log?: (message: string) => void;
}

export type SessionState = "idle" | "working" | "ended";

export const TICK_MS = 1_000;
export const REGISTRATION_REFRESH_MS = 5 * 60_000;
/** A follow-up that is still not in the session file after this long, with the agent idle, is lost. */
export const REINJECT_AFTER_MS = 30_000;
export const DEFAULT_ASK_TIMEOUT_S = 1_800;
export const MAX_ASK_TIMEOUT_S = 86_400;
const SHUTDOWN_SEND_MS = 2_000;
/** Longest a one-shot run waits for Hermes to accept the final event before omp exits. */
const ONE_SHOT_SEND_MS = 5_000;
const SUMMARY_MAX = 4_000;

interface Pending {
  msg: InboxMessage;
  injectedAt: number;
}

type AskOutcome =
  | { status: "answered"; text: string }
  | { status: "timeout" | "cancelled" };

interface Waiting {
  settle(outcome: AskOutcome): void;
}

/** The open `hermes_ask` question as it appears in the session file. */
interface OpenQuestion {
  id: string;
  text: string;
  choices: string[];
  timeout_s: number;
  asked_at: string;
}

interface LastRun {
  result: "ended" | "failed";
  at: string;
}

export interface AskParams {
  question: string;
  choices?: string[];
  timeoutS?: number;
}

interface Ctx {
  cfg: BridgeConfig;
  queue: Queue;
  outbox: Outbox;
}

export class Bridge {
  #host: Host | undefined;
  #info: SessionInfo | undefined;
  #startedAt = "";
  #state: SessionState = "idle";
  #registeredAt = 0;
  #registered = false;
  #timer: unknown;
  #tickRun: Promise<void> | undefined;
  #flushRun: Promise<void> | undefined;
  #scanner = new MarkerScanner();
  #pending = new Map<string, Pending>();
  #waiting = new Map<string, Waiting>();
  #bad = new Map<string, number>();
  #runsFinished = 0;
  #lastRun: LastRun | undefined;
  #questions = new Map<string, OpenQuestion>();
  #repo: { cwd: string; root: string | null } | undefined;
  #ctx: (Ctx & { root: string }) | undefined;
  #now: () => number;

  constructor(private readonly opts: BridgeOptions) {
    this.#now = opts.now ?? Date.now;
  }

  get sessionId(): string | undefined {
    return this.#info?.id;
  }

  get state(): SessionState {
    return this.#state;
  }

  #log(message: string): void {
    this.opts.log?.(message);
  }

  #iso(): string {
    return utcNow(new Date(this.#now()));
  }

  #context(): Ctx | undefined {
    const result = this.opts.config.get();
    if (!("config" in result)) {
      this.#ctx = undefined;
      return undefined;
    }
    const cfg = result.config;
    if (this.#ctx?.root !== cfg.root) {
      const queue = new Queue(cfg.root);
      const outbox = new Outbox(
        queue,
        () => {
          const current = this.opts.config.get();
          return "config" in current ? current.config : undefined;
        },
        this.opts.fetch,
        this.#now,
        (m) => this.#log(m),
      );
      this.#ctx = { root: cfg.root, cfg, queue, outbox };
    }
    this.#ctx.cfg = cfg;
    return this.#ctx;
  }

  // ---- session lifecycle -------------------------------------------------

  /** Binds the current omp session. A changed session id (new/resume/fork) ends the old registration first. */
  attach(host: Host, info: SessionInfo): void {
    this.#host = host;
    if (this.#info && this.#info.id !== info.id) this.#endSession();
    if (this.#info?.id === info.id) {
      this.#info = info;
      return;
    }
    this.#info = info;
    this.#startedAt = this.#iso();
    this.#state = "idle";
    this.#registered = false;
    this.#scanner = new MarkerScanner();
    this.#pending.clear();
    this.#bad.clear();
    this.#questions.clear();
    this.#prepare();
    this.#resumeCounters();
    this.#register();
    this.#timer ??= host.setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  #prepare(): void {
    const c = this.#context();
    if (!c || !this.#info) return;
    try {
      c.queue.ensureDir(c.queue.sessionsDir());
      c.queue.ensureDir(c.queue.outboxDir());
      c.queue.ensureDir(c.queue.deliveringDir(this.#info.id));
      c.queue.ensureDir(c.queue.doneDir(this.#info.id));
    } catch (error) {
      this.#log(`queue not usable: ${errText(error)}`);
    }
  }

  /**
   * A restarted omp process may re-attach to a session whose file already counts runs. Counting from
   * 0 again would move the value backwards, and a watcher waiting for it to grow would never fire.
   */
  #resumeCounters(): void {
    this.#runsFinished = 0;
    this.#lastRun = undefined;
    const c = this.#context();
    if (!c || !this.#info) return;
    try {
      const raw = JSON.parse(c.queue.readText(c.queue.sessionFile(this.#info.id)) ?? "null");
      if (Number.isSafeInteger(raw?.runs_finished) && raw.runs_finished >= 0) {
        this.#runsFinished = raw.runs_finished;
        const last = raw.last_run;
        if ((last?.result === "ended" || last?.result === "failed") && typeof last.at === "string") {
          this.#lastRun = { result: last.result, at: last.at };
        }
      }
    } catch {
      // No file or a damaged one: start from 0.
    }
  }

  #endSession(): void {
    this.#cancelQuestions();
    this.#state = "ended";
    this.#register();
    this.#pending.clear();
  }

  async shutdown(): Promise<void> {
    if (!this.#info) return;
    this.#cancelQuestions();
    this.#state = "ended";
    this.#register();
    const c = this.#context();
    // One last try so a final event is not left for the next session to find.
    if (c) await c.outbox.flush(SHUTDOWN_SEND_MS, true).catch(() => {});
  }

  #cancelQuestions(): void {
    for (const waiting of [...this.#waiting.values()]) waiting.settle({ status: "cancelled" });
  }

  onAgentStart(): void {
    if (!this.#info) return;
    this.#setState("working");
    this.#checkDelivered();
  }

  async onAgentEnd(messages: unknown[] | undefined, willContinue: boolean | undefined): Promise<void> {
    if (!this.#info) return;
    this.#checkDelivered();
    if (willContinue) return;
    const outcome = classify(messages ?? []);
    // Counter and state go out in one write: a watcher that sees `idle` must also see the new count.
    this.#runsFinished += 1;
    this.#lastRun = { result: outcome.kind, at: this.#iso() };
    this.#state = "idle";
    this.#register();
    const sent = this.#emit(
      outcome.kind,
      outcome.summary === undefined ? {} : { summary: outcome.summary },
      this.#info.awaitSends ? ONE_SHOT_SEND_MS : undefined,
    );
    if (this.#info.awaitSends) await sent;
  }

  #setState(state: SessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#register();
  }

  // ---- registration ------------------------------------------------------

  #register(): void {
    const c = this.#context();
    const info = this.#info;
    if (!c || !info) return;
    try {
      c.queue.writeJson(c.queue.sessionFile(info.id), {
        schema_version: 1,
        host_id: c.cfg.hostId,
        session_id: info.id,
        cwd: info.cwd,
        repo: this.#gitRoot(info.cwd),
        title: this.#host?.sessionName() ?? null,
        pid: this.opts.pid ?? process.pid,
        started_at: this.#startedAt,
        state: this.#state,
        runs_finished: this.#runsFinished,
        ...(this.#lastRun ? { last_run: this.#lastRun } : {}),
        ...this.#questionField(),
        updated_at: this.#iso(),
      });
      this.#registered = true;
      this.#registeredAt = this.#now();
    } catch (error) {
      this.#log(`session registration failed: ${errText(error)}`);
    }
  }

  #questionField(): { question?: OpenQuestion } {
    const first = this.#questions.values().next();
    return first.done ? {} : { question: first.value };
  }

  #gitRoot(cwd: string): string | null {
    if (this.#repo?.cwd === cwd) return this.#repo.root;
    let dir = cwd;
    let root: string | null = null;
    for (;;) {
      if (existsSync(join(dir, ".git"))) {
        root = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    this.#repo = { cwd, root };
    return root;
  }

  // ---- events ------------------------------------------------------------

  #emit(kind: EventBody["kind"], extra: Partial<EventBody>, timeoutMs?: number): Promise<void> {
    const c = this.#context();
    const info = this.#info;
    if (!c || !info) return Promise.resolve();
    const event: EventBody = {
      schema_version: 1,
      event_id: newId(),
      kind,
      host_id: c.cfg.hostId,
      session_id: info.id,
      cwd: info.cwd,
      at: this.#iso(),
      ...extra,
    };
    return c.outbox
      .enqueue(event, timeoutMs)
      .then(() => undefined)
      .catch((error) => this.#log(`event not queued: ${errText(error)}`));
  }

  // ---- hermes_ask --------------------------------------------------------

  async ask(params: AskParams, signal: AbortSignal | undefined): Promise<AgentToolResult> {
    const c = this.#context();
    const host = this.#host;
    const question = params.question?.trim() ?? "";
    // The webhook is optional: the question is always in the session file, the event only when it is configured.
    if (!c || !host || !this.#info) {
      return unavailable("The Hermes bridge is not configured for this session (bridge.host_id).");
    }
    if (question === "") return unavailable("The question is empty.");
    const timeoutS = Math.min(Math.max(Math.trunc(params.timeoutS ?? DEFAULT_ASK_TIMEOUT_S), 1), MAX_ASK_TIMEOUT_S);
    const choices = (params.choices ?? []).filter((x) => typeof x === "string" && x !== "");
    const id = newId();

    let settle!: (outcome: AskOutcome) => void;
    const outcome = new Promise<AskOutcome>((resolve) => {
      settle = resolve;
    });
    let done = false;
    const once = (value: AskOutcome) => {
      if (done) return;
      done = true;
      this.#closeQuestion(id);
      settle(value);
    };
    this.#waiting.set(id, { settle: once });
    this.#questions.set(id, { id, text: question, choices, timeout_s: timeoutS, asked_at: this.#iso() });
    this.#register();
    const timer = host.setTimeout(() => once({ status: "timeout" }), timeoutS * 1000);
    const onAbort = () => once({ status: "cancelled" });
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    // Not awaited: the question is already durable in the outbox when enqueue first yields.
    void this.#emit("asked", {
      question: { id, text: question, ...(choices.length ? { choices } : {}), timeout_s: timeoutS },
    });
    const result = await outcome;
    host.clearTimer(timer);
    signal?.removeEventListener("abort", onAbort);
    this.#waiting.delete(id);

    if (result.status === "answered") {
      return { content: [{ type: "text", text: result.text }], details: { status: "answered", question_id: id } };
    }
    const text =
      result.status === "timeout"
        ? `No answer from Hermes within ${timeoutS} seconds. The question is cancelled; a later answer is dropped.`
        : "The question was cancelled before an answer arrived. A later answer is dropped.";
    return { content: [{ type: "text", text }], details: { status: result.status, question_id: id } };
  }

  /** Drops the question from the session file as soon as it is settled, not when the tool call returns. */
  #closeQuestion(id: string): void {
    if (this.#questions.delete(id)) this.#register();
  }

  // ---- timer work --------------------------------------------------------

  /**
   * Sends due outbox files without holding up polling or the heartbeat: a slow or dead Hermes
   * makes each request last up to its timeout. One pass at a time; callers may await it.
   */
  flush(): Promise<void> {
    this.#flushRun ??= (this.#context()?.outbox.flush() ?? Promise.resolve())
      .catch((error) => this.#log(`outbox flush failed: ${errText(error)}`))
      .finally(() => {
        this.#flushRun = undefined;
      });
    return this.#flushRun;
  }

  /** One pass of periodic work. Overlapping calls share the pass already running. */
  tick(): Promise<void> {
    this.#tickRun ??= this.#tickOnce().finally(() => {
      this.#tickRun = undefined;
    });
    return this.#tickRun;
  }

  async #tickOnce(): Promise<void> {
    if (!this.#info || this.#state === "ended") return;
    try {
      if (!this.#registered || this.#now() - this.#registeredAt >= REGISTRATION_REFRESH_MS) {
        this.#prepare();
        this.#register();
      }
      this.#pollInbox();
      this.#checkDelivered();
      void this.flush();
    } catch (error) {
      this.#log(`tick failed: ${errText(error)}`);
    }
  }

  // ---- inbox -------------------------------------------------------------

  #pollInbox(): void {
    const c = this.#context();
    const host = this.#host;
    const info = this.#info;
    if (!c || !host || !info) return;
    const dir = c.queue.inboxDir(info.id);
    // Re-checked every poll so a directory swapped for a symlink is noticed.
    c.queue.ensureDir(c.queue.deliveringDir(info.id));
    c.queue.ensureDir(c.queue.doneDir(info.id));
    const messages: InboxMessage[] = [];
    for (const name of c.queue.listFiles(dir, JSON_FILE)) {
      const id = name.slice(0, -".json".length);
      if (this.#pending.has(id)) continue;
      const path = join(dir, name);
      const mtime = c.queue.mtimeMs(path);
      if (mtime !== undefined && this.#bad.get(name) === mtime) continue;
      const msg = parseInbox(c.queue.readText(path) ?? "", id);
      if (msg) messages.push(msg);
      else if (mtime !== undefined) {
        this.#bad.set(name, mtime);
        this.#log(`ignoring invalid inbox file ${name}`);
      }
    }
    messages.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.msg_id.localeCompare(b.msg_id));
    let startedTurn = false;
    for (const msg of messages) {
      try {
        startedTurn = this.#dispatch(c, host, info.id, msg, startedTurn) || startedTurn;
      } catch (error) {
        this.#log(`inbox message ${msg.msg_id} failed: ${errText(error)}`);
      }
    }
    // Markers whose inbox file is gone: leftovers of a crash after `done/` was written.
    for (const name of c.queue.listFiles(c.queue.deliveringDir(info.id), MARKER_FILE)) {
      if (!c.queue.exists(c.queue.inboxFile(info.id, name)) && !this.#pending.has(name)) {
        c.queue.remove(c.queue.marker(info.id, name));
      }
    }
  }

  /** Returns true when this call started an idle turn. */
  #dispatch(c: Ctx, host: Host, sid: string, msg: InboxMessage, startedTurn: boolean): boolean {
    if (c.queue.exists(c.queue.doneFile(sid, msg.msg_id))) {
      this.#cleanup(c, sid, msg.msg_id);
      return false;
    }
    // A marker from an earlier run: the message may already be in the session file.
    if (c.queue.exists(c.queue.marker(sid, msg.msg_id))) {
      this.#scanner.scan(host.sessionFile());
      if (this.#scanner.has(msg.msg_id, msg.kind)) {
        this.#finish(c, sid, msg);
        return false;
      }
    }
    if (msg.kind === "answer") {
      const waiting = this.#waiting.get((msg.reply_to ?? "").toLowerCase());
      if (!waiting) {
        this.#drop(c, sid, msg);
        return false;
      }
      c.queue.touch(c.queue.marker(sid, msg.msg_id));
      this.#pending.set(msg.msg_id, { msg, injectedAt: this.#now() });
      this.#waiting.delete((msg.reply_to ?? "").toLowerCase());
      waiting.settle({ status: "answered", text: `${markerLine(msg.msg_id)}\n${msg.text}` });
      return false;
    }
    c.queue.touch(c.queue.marker(sid, msg.msg_id));
    this.#pending.set(msg.msg_id, { msg, injectedAt: this.#now() });
    const idle = host.isIdle() && !startedTurn;
    try {
      host.sendUserMessage(`${markerLine(msg.msg_id)}\n${msg.text}`, {
        attribution: "agent",
        ...(idle ? {} : { deliverAs: "followUp" as const }),
      });
    } catch (error) {
      this.#log(`inject of ${msg.msg_id} failed: ${errText(error)}`);
    }
    return idle;
  }

  #checkDelivered(): void {
    const c = this.#context();
    const host = this.#host;
    const info = this.#info;
    if (!c || !host || !info || this.#pending.size === 0) return;
    this.#scanner.scan(host.sessionFile());
    const now = this.#now();
    const lostCandidate = host.isIdle() && !host.hasPendingMessages();
    for (const [id, pending] of [...this.#pending]) {
      try {
        if (this.#scanner.has(id, pending.msg.kind)) {
          this.#finish(c, info.id, pending.msg);
        } else if (pending.msg.kind === "prompt" && lostCandidate && now - pending.injectedAt >= REINJECT_AFTER_MS) {
          // Nothing queued, agent idle, and still not in the file: the follow-up was lost. The next poll injects it again.
          this.#pending.delete(id);
        }
      } catch (error) {
        this.#log(`delivery check of ${id} failed: ${errText(error)}`);
      }
    }
  }

  /** Step 5 of the contract: done/ first, then the inbox file, then the marker. */
  #finish(c: Ctx, sid: string, msg: InboxMessage): void {
    c.queue.writeJson(c.queue.doneFile(sid, msg.msg_id), { ...msg, delivered_at: this.#iso() });
    this.#pending.delete(msg.msg_id);
    this.#cleanup(c, sid, msg.msg_id);
  }

  #drop(c: Ctx, sid: string, msg: InboxMessage): void {
    c.queue.writeJson(c.queue.doneFile(sid, msg.msg_id), { ...msg, dropped: "late", dropped_at: this.#iso() });
    this.#cleanup(c, sid, msg.msg_id);
  }

  #cleanup(c: Ctx, sid: string, msgId: string): void {
    c.queue.remove(c.queue.inboxFile(sid, msgId));
    c.queue.remove(c.queue.marker(sid, msgId));
  }
}

function unavailable(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], details: { status: "unavailable" } };
}

export interface Outcome {
  kind: "ended" | "failed";
  summary?: string;
}

/** `stopReason` lives on the last assistant message, not on `agent_end` itself. */
export function classify(messages: unknown[]): Outcome {
  let last: any;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any)?.role === "assistant") {
      last = messages[i];
      break;
    }
  }
  const stop = last?.stopReason;
  if (stop === "error" || stop === "aborted") {
    const message = typeof last.errorMessage === "string" && last.errorMessage.trim() !== "" ? last.errorMessage : stop;
    return { kind: "failed", summary: truncate(message, SUMMARY_MAX) };
  }
  const text = Array.isArray(last?.content)
    ? last.content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n")
        .trim()
    : "";
  return text === "" ? { kind: "ended" } : { kind: "ended", summary: truncate(text, SUMMARY_MAX) };
}

export { SHUTDOWN_SEND_MS };
