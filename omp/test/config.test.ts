import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore, loadConfig } from "../src/config.ts";
import { Queue } from "../src/queue.ts";
import { tempDir } from "./helpers.ts";
import { mkdirSync, symlinkSync, existsSync, statSync } from "node:fs";

function write(dir: string, values: unknown, mode = 0o600) {
  const file = join(dir, "hermes-bridge.json");
  writeFileSync(file, JSON.stringify(values));
  chmodSync(file, mode);
}

describe("config", () => {
  const env = {} as NodeJS.ProcessEnv;

  test("reads the contract keys; root defaults to hermes-bridge/ in the agent dir", () => {
    const dir = tempDir();
    write(dir, { "bridge.host_id": "laptop", "bridge.webhook_url": "https://h.invalid/hook", "bridge.webhook_secret": "s" });
    expect(loadConfig(dir, env)).toEqual({
      config: { root: join(dir, "hermes-bridge"), hostId: "laptop", webhookUrl: "https://h.invalid/hook", webhookSecret: "s" },
    });
  });

  test("host_id is required", () => {
    const dir = tempDir();
    write(dir, { "bridge.webhook_url": "https://h.invalid/hook" });
    expect("problem" in loadConfig(dir, env)).toBe(true);
  });

  test("a file readable by group or others is refused because it holds the secret", () => {
    const dir = tempDir();
    write(dir, { "bridge.host_id": "laptop" }, 0o644);
    const result = loadConfig(dir, env);
    expect("problem" in result && result.problem).toContain("0600");
  });

  test("missing and malformed files are problems, not exceptions", () => {
    const dir = tempDir();
    expect("problem" in loadConfig(dir, env)).toBe(true);
    writeFileSync(join(dir, "hermes-bridge.json"), "{", { mode: 0o600 });
    expect("problem" in loadConfig(dir, env)).toBe(true);
  });

  test("the webhook secret keeps its exact bytes", () => {
    const dir = tempDir();
    write(dir, { "bridge.host_id": "h", "bridge.webhook_secret": " s e c " });
    expect(loadConfig(dir, env)).toMatchObject({ config: { webhookSecret: " s e c " } });
  });

  test("a relative root is resolved against the agent dir", () => {
    const dir = tempDir();
    write(dir, { "bridge.host_id": "h", "bridge.root": "q" });
    expect(loadConfig(dir, env)).toMatchObject({ config: { root: join(dir, "q") } });
  });

  test("the store picks up an edit made during the session", () => {
    const dir = tempDir();
    const store = new ConfigStore(dir, env);
    expect("problem" in store.get()).toBe(true);
    write(dir, { "bridge.host_id": "one" });
    expect(store.get()).toMatchObject({ config: { hostId: "one" } });
    write(dir, { "bridge.host_id": "two-longer" });
    expect(store.get()).toMatchObject({ config: { hostId: "two-longer" } });
  });
});

describe("queue", () => {
  test("creates directories 0700 and tightens loose ones", () => {
    const root = join(tempDir(), "q");
    const q = new Queue(root);
    q.ensureDir(join(root, "a", "b"));
    mkdirSync(join(root, "loose"), { mode: 0o755 });
    chmodSync(join(root, "loose"), 0o755);
    q.ensureDir(join(root, "loose"));
    for (const p of [root, join(root, "a"), join(root, "a", "b"), join(root, "loose")]) {
      expect(statSync(p).mode & 0o777).toBe(0o700);
    }
  });

  test("rejects a path outside the root and an id that is not a UUID", () => {
    const root = join(tempDir(), "q");
    const q = new Queue(root);
    expect(() => q.ensureDir(join(root, "..", "x"))).toThrow();
    expect(() => q.ensureDir(join(tempDir(), "elsewhere"))).toThrow();
    expect(() => q.inboxDir("../../etc")).toThrow();
    expect(() => q.marker("019a2f00-0000-7000-8000-000000000001", "../x")).toThrow();
  });

  test("atomic writes leave no .tmp and are 0600; a symlink planted at the .tmp name is not followed", () => {
    const root = join(tempDir(), "q");
    const q = new Queue(root);
    q.ensureDir(root);
    const outside = join(tempDir(), "victim");
    writeFileSync(outside, "keep");
    const target = join(root, "f.json");
    symlinkSync(outside, `${target}.tmp`);
    q.writeAtomic(target, "{}");
    expect(existsSync(`${target}.tmp`)).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(require("node:fs").readFileSync(outside, "utf8")).toBe("keep");
  });

  test("a symlinked file or directory below the root is rejected", () => {
    const root = join(tempDir(), "q");
    const q = new Queue(root);
    q.ensureDir(root);
    const outside = tempDir();
    symlinkSync(outside, join(root, "linked"));
    expect(() => q.ensureDir(join(root, "linked", "child"))).toThrow();
    writeFileSync(join(outside, "a.json"), "{}");
    symlinkSync(join(outside, "a.json"), join(root, "a.json"));
    expect(q.readText(join(root, "a.json"))).toBeUndefined();
  });
});
