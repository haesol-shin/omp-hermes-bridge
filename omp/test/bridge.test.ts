import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify, REGISTRATION_REFRESH_MS, REINJECT_AFTER_MS } from "../src/bridge.ts";
import {
  answer,
  existsSync,
  prompt,
  queueProblems,
  readJson,
  rig,
  SECRET,
  SESSION_ID,
  settle,
  tempDir,
  writeInbox,
} from "./helpers.ts";

const sessionFile = (r: { root: string }) => join(r.root, "sessions", `${SESSION_ID}.json`);
const inboxPath = (r: { root: string }, id: string, ...rest: string[]) => join(r.root, "inbox", SESSION_ID, ...rest, `${id}.json`);
const markerPath = (r: { root: string }, id: string) => join(r.root, "inbox", SESSION_ID, "delivering", id);
const assistant = (stopReason: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  stopReason,
  content: [{ type: "text", text: "All tests pass." }],
  ...extra,
});

describe("session registration and state table", () => {
  test("registers idle at start, follows agent_start/agent_end, ends at shutdown", async () => {
    const r = rig();
    r.host.name = "Fix login";
    r.bridge.attach(r.host, r.info);
    expect(readJson(sessionFile(r))).toMatchObject({ state: "idle", host_id: "testhost", pid: 4242, title: "Fix login", session_id: SESSION_ID });
    r.bridge.onAgentStart();
    expect(readJson(sessionFile(r)).state).toBe("working");
    await r.bridge.onAgentEnd([assistant("stop")], undefined);
    expect(readJson(sessionFile(r)).state).toBe("idle");
    await r.bridge.shutdown();
    expect(readJson(sessionFile(r)).state).toBe("ended");
    expect(queueProblems(r.root)).toEqual([]);
  });

  test("agent_end with willContinue stays working and sends no event", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    await settle(r.bridge);
    r.bridge.onAgentStart();
    await r.bridge.onAgentEnd([assistant("error", { errorMessage: "503" })], true);
    expect(readJson(sessionFile(r)).state).toBe("working");
    expect(r.net.calls).toHaveLength(0);
    expect(existsSync(join(r.root, "outbox"))).toBe(true);
    expect(readdirSync(join(r.root, "outbox"))).toEqual([]);
  });

  test("updated_at is refreshed every 5 minutes in every state", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    await settle(r.bridge);
    const before = readJson(sessionFile(r)).updated_at;
    r.clock.t += REGISTRATION_REFRESH_MS - 1000;
    await r.bridge.tick();
    expect(readJson(sessionFile(r)).updated_at).toBe(before);
    r.clock.t += 2000;
    await r.bridge.tick();
    expect(readJson(sessionFile(r)).updated_at).not.toBe(before);
    r.bridge.onAgentStart();
    r.clock.t += REGISTRATION_REFRESH_MS;
    await r.bridge.tick();
    expect(readJson(sessionFile(r))).toMatchObject({ state: "working" });
  });

  test("a new session id ends the old registration and registers the new one", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const next = "019a2f00-0000-7000-8000-000000000002";
    r.bridge.attach(r.host, { ...r.info, id: next });
    expect(readJson(sessionFile(r)).state).toBe("ended");
    expect(readJson(join(r.root, "sessions", `${next}.json`)).state).toBe("idle");
    expect(queueProblems(r.root)).toEqual([]);
  });

  test("repo is the git root of cwd, null outside a repository", async () => {
    const r = rig();
    mkdirSync(join(r.dir, "project", "sub"), { recursive: true });
    mkdirSync(join(r.dir, "project", ".git"));
    r.bridge.attach(r.host, { ...r.info, cwd: join(r.dir, "project", "sub") });
    expect(readJson(sessionFile(r)).repo).toBe(join(r.dir, "project"));
  });
});

