// Helpers for the real-environment acceptance runs (see ACCEPTANCE.md). Not used by the extension.
import { type Subprocess, spawn } from "bun";
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const OMP = process.env.OMP_BIN ?? "omp";
export const MODEL = process.env.ACCEPT_MODEL ?? "";
export const WORK = process.env.ACCEPT_DIR ?? "";
export const EXT = resolve(import.meta.dir, "../src/index.ts");
export const SCRIPTS = import.meta.dir;
export const SECRET = "acceptance-secret-not-real";

/** A named profile or a moved config root makes omp ignore PI_CODING_AGENT_DIR, so none may be inherited. */
const PROFILE_VARS = ["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"];

export function requireEnv(): void {
  for (const name of PROFILE_VARS) delete process.env[name];
  if (!MODEL || !WORK || !process.env.PI_CODING_AGENT_DIR) {
    console.error("set ACCEPT_MODEL, ACCEPT_DIR and PI_CODING_AGENT_DIR (a throwaway agent directory)");
    process.exit(2);
  }
  if (process.env.PI_CODING_AGENT_DIR === join(homedir(), ".omp", "agent")) {
    console.error("refusing to run against the real agent directory");
    process.exit(2);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(what: string, fn: () => T | undefined | false, ms = 60_000, step = 25): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

let ports = 18800;

/** One scenario's private directory, queue root, bridge config and webhook listener. */
export class Env {
  dir: string;
  root: string;
  config: string;
  log: string;
  failFile: string;
  port = ++ports;
  listener: Subprocess | undefined;

  constructor(readonly name: string) {
    this.dir = join(WORK, name);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.root = join(this.dir, "queue");
    this.config = join(this.dir, "bridge.json");
    this.log = join(this.dir, "events.jsonl");
    this.failFile = join(this.dir, "fail");
    writeFileSync(
      this.config,
      JSON.stringify({
        "bridge.host_id": "accept-host",
        "bridge.root": this.root,
        "bridge.webhook_url": `http://127.0.0.1:${this.port}/hook`,
        "bridge.webhook_secret": SECRET,
      }),
    );
    chmodSync(this.config, 0o600);
  }

  env(): Record<string, string> {
    const base = { ...(process.env as Record<string, string>) };
    for (const name of PROFILE_VARS) delete base[name];
    return { ...base, OMP_HERMES_BRIDGE_CONFIG: this.config, PI_NO_TITLE: "1" };
  }

  startListener(): void {
    this.listener = spawn(["bun", join(SCRIPTS, "webhook-listener.ts")], {
      env: { ...process.env, LISTEN_PORT: String(this.port), LISTEN_SECRET: SECRET, LISTEN_LOG: this.log, LISTEN_FAIL_FILE: this.failFile },
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  stopListener(): void {
    this.listener?.kill();
    this.listener = undefined;
  }

  /** Accepted requests only, in arrival order. */
  accepted(): any[] {
    return this.lines().filter((l) => l.result === "accepted").map((l) => l.event);
  }

  lines(): any[] {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  sessionFiles(): string[] {
    const dir = join(this.root, "sessions");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)) : [];
  }

  registration(sid: string): any | undefined {
    const file = join(this.root, "sessions", `${sid}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  }

  inbox(sid: string, ...sub: string[]): string[] {
    const dir = join(this.root, "inbox", sid, ...sub);
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  outbox(): string[] {
    const dir = join(this.root, "outbox");
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  async send(sid: string, kind: "prompt" | "answer", text: string, replyTo?: string): Promise<string> {
    const args = ["bun", join(SCRIPTS, "inbox-send.ts"), "--root", this.root, "--session", sid, "--kind", kind, "--text", text];
    if (replyTo) args.push("--reply-to", replyTo);
    const p = spawn(args, { stdout: "pipe" });
    return (await new Response(p.stdout).text()).trim();
  }

  cleanup(): void {
    this.stopListener();
  }
}

export class Rpc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  frames: any[] = [];
  #n = 0;

  constructor(readonly e: Env, extra: string[] = [], model = MODEL) {
    this.proc = spawn([OMP, "--mode", "rpc", "-e", EXT, "--model", model, ...extra], {
      env: e.env(),
      cwd: e.dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.#read();
    void new Response(this.proc.stderr).text().then((t) => writeFileSync(join(e.dir, `rpc-${process.pid}-${Date.now()}.stderr`), t));
  }

  async #read(): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += decoder.decode(chunk);
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          this.frames.push(JSON.parse(line));
        } catch {
          // not a frame
        }
      }
    }
  }

  send(command: Record<string, unknown>): string {
    const id = `c${++this.#n}`;
    this.proc.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    return id;
  }

  async call(command: Record<string, unknown>, ms = 30_000): Promise<any> {
    const id = this.send(command);
    return until(`response ${command.type}`, () => this.frames.find((f) => f.type === "response" && f.id === id), ms);
  }

  async ready(): Promise<void> {
    await until("rpc ready", () => this.frames.find((f) => f.type === "ready"), 60_000);
  }

  async state(): Promise<{ sessionId: string; sessionFile?: string }> {
    return (await this.call({ type: "get_state" })).data;
  }

  count(type: string): number {
    return this.frames.filter((f) => f.type === type).length;
  }

  async close(ms = 20_000): Promise<number> {
    this.proc.stdin.end();
    const exit = await Promise.race([this.proc.exited, sleep(ms).then(() => -999)]);
    if (exit === -999) this.proc.kill(9);
    return exit as number;
  }

  kill9(): void {
    this.proc.kill(9);
  }
}

/** Fails the run when omp keeps its sessions anywhere but the throwaway agent directory. */
export function assertAgentDir(sessionFile: string | undefined): void {
  const dir = resolve(process.env.PI_CODING_AGENT_DIR ?? "");
  if (!sessionFile || !resolve(sessionFile).startsWith(`${dir}/`)) {
    throw new Error(`session file ${sessionFile} is outside the throwaway agent dir ${dir}`);
  }
}

export function countMarker(sessionFile: string, msgId: string): number {
  if (!existsSync(sessionFile)) return 0;
  return readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.includes(`[bridge msg_id=${msgId}]`)).length;
}

/** Distinct consecutive `state` values of a registration file, sampled every 20 ms. */
export function watchStates(e: Env, sid: string): { stop(): string[] } {
  const seen: string[] = [];
  const sample = () => {
    try {
      const s = e.registration(sid)?.state;
      if (s && seen.at(-1) !== s) seen.push(s);
    } catch {
      // mid-rename read
    }
  };
  sample(); // the first state is often gone before the first timer tick
  const t = setInterval(sample, 20);
  return { stop: () => (clearInterval(t), seen) };
}

export type Result = { scenario: string; result: "pass" | "fail"; observed: unknown };

export function report(r: Result): void {
  console.log(JSON.stringify(r));
}
