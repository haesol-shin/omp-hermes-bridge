import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, lstatSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Bridge, type Host, type SessionInfo } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/config.ts";
import type { FetchLike } from "../src/outbox.ts";

const CONTRACT = join(import.meta.dir, "..", "..", "contract");
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

export type SchemaName = "session" | "event" | "inbox-message" | "done-message";

export function schemaErrors(name: SchemaName, value: unknown): string[] {
  let validate = validators.get(name);
  if (!validate) {
    const schema = JSON.parse(readFileSync(join(CONTRACT, "schema", `${name}.schema.json`), "utf8"));
    validate = ajv.compile(schema);
    validators.set(name, validate);
  }
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Every file the extension left in the queue must match its contract schema, mode and name rules. */
export function queueProblems(root: string): string[] {
  const problems: string[] = [];
  if (!existsSync(root)) return problems;
  const dirs = [root];
  for (const path of walk(root)) {
    const rel = relative(root, path).split(sep);
    const st = lstatSync(path);
    if ((st.mode & 0o777) !== 0o600) problems.push(`${rel.join("/")} mode ${(st.mode & 0o777).toString(8)}`);
    if (path.endsWith(".tmp")) problems.push(`${rel.join("/")} left behind`);
    let name: SchemaName | undefined;
    if (rel[0] === "sessions") name = "session";
    else if (rel[0] === "outbox") name = "event";
    else if (rel[0] === "inbox" && rel[2] === "done") name = "done-message";
    else if (rel[0] === "inbox" && rel.length === 3) name = "inbox-message";
    if (name) {
      for (const e of schemaErrors(name, JSON.parse(readFileSync(path, "utf8")))) problems.push(`${rel.join("/")}: ${e}`);
    }
    for (let d = join(path, ".."); d.startsWith(root) && !dirs.includes(d); d = join(d, "..")) dirs.push(d);
  }
  for (const d of dirs) {
    const mode = lstatSync(d).mode & 0o777;
    if (mode !== 0o700) problems.push(`dir ${relative(root, d) || "."} mode ${mode.toString(8)}`);
  }
  return problems;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "omp-hermes-bridge-test-"));
}

export const SESSION_ID = "019a2f00-0000-7000-8000-000000000001";
export const SECRET = "test-secret";

export class FakeHost implements Host {
  idle = true;
  queued = false;
  hasFile = true;
  name: string | undefined;
  sent: { text: string; options: { deliverAs?: "followUp"; attribution: "agent" } }[] = [];
  timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
  intervals: { fn: () => void; ms: number }[] = [];
  file: string;

  constructor(dir: string, name = "session.jsonl") {
    this.file = join(dir, name);
  }

  sendUserMessage(text: string, options: { deliverAs?: "followUp"; attribution: "agent" }) {
    this.sent.push({ text, options });
  }
  isIdle = () => this.idle;
  hasPendingMessages = () => this.queued;
  sessionFile = () => (this.hasFile ? this.file : undefined);
  sessionName = () => this.name;
  setInterval(fn: () => void, ms: number) {
    this.intervals.push({ fn, ms });
    return this.intervals.length;
  }
  setTimeout(fn: () => void, ms: number) {
    this.timeouts.push({ fn, ms, cleared: false });
    return this.timeouts.length - 1;
  }
  clearTimer(timer: unknown) {
    const t = this.timeouts[timer as number];
    if (t) t.cleared = true;
  }

  /** What omp would store: a user message entry for text we injected. */
  persistUser(text: string) {
    this.#append({ type: "message", id: "a", message: { role: "user", content: [{ type: "text", text }], attribution: "agent" } });
  }
  persistToolResult(text: string, toolName = "hermes_ask") {
    this.#append({ type: "message", id: "b", message: { role: "toolResult", toolName, content: [{ type: "text", text }] } });
  }
  persistLast() {
    const last = this.sent.at(-1);
    if (last) this.persistUser(last.text);
  }
  #append(entry: unknown) {
    mkdirSync(join(this.file, ".."), { recursive: true });
    if (!existsSync(this.file)) writeFileSync(this.file, `${JSON.stringify({ type: "session" })}\n`);
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }
}

export interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export class FakeNet {
  calls: Call[] = [];
  statuses: number[] = [];
  fail = false;
  fetch: FetchLike = async (url, init) => {
    this.calls.push({ url, headers: init.headers, body: new TextDecoder().decode(init.body) });
    if (this.fail) throw new Error("connection refused");
    return { status: this.statuses.shift() ?? 200 };
  };
  events() {
    return this.calls.map((c) => JSON.parse(c.body));
  }
}

export interface Rig {
  dir: string;
  root: string;
  cfg: { value: { config: BridgeConfig } | { problem: string } };
  net: FakeNet;
  clock: { t: number };
  logs: string[];
  bridge: Bridge;
  host: FakeHost;
  info: SessionInfo;
  make(): { bridge: Bridge; host: FakeHost };
}

export function rig(overrides: Partial<BridgeConfig> = {}, sessionId = SESSION_ID): Rig {
  const dir = tempDir();
  const root = join(dir, "queue");
  const cfg = {
    value: {
      config: {
        root,
        hostId: "testhost",
        webhookUrl: "http://127.0.0.1:1/hook",
        webhookSecret: SECRET,
        ...overrides,
      },
    } as { config: BridgeConfig } | { problem: string },
  };
  const net = new FakeNet();
  const clock = { t: Date.parse("2026-10-30T05:00:00Z") };
  const logs: string[] = [];
  const info: SessionInfo = { id: sessionId, cwd: join(dir, "project"), awaitSends: false };
  const make = () => {
    const bridge = new Bridge({
      config: { get: () => cfg.value },
      fetch: (url, init) => net.fetch(url, init),
      now: () => clock.t,
      pid: 4242,
      log: (m) => logs.push(m),
    });
    const host = new FakeHost(dir);
    return { bridge, host };
  };
  const first = make();
  return { dir, root, cfg, net, clock, logs, ...first, info, make };
}

/** attach() starts a pass; settle it and run one more so everything it queued is handled. */
export async function settle(bridge: Bridge): Promise<void> {
  await bridge.tick();
  await bridge.flush();
  await bridge.tick();
  await bridge.flush();
}

export function writeInbox(root: string, sid: string, message: Record<string, unknown>): string {
  const dir = join(root, "inbox", sid);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${message.msg_id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(message), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return file;
}

let counter = 0;
/** Deterministic valid UUID v4 values for tests. */
export function uuid4(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

export function prompt(text = "run the tests", extra: Record<string, unknown> = {}) {
  return { schema_version: 1, msg_id: uuid4(), kind: "prompt", text, created_at: "2026-10-30T05:10:00Z", ...extra };
}

export function answer(replyTo: string, text = "Use option B.", extra: Record<string, unknown> = {}) {
  return { schema_version: 1, msg_id: uuid4(), kind: "answer", text, reply_to: replyTo, created_at: "2026-10-30T05:12:30Z", ...extra };
}

export const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
export { existsSync };