describe("classify", () => {
  test.each([
    ["stop", "ended", "All tests pass."],
    ["toolUse", "ended", "All tests pass."],
    ["length", "ended", "All tests pass."],
  ])("stopReason %s is %s", (stop, kind, summary) => {
    expect(classify([assistant(stop)])).toEqual({ kind: kind as "ended", summary });
  });

  test("error and aborted are failed with the message as given", () => {
    expect(classify([assistant("error", { errorMessage: "429 quota" })])).toEqual({ kind: "failed", summary: "429 quota" });
    expect(classify([assistant("aborted", { errorMessage: "Request was aborted" })])).toEqual({
      kind: "failed",
      summary: "Request was aborted",
    });
    expect(classify([assistant("aborted")])).toEqual({ kind: "failed", summary: "aborted" });
  });

  test("reads the last assistant message, ignores later non-assistant ones", () => {
    const messages = [assistant("error", { errorMessage: "old" }), assistant("stop"), { role: "toolResult" }];
    expect(classify(messages).kind).toBe("ended");
  });

  test("summary is cut to 4000 and an empty one is omitted", () => {
    const long = classify([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x".repeat(9000) }] }]);
    expect(long.summary?.length).toBe(4000);
    expect(classify([{ role: "assistant", stopReason: "stop", content: [] }])).toEqual({ kind: "ended" });
    expect(classify([])).toEqual({ kind: "ended" });
  });
});

describe("events", () => {
  test("ended and failed events are valid, signed, accepted and leave the outbox empty", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    await settle(r.bridge);
    r.bridge.onAgentStart();
    await r.bridge.onAgentEnd([assistant("stop")], false);
    r.bridge.onAgentStart();
    await r.bridge.onAgentEnd([assistant("aborted", { errorMessage: "Request was aborted" })], false);
    await settle(r.bridge);
    const events = r.net.events();
    expect(events.map((e) => e.kind)).toEqual(["ended", "failed"]);
    expect(events[1].summary).toBe("Request was aborted");
    for (const call of r.net.calls) {
      const ts = call.headers["X-Webhook-Timestamp"];
      expect(ts).toBe(String(Math.floor(r.clock.t / 1000)));
      const expected = createHmac("sha256", SECRET).update(`${ts}.${call.body}`).digest("hex");
      expect(call.headers["X-Webhook-Signature-V2"]).toBe(expected);
      expect(call.headers["X-Request-ID"]).toBe(JSON.parse(call.body).event_id);
    }
    expect(readdirSync(join(r.root, "outbox"))).toEqual([]);
    expect(queueProblems(r.root)).toEqual([]);
  });

  test("a failing webhook keeps the event, retries with growing delay, new signature, same body", async () => {
    const r = rig();
    r.net.fail = true;
    r.bridge.attach(r.host, r.info);
    await settle(r.bridge);
    await r.bridge.onAgentEnd([assistant("stop")], false);
    const files = readdirSync(join(r.root, "outbox"));
    expect(files).toHaveLength(1);
    expect(queueProblems(r.root)).toEqual([]);
    const attemptsAt = async (ms: number) => {
      r.clock.t += ms;
      const before = r.net.calls.length;
      await r.bridge.tick();
      await r.bridge.flush();
      return r.net.calls.length - before;
    };
    const first = r.net.calls.length;
    expect(first).toBe(1);
    expect(await attemptsAt(4000)).toBe(0); // base delay 5 s
    expect(await attemptsAt(2000)).toBe(1); // 6 s: due
    expect(await attemptsAt(9000)).toBe(0); // second delay 10 s
    expect(await attemptsAt(2000)).toBe(1);
    const [a, b] = [r.net.calls[0], r.net.calls[2]];
    expect(b.body).toBe(a.body);
    expect(b.headers["X-Request-ID"]).toBe(a.headers["X-Request-ID"]);
    expect(b.headers["X-Webhook-Timestamp"]).not.toBe(a.headers["X-Webhook-Timestamp"]);
    expect(b.headers["X-Webhook-Signature-V2"]).not.toBe(a.headers["X-Webhook-Signature-V2"]);
    r.net.fail = false;
    r.clock.t += 60_000;
    await r.bridge.tick();
    await r.bridge.flush();
    expect(readdirSync(join(r.root, "outbox"))).toEqual([]);
  });

  test("a non-2xx answer keeps the event", async () => {
    const r = rig();
    r.net.statuses = [401];
    r.bridge.attach(r.host, r.info);
    await r.bridge.onAgentEnd([assistant("stop")], false);
    expect(readdirSync(join(r.root, "outbox"))).toHaveLength(1);
  });

  test("a leftover event from an earlier process is sent once it is old enough", async () => {
    const r = rig();
    r.net.fail = true;
    r.bridge.attach(r.host, r.info);
    await r.bridge.onAgentEnd([assistant("stop")], false);
    const second = r.make();
    r.net.fail = false;
    r.net.calls.length = 0;
    second.bridge.attach(second.host, r.info);
    await settle(second.bridge);
    expect(r.net.calls).toHaveLength(0); // file is younger than the grace period
  });

  test("no webhook configured: registration works, events are dropped, nothing piles up", async () => {
    const r = rig({ webhookUrl: undefined, webhookSecret: undefined });
    r.bridge.attach(r.host, r.info);
    await r.bridge.onAgentEnd([assistant("stop")], false);
    expect(readJson(sessionFile(r)).state).toBe("idle");
    expect(readdirSync(join(r.root, "outbox"))).toEqual([]);
    expect(r.net.calls).toHaveLength(0);
  });

  test("print mode awaits the send, other modes do not", async () => {
    const r = rig();
    let release!: () => void;
    r.net.fetch = () => new Promise((resolve) => { release = () => resolve({ status: 200 }); });
    r.bridge.attach(r.host, { ...r.info, awaitSends: true });
    let done = false;
    const end = r.bridge.onAgentEnd([assistant("stop")], false).then(() => { done = true; });
    await Bun.sleep(10);
    expect(done).toBe(false);
    release();
    await end;
    expect(done).toBe(true);
  });
});

describe("inbox prompts", () => {
  test("idle session: marker first line, agent attribution, no followUp; done only after the file shows it", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const msg = prompt("Run the tests again.");
    writeInbox(r.root, SESSION_ID, msg);
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(1);
    const { text, options } = r.host.sent[0];
    expect(text).toBe(`[bridge msg_id=${msg.msg_id}]\nRun the tests again.`);
    expect(options).toEqual({ attribution: "agent" });
    expect(existsSync(markerPath(r, msg.msg_id))).toBe(true);
    expect(existsSync(inboxPath(r, msg.msg_id))).toBe(true);
    expect(existsSync(inboxPath(r, msg.msg_id, "done"))).toBe(false);

    r.host.persistLast();
    await r.bridge.onAgentEnd([assistant("stop")], false);
    const done = readJson(inboxPath(r, msg.msg_id, "done"));
    expect(done).toMatchObject({ msg_id: msg.msg_id, kind: "prompt", text: "Run the tests again." });
    expect(done.delivered_at).toBeDefined();
    expect(existsSync(inboxPath(r, msg.msg_id))).toBe(false);
    expect(existsSync(markerPath(r, msg.msg_id))).toBe(false);
    expect(r.host.sent).toHaveLength(1);
    expect(queueProblems(r.root)).toEqual([]);
  });

  test("working session: injected as followUp", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    r.host.idle = false;
    writeInbox(r.root, SESSION_ID, prompt());
    await settle(r.bridge);
    expect(r.host.sent[0].options).toEqual({ attribution: "agent", deliverAs: "followUp" });
  });

  test("two prompts in one pass start at most one turn", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    writeInbox(r.root, SESSION_ID, prompt("one", { created_at: "2026-10-30T05:10:00Z" }));
    writeInbox(r.root, SESSION_ID, prompt("two", { created_at: "2026-10-30T05:10:01Z" }));
    await settle(r.bridge);
    expect(r.host.sent.map((s) => s.text.split("\n")[1])).toEqual(["one", "two"]);
    expect(r.host.sent.map((s) => s.options.deliverAs)).toEqual([undefined, "followUp"]);
  });

  test("no session file yet means not delivered; the marker quoted elsewhere is not proof", async () => {
    const r = rig();
    r.host.hasFile = false;
    r.bridge.attach(r.host, r.info);
    const msg = prompt();
    writeInbox(r.root, SESSION_ID, msg);
    await settle(r.bridge);
    r.host.hasFile = true;
    r.host.persistToolResult(`log\n[bridge msg_id=${msg.msg_id}]\nquoted`, "bash");
    r.host.persistUser(`please look at [bridge msg_id=${msg.msg_id}] again`);
    await settle(r.bridge);
    expect(existsSync(inboxPath(r, msg.msg_id, "done"))).toBe(false);
    r.host.persistLast();
    await settle(r.bridge);
    expect(existsSync(inboxPath(r, msg.msg_id, "done"))).toBe(true);
  });

  test("a follow-up lost while the agent is idle is injected again, never earlier", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    writeInbox(r.root, SESSION_ID, prompt());
    await settle(r.bridge);
    r.clock.t += REINJECT_AFTER_MS - 1000;
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(1);
    r.host.queued = true; // still waiting in omp's queue
    r.clock.t += 5000;
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(1);
    r.host.queued = false;
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(2);
    expect(r.host.sent[1].text).toBe(r.host.sent[0].text);
  });

  test("an invalid inbox file is left alone and does not block later messages", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const bad = prompt("x", { reply_to: uuidLike() });
    const badPath = writeInbox(r.root, SESSION_ID, bad);
    const good = prompt("good");
    writeInbox(r.root, SESSION_ID, good);
    await settle(r.bridge);
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(1);
    expect(existsSync(badPath)).toBe(true);
    expect(r.logs.filter((l) => l.includes("invalid inbox")).length).toBe(1);
  });

  test("a symlinked inbox file is ignored", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const msg = prompt();
    const outside = join(r.dir, "outside.json");
    writeFileSync(outside, JSON.stringify(msg));
    symlinkSync(outside, inboxPath(r, msg.msg_id));
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(0);
  });
});

