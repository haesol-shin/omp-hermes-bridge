import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ompHermesBridge from "../src/index.ts";
import type { ExtensionApiLike, ExtensionCtx } from "../src/types.ts";
import { FakeHost, queueProblems, SESSION_ID, tempDir } from "./helpers.ts";

type Handler = (event: any, ctx: ExtensionCtx) => unknown;

function load(agentDir: string) {
  const handlers = new Map<string, Handler>();
  let tool: any;
  const sent: unknown[] = [];
  const warnings: string[] = [];
  const pi: ExtensionApiLike = {
    on: (event, handler) => void handlers.set(event, handler),
    sendUserMessage: (...args) => void sent.push(args),
    registerTool: (t) => void (tool = t),
    zod: new Proxy({}, { get: () => () => new Proxy(() => undefined, { get: () => () => new Proxy({}, { get: () => () => ({}) }) }) }),
    logger: { warn: (m) => void warnings.push(m), debug: () => {} },
    pi: { getAgentDir: () => agentDir },
  };
  ompHermesBridge(pi);
  return { handlers, tool, sent, warnings };
}

function setup() {
  const dir = tempDir();
  const root = join(dir, "queue");
  const cfg = join(dir, "hermes-bridge.json");
  writeFileSync(
    cfg,
    JSON.stringify({ "bridge.host_id": "h", "bridge.root": root, "bridge.webhook_url": "http://127.0.0.1:1/x", "bridge.webhook_secret": "s" }),
  );
  chmodSync(cfg, 0o600);
  return { dir, root };
}

function ctxFor(dir: string, kind: "main" | "sub", overrides: Partial<ExtensionCtx> = {}): ExtensionCtx {
  const host = new FakeHost(dir);
  return {
    mode: "rpc",
    cwd: dir,
    agent: { kind },
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => host.file, getSessionName: () => undefined },
    isIdle: () => true,
    hasPendingMessages: () => false,
    setInterval: (fn, ms) => host.setInterval(fn, ms),
    setTimeout: (fn, ms) => host.setTimeout(fn, ms),
    clearTimer: (t) => host.clearTimer(t),
    ...overrides,
  };
}

describe("extension wiring", () => {
  test("registers the hermes_ask tool and the lifecycle handlers", () => {
    const { dir } = setup();
    const { handlers, tool } = load(dir);
    expect(tool.name).toBe("hermes_ask");
    expect([...handlers.keys()].sort()).toEqual(["agent_end", "agent_start", "session_branch", "session_shutdown", "session_start", "session_switch"]);
  });

  test("main agent: registers on session_start, follows agent events, ends on shutdown", async () => {
    const { dir, root } = setup();
    const { handlers } = load(dir);
    const ctx = ctxFor(dir, "main");
    await handlers.get("session_start")?.({}, ctx);
    const read = () => JSON.parse(require("node:fs").readFileSync(join(root, "sessions", `${SESSION_ID}.json`), "utf8")).state;
    expect(read()).toBe("idle");
    await handlers.get("agent_start")?.({}, ctx);
    expect(read()).toBe("working");
    await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
    expect(read()).toBe("idle");
    await handlers.get("session_shutdown")?.({}, ctx);
    expect(read()).toBe("ended");
    expect(queueProblems(root).filter((p) => !p.startsWith("outbox"))).toEqual([]);
  });

  test("subagents neither register nor emit, and hermes_ask refuses there", async () => {
    const { dir, root } = setup();
    const { handlers, tool } = load(dir);
    const ctx = ctxFor(dir, "sub");
    for (const name of ["session_start", "agent_start", "session_switch"]) await handlers.get(name)?.({}, ctx);
    await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
    expect(existsSync(root)).toBe(false);
    const result = await tool.execute("id", { question: "q" }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  test("no handler throws, whatever omp or the filesystem does", async () => {
    const { dir, root } = setup();
    const { handlers, tool, warnings } = load(dir);
    const broken = ctxFor(dir, "main", {
      sessionManager: {
        getSessionId: () => {
          throw new Error("no session");
        },
        getSessionFile: () => undefined,
        getSessionName: () => undefined,
      },
    });
    for (const name of handlers.keys()) await expect(Promise.resolve(handlers.get(name)?.({ messages: "garbage" }, broken))).resolves.toBeUndefined();
    const result = await tool.execute("id", { question: "q" }, undefined, undefined, broken);
    expect(result.isError).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    // Unusable queue root: a file where the directory should be.
    writeFileSync(root, "not a directory");
    const ok = ctxFor(dir, "main");
    for (const name of ["session_start", "agent_start", "session_switch"]) await expect(Promise.resolve(handlers.get(name)?.({}, ok))).resolves.toBeUndefined();
    await expect(Promise.resolve(handlers.get("agent_end")?.({ messages: [] }, ok))).resolves.toBeUndefined();
    await expect(Promise.resolve(handlers.get("session_shutdown")?.({}, ok))).resolves.toBeUndefined();
    expect(readdirSync(dir).includes("queue")).toBe(true);
  });

  test("without a config file the extension stays silent and inert", async () => {
    const dir = tempDir();
    const { handlers, tool, warnings } = load(dir);
    const ctx = ctxFor(dir, "main");
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_end")?.({ messages: [] }, ctx);
    expect(warnings).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    const result = await tool.execute("id", { question: "q" }, undefined, undefined, ctx);
    expect(result.details.status).toBe("unavailable");
  });
});