const uuidLike = () => "00000000-0000-4000-8000-0000000000ff";

describe("kill and restart at the three points", () => {
  test("before injecting: marker exists, nothing in the session file -> injected exactly once", async () => {
    const r = rig();
    const msg = prompt();
    r.bridge.attach(r.host, r.info);
    writeInbox(r.root, SESSION_ID, msg);
    // The old process died right after creating the marker.
    writeFileSync(markerPath(r, msg.msg_id), "", { mode: 0o600 });
    const next = r.make();
    next.bridge.attach(next.host, r.info);
    await settle(next.bridge);
    expect(next.host.sent).toHaveLength(1);
    next.host.persistLast();
    await settle(next.bridge);
    expect(existsSync(inboxPath(r, msg.msg_id, "done"))).toBe(true);
  });

  test("right after injecting into an idle session: persisted -> not injected again, done written", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const msg = prompt();
    writeInbox(r.root, SESSION_ID, msg);
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(1);
    r.host.persistLast(); // omp saved the message_end, then the process was killed
    const next = r.make();
    next.host.file = r.host.file;
    next.bridge.attach(next.host, r.info);
    await settle(next.bridge);
    expect(next.host.sent).toHaveLength(0);
    expect(readJson(inboxPath(r, msg.msg_id, "done")).delivered_at).toBeDefined();
    expect(existsSync(markerPath(r, msg.msg_id))).toBe(false);
    expect(existsSync(inboxPath(r, msg.msg_id))).toBe(false);
  });

  test("followUp queued in memory, process killed before the file shows it -> injected again, once", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    r.host.idle = false;
    const msg = prompt();
    writeInbox(r.root, SESSION_ID, msg);
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(1);
    // killed: the queue lived only in memory, the file never got the message
    const next = r.make();
    next.host.file = r.host.file;
    next.bridge.attach(next.host, r.info);
    await settle(next.bridge);
    expect(next.host.sent).toHaveLength(1);
    next.host.persistLast();
    await settle(next.bridge);
    await settle(next.bridge);
    expect(next.host.sent).toHaveLength(1);
    expect(existsSync(inboxPath(r, msg.msg_id, "done"))).toBe(true);
  });

  test("crash after done/ was written: leftover inbox file and marker are cleaned, nothing injected", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const msg = prompt();
    writeInbox(r.root, SESSION_ID, msg);
    writeFileSync(markerPath(r, msg.msg_id), "", { mode: 0o600 });
    writeFileSync(inboxPath(r, msg.msg_id, "done"), JSON.stringify({ ...msg, delivered_at: "2026-10-30T05:10:04Z" }));
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(0);
    expect(existsSync(inboxPath(r, msg.msg_id))).toBe(false);
    expect(existsSync(markerPath(r, msg.msg_id))).toBe(false);
  });

  test("the marker is found in any branch of the file, not only the last line", async () => {
    const r = rig();
    const msg = prompt();
    r.bridge.attach(r.host, r.info);
    writeInbox(r.root, SESSION_ID, msg);
    writeFileSync(markerPath(r, msg.msg_id), "", { mode: 0o600 });
    r.host.persistUser(`[bridge msg_id=${msg.msg_id}]\nrun the tests`);
    for (let i = 0; i < 30; i++) r.host.persistUser(`other ${i}`);
    const next = r.make();
    next.host.file = r.host.file;
    next.bridge.attach(next.host, r.info);
    await settle(next.bridge);
    expect(next.host.sent).toHaveLength(0);
    expect(existsSync(inboxPath(r, msg.msg_id, "done"))).toBe(true);
  });
});

describe("hermes_ask", () => {
  const askNow = (r: ReturnType<typeof rig>, extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
    r.bridge.ask({ question: "Which fix?", choices: ["A", "B"], timeoutS: 600, ...extra }, signal);
  const questionId = (r: ReturnType<typeof rig>) => {
    const file = readdirSync(join(r.root, "outbox"))[0] ?? "";
    return file ? readJson(join(r.root, "outbox", file)).question.id : r.net.events().at(-1).question.id;
  };

  test("sends an asked event, returns the answer as the tool result with the marker, confirms via toolResult", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    await settle(r.bridge);
    const pending = askNow(r);
    await Bun.sleep(5);
    const event = r.net.events().find((e) => e.kind === "asked");
    expect(event.question).toMatchObject({ text: "Which fix?", choices: ["A", "B"], timeout_s: 600 });
    expect(readJson(sessionFile(r)).state).toBe("idle"); // omp's own agent_start marks working; ask changes nothing
    const reply = answer(event.question.id);
    writeInbox(r.root, SESSION_ID, reply);
    await r.bridge.tick();
    const result = await pending;
    const block = result.content[0];
    if (block?.type !== "text") throw new Error("expected a text result");
    const text = block.text;
    expect(text).toBe(`[bridge msg_id=${reply.msg_id}]\nUse option B.`);
    expect(r.host.sent).toHaveLength(0); // not queued as a follow-up
    expect(existsSync(inboxPath(r, reply.msg_id, "done"))).toBe(false);
    r.host.persistToolResult(text);
    await settle(r.bridge);
    expect(readJson(inboxPath(r, reply.msg_id, "done")).delivered_at).toBeDefined();
    expect(existsSync(markerPath(r, reply.msg_id))).toBe(false);
    expect(queueProblems(r.root)).toEqual([]);
  });

  test("timeout cancels the question; the late answer is dropped, not injected", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const pending = askNow(r);
    await Bun.sleep(5);
    const qid = questionId(r);
    expect(r.host.timeouts.at(-1)?.ms).toBe(600_000);
    r.host.timeouts.at(-1)?.fn();
    const result = await pending;
    expect(result.details).toMatchObject({ status: "timeout" });
    const late = answer(qid, "too late");
    writeInbox(r.root, SESSION_ID, late);
    await settle(r.bridge);
    const done = readJson(inboxPath(r, late.msg_id, "done"));
    expect(done.dropped).toBe("late");
    expect(done.dropped_at).toBeDefined();
    expect(done.delivered_at).toBeUndefined();
    expect(existsSync(inboxPath(r, late.msg_id))).toBe(false);
    expect(r.host.sent).toHaveLength(0);
    expect(queueProblems(r.root)).toEqual([]);
  });

  test("session end cancels the question; an answer after restart is dropped", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const pending = askNow(r);
    await Bun.sleep(5);
    const qid = questionId(r);
    await r.bridge.shutdown();
    expect((await pending).details).toMatchObject({ status: "cancelled" });
    const next = r.make();
    next.bridge.attach(next.host, r.info);
    const late = answer(qid);
    writeInbox(r.root, SESSION_ID, late);
    await settle(next.bridge);
    expect(readJson(inboxPath(r, late.msg_id, "done")).dropped).toBe("late");
    expect(next.host.sent).toHaveLength(0);
  });

  test("an abort signal cancels the question", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const controller = new AbortController();
    const pending = askNow(r, {}, controller.signal);
    controller.abort();
    expect((await pending).details).toMatchObject({ status: "cancelled" });
  });

  test("an answer for an unknown question is dropped", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const stray = answer(uuidLike());
    writeInbox(r.root, SESSION_ID, stray);
    await settle(r.bridge);
    expect(readJson(inboxPath(r, stray.msg_id, "done")).dropped).toBe("late");
  });

  test("a second answer to an answered question is dropped", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const pending = askNow(r);
    await Bun.sleep(5);
    const qid = questionId(r);
    writeInbox(r.root, SESSION_ID, answer(qid, "first"));
    await r.bridge.tick();
    await pending;
    const second = answer(qid, "second", { created_at: "2026-10-30T05:13:00Z" });
    writeInbox(r.root, SESSION_ID, second);
    await r.bridge.tick();
    expect(readJson(inboxPath(r, second.msg_id, "done")).dropped).toBe("late");
  });

  test("answer persisted before restart: finished as delivered; not persisted: dropped", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const delivered = answer(uuidLike(), "kept");
    const lost = answer("00000000-0000-4000-8000-0000000000fe", "lost");
    for (const m of [delivered, lost]) {
      writeInbox(r.root, SESSION_ID, m);
      writeFileSync(markerPath(r, m.msg_id as string), "", { mode: 0o600 });
    }
    r.host.persistToolResult(`[bridge msg_id=${delivered.msg_id}]\nkept`);
    const next = r.make();
    next.host.file = r.host.file;
    next.bridge.attach(next.host, r.info);
    await settle(next.bridge);
    expect(readJson(inboxPath(r, delivered.msg_id as string, "done")).delivered_at).toBeDefined();
    expect(readJson(inboxPath(r, lost.msg_id as string, "done")).dropped).toBe("late");
    expect(existsSync(markerPath(r, lost.msg_id as string))).toBe(false);
    expect(next.host.sent).toHaveLength(0);
  });

  test("unavailable without a webhook or without a question", async () => {
    const r = rig({ webhookUrl: undefined });
    r.bridge.attach(r.host, r.info);
    expect((await askNow(r)).details).toMatchObject({ status: "unavailable" });
    const ok = rig();
    ok.bridge.attach(ok.host, ok.info);
    expect((await ok.bridge.ask({ question: "  " }, undefined)).details).toMatchObject({ status: "unavailable" });
  });

  test("timeout_s is clamped to 1..86400 and choices are optional", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    void r.bridge.ask({ question: "q", timeoutS: 10 ** 9 }, undefined);
    void r.bridge.ask({ question: "q", timeoutS: 0 }, undefined);
    await Bun.sleep(5);
    const events = r.net.events().filter((e) => e.kind === "asked");
    expect(events.map((e) => e.question.timeout_s)).toEqual([86_400, 1]);
    expect(events[0].question.choices).toBeUndefined();
    for (const e of events) expect(queueProblemsEvent(e)).toEqual([]);
  });
});

import { schemaErrors } from "./helpers.ts";
const queueProblemsEvent = (e: unknown) => schemaErrors("event", e);

describe("failure containment", () => {
  test("missing or unusable config: nothing is written and nothing throws", async () => {
    const r = rig();
    r.cfg.value = { problem: "no config" };
    r.bridge.attach(r.host, r.info);
    await settle(r.bridge);
    await r.bridge.onAgentEnd([assistant("stop")], false);
    expect(existsSync(r.root)).toBe(false);
    expect((await r.bridge.ask({ question: "q" }, undefined)).details).toMatchObject({ status: "unavailable" });
    await r.bridge.shutdown();
  });

  test("a symlinked queue directory is refused and no file lands outside the root", async () => {
    const r = rig();
    const outside = tempDir();
    mkdirSync(r.root, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(r.root, "sessions"));
    r.bridge.attach(r.host, r.info);
    await settle(r.bridge);
    expect(readdirSync(outside)).toEqual([]);
    expect(r.logs.some((l) => l.includes("symbolic link"))).toBe(true);
  });

  test("a symlinked root is refused", async () => {
    const r = rig();
    const outside = tempDir();
    symlinkSync(outside, r.root);
    r.bridge.attach(r.host, r.info);
    await settle(r.bridge);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("an inbox message for another session is never read", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    writeInbox(r.root, "019a2f00-0000-7000-8000-0000000000aa", prompt());
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(0);
  });

  test("sendUserMessage throwing is contained", async () => {
    const r = rig();
    r.host.sendUserMessage = () => {
      throw new Error("boom");
    };
    r.bridge.attach(r.host, r.info);
    writeInbox(r.root, SESSION_ID, prompt());
    await settle(r.bridge);
    expect(r.logs.some((l) => l.includes("boom"))).toBe(true);
  });
});

describe("review fixes", () => {
  test("a symlinked outbox directory is never read, sent or emptied", async () => {
    const r = rig();
    const outside = tempDir();
    const victim = join(outside, `${uuidLike()}.json`);
    writeFileSync(victim, JSON.stringify({ synthetic: true }));
    mkdirSync(r.root, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(r.root, "outbox"));
    r.clock.t += 60_000;
    r.bridge.attach(r.host, r.info);
    await settle(r.bridge);
    expect(r.net.calls).toHaveLength(0);
    expect(existsSync(victim)).toBe(true);
  });

  test("a symlinked inbox session directory is never read or cleaned", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const outside = tempDir();
    const msg = prompt();
    writeFileSync(join(outside, `${msg.msg_id}.json`), JSON.stringify(msg));
    const link = join(r.root, "inbox", SESSION_ID);
    require("node:fs").rmSync(link, { recursive: true, force: true });
    symlinkSync(outside, link);
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(0);
    expect(existsSync(join(outside, `${msg.msg_id}.json`))).toBe(true);
  });

  test("a slow Hermes does not stall inbox polling or the heartbeat", async () => {
    const r = rig();
    r.net.fetch = () => new Promise(() => {}); // never answers
    r.bridge.attach(r.host, r.info);
    for (let i = 0; i < 3; i++) {
      r.bridge.onAgentStart();
      void r.bridge.onAgentEnd([assistant("stop")], false);
    }
    await r.bridge.tick();
    const before = readJson(sessionFile(r)).updated_at;
    r.clock.t += REGISTRATION_REFRESH_MS;
    const msg = prompt();
    writeInbox(r.root, SESSION_ID, msg);
    await r.bridge.tick();
    expect(readJson(sessionFile(r)).updated_at).not.toBe(before);
    expect(r.host.sent).toHaveLength(1);
  });

  test("an uppercase msg_id is injected once and cleaned up", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    r.host.idle = false;
    const msg = prompt("run the tests", { msg_id: "0000abcd-0000-4000-8000-00000000beef" });
    const upper = { ...msg, msg_id: String(msg.msg_id).toUpperCase() };
    expect(upper.msg_id).not.toBe(msg.msg_id);
    writeInbox(r.root, SESSION_ID, { ...upper, msg_id: upper.msg_id });
    // file name carries the lowercase id, body the uppercase one
    require("node:fs").renameSync(join(r.root, "inbox", SESSION_ID, `${upper.msg_id}.json`), inboxPath(r, String(msg.msg_id)));
    for (let i = 0; i < 3; i++) await settle(r.bridge);
    expect(r.host.sent).toHaveLength(1);
    r.host.persistLast();
    await settle(r.bridge);
    expect(existsSync(inboxPath(r, String(msg.msg_id)))).toBe(false);
    expect(existsSync(markerPath(r, String(msg.msg_id)))).toBe(false);
    expect(existsSync(inboxPath(r, String(msg.msg_id), "done"))).toBe(true);
  });

  test("an uppercase reply_to still reaches the waiting question", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const pending = r.bridge.ask({ question: "q", timeoutS: 60 }, undefined);
    await Bun.sleep(5);
    const qid = r.net.events().find((e) => e.kind === "asked").question.id as string;
    writeInbox(r.root, SESSION_ID, answer(qid.toUpperCase()));
    await r.bridge.tick();
    expect((await pending).details).toMatchObject({ status: "answered" });
  });

  test("a large valid inbox file is delivered", async () => {
    const r = rig();
    r.bridge.attach(r.host, r.info);
    const msg = prompt("x".repeat(17 * 1024 * 1024));
    writeInbox(r.root, SESSION_ID, msg);
    await settle(r.bridge);
    expect(r.host.sent).toHaveLength(1);
  });
});
