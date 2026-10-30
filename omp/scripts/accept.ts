// Real-environment acceptance runs for the omp extension. Prints one JSON line per scenario.
//   ACCEPT_MODEL=<cheap provider/model> ACCEPT_DIR=<scratch dir> PI_CODING_AGENT_DIR=<throwaway agent dir> \
//     bun scripts/accept.ts [scenario ...]
import { spawn } from "bun";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertAgentDir,
  countMarker,
  EXT,
  Env,
  MODEL,
  OMP,
  Rpc,
  report,
  requireEnv,
  type Result,
  SCRIPTS,
  sleep,
  until,
  watchStates,
} from "./accept-lib.ts";

requireEnv();
const PROBE = join(SCRIPTS, "agent-kind-probe.ts");
const lastAssistantText = (file: string): string => {
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const a = entries.filter((e) => e.type === "message" && e.message.role === "assistant").at(-1);
  return (a?.message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
};
const entriesOf = (file: string): any[] => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
/** Starts an rpc run with the probe extension loaded; `probeLines()` returns what the probe saw. */
function withProbe(e: Env, model = MODEL): { rpc: Rpc; probeLines: () => any[] } {
  const log = join(e.dir, "probe.jsonl");
  writeFileSync(log, "");
  process.env.PROBE_LOG = log;
  const rpc = new Rpc(e, ["-e", PROBE], model);
  return { rpc, probeLines: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}
const done = (e: Env, sid: string) => e.inbox(sid, "done");
const readDone = (e: Env, sid: string, msgId: string) => JSON.parse(readFileSync(join(e.root, "inbox", sid, "done", `${msgId}.json`), "utf8"));

async function warmUp(e: Env, rpc: Rpc): Promise<{ sid: string; file: string }> {
  await rpc.ready();
  const { sessionId: sid } = await rpc.state();
  await until("registration", () => e.registration(sid));
  await rpc.call({ type: "prompt", message: "Reply with exactly: warm" });
  await until("first turn", () => rpc.count("agent_end") >= 1, 90_000);
  const file = (await rpc.state()).sessionFile as string;
  assertAgentDir(file);
  return { sid, file };
}

const scenarios: Record<string, () => Promise<Omit<Result, "scenario">>> = {
  async "modes-print"() {
    const e = new Env("modes-print");
    e.startListener();
    await sleep(300);
    const p = spawn([OMP, "-p", "-e", EXT, "--model", MODEL, "Reply with exactly: ok"], { env: e.env(), cwd: e.dir, stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    await sleep(500);
    const reg = JSON.parse(readFileSync(e.sessionFiles()[0], "utf8"));
    const events = e.accepted();
    e.cleanup();
    return {
      result: reg.state === "ended" && events.length === 1 && events[0].kind === "ended" && e.outbox().length === 0 ? "pass" : "fail",
      observed: { stdout: out.split("\n").at(-1), registration_state: reg.state, events: events.map((x) => [x.kind, x.summary]), outbox: e.outbox().length },
    };
  },

  async "modes-rpc"() {
    const e = new Env("modes-rpc");
    e.startListener();
    await sleep(300);
    const rpc = new Rpc(e);
    await rpc.ready();
    const { sessionId: sid } = await rpc.state();
    await until("registration", () => e.registration(sid));
    const watch = watchStates(e, sid);
    await rpc.call({ type: "prompt", message: "Reply with exactly: ok" });
    await until("agent_end", () => rpc.count("agent_end") >= 1, 90_000);
    await until("event", () => e.accepted().length >= 1, 15_000);
    const exit = await rpc.close();
    await sleep(300);
    const states = watch.stop();
    const events = e.accepted();
    const final = e.registration(sid)?.state;
    e.cleanup();
    return {
      result: events.length === 1 && events[0].kind === "ended" && final === "ended" && states.join() === "idle,working,idle,ended" ? "pass" : "fail",
      observed: { states, events: events.map((x) => [x.kind, x.summary]), final_state: final, exit },
    };
  },

  async "modes-tui"() {
    const e = new Env("modes-tui");
    e.startListener();
    await sleep(300);
    const shell = `(sleep 12; printf 'Reply with exactly: ok\\r'; sleep 30; printf '\\003'; sleep 1; printf '\\003'; sleep 2) | script -qfc "${OMP} -e ${EXT} --model ${MODEL}" /dev/null > tui.out 2>&1`;
    const p = spawn(["bash", "-c", shell], { env: e.env(), cwd: e.dir });
    await until("tui session registration", () => e.sessionFiles()[0], 60_000);
    const sid = JSON.parse(readFileSync(e.sessionFiles()[0], "utf8")).session_id;
    const watch = watchStates(e, sid);
    await until("ended event", () => e.accepted().length >= 1, 90_000);
    await p.exited;
    await sleep(500);
    const states = watch.stop();
    const events = e.accepted();
    const final = e.registration(sid)?.state;
    e.cleanup();
    return {
      result: events.length === 1 && events[0].kind === "ended" && final === "ended" && states.join() === "idle,working,idle,ended" ? "pass" : "fail",
      observed: { states, events: events.map((x) => [x.kind, x.summary]), final_state: final, tty: existsSync(join(e.dir, "tui.out")) },
    };
  },

  async "inbox-idle"() {
    const e = new Env("inbox-idle");
    e.startListener();
    const rpc = new Rpc(e);
    const { sid, file } = await warmUp(e, rpc);
    const before = rpc.count("agent_start");
    const id = await e.send(sid, "prompt", "Reply with exactly: inbox-idle-ok");
    await until("done", () => done(e, sid).includes(`${id}.json`), 90_000);
    await until("turn end", () => rpc.count("agent_end") >= 2, 90_000);
    const entry = entriesOf(file).find((x) => x.type === "message" && JSON.stringify(x.message.content).includes(`[bridge msg_id=${id}]`));
    const out = lastAssistantText(file);
    const record = readDone(e, sid, id);
    await rpc.close();
    e.cleanup();
    return {
      result:
        rpc.count("agent_start") === before + 1 && countMarker(file, id) === 1 && entry?.message.role === "user" && entry.message.attribution === "agent" &&
        record.delivered_at && e.inbox(sid, "delivering").length === 0 && !e.inbox(sid).some((n) => n.endsWith(".json")) && out.includes("inbox-idle-ok")
          ? "pass"
          : "fail",
      observed: { new_turns: rpc.count("agent_start") - before, marker_entries: countMarker(file, id), role: entry?.message.role, attribution: entry?.message.attribution, reply: out, delivered_at: record.delivered_at },
    };
  },

  async "inbox-working"() {
    const e = new Env("inbox-working");
    e.startListener();
    const rpc = new Rpc(e);
    const { sid, file } = await warmUp(e, rpc);
    const starts = rpc.count("agent_start");
    await rpc.call({ type: "prompt", message: "Use the bash tool to run `sleep 15`, then reply with exactly: first-done" });
    await until("tool start", () => rpc.frames.find((f) => f.type === "tool_execution_start"), 60_000);
    const workingState = e.registration(sid)?.state;
    const id = await e.send(sid, "prompt", "After you finish, reply with exactly: second-done");
    await until("done", () => done(e, sid).includes(`${id}.json`), 120_000);
    await until("turn end", () => rpc.count("agent_end") >= 2, 120_000);
    const entries = entriesOf(file);
    const markerAt = entries.findIndex((x) => x.type === "message" && JSON.stringify(x.message.content).includes(`[bridge msg_id=${id}]`));
    const toolResultAt = entries.findIndex((x) => x.type === "message" && x.message.role === "toolResult");
    const out = lastAssistantText(file);
    await rpc.close();
    e.cleanup();
    return {
      result: workingState === "working" && countMarker(file, id) === 1 && markerAt > toolResultAt && toolResultAt >= 0 && out.includes("second-done") ? "pass" : "fail",
      observed: { state_when_injected: workingState, agent_starts: rpc.count("agent_start") - starts, marker_entries: countMarker(file, id), marker_after_tool_result: markerAt > toolResultAt, reply: out },
    };
  },

  async "ask-answered"() {
    const e = new Env("ask-answered");
    e.startListener();
    const rpc = new Rpc(e);
    const { sid, file } = await warmUp(e, rpc);
    const watch = watchStates(e, sid);
    await rpc.call({ type: "prompt", message: 'Call the hermes_ask tool exactly once with question "Which fix: A or B?", choices ["A","B"], timeout_s 120. Then reply with exactly: ANSWER=<the answer text you received>' });
    const asked = await until("asked event", () => e.accepted().find((x) => x.kind === "asked"), 90_000);
    await sleep(1500);
    const stateWhileWaiting = e.registration(sid)?.state;
    const id = await e.send(sid, "answer", "Use option B.", asked.question.id);
    await until("done", () => done(e, sid).includes(`${id}.json`), 90_000);
    await until("turn end", () => rpc.count("agent_end") >= 2, 90_000);
    await sleep(500);
    const states = watch.stop();
    const entries = entriesOf(file);
    const tr = entries.find((x) => x.type === "message" && x.message.role === "toolResult" && JSON.stringify(x.message.content).includes(`[bridge msg_id=${id}]`));
    const out = lastAssistantText(file);
    const record = readDone(e, sid, id);
    await rpc.close();
    e.cleanup();
    return {
      result: stateWhileWaiting === "working" && tr && tr.message.toolName === "hermes_ask" && record.delivered_at && out.includes("option B") && states.join() === "idle,working,idle" ? "pass" : "fail",
      observed: { asked: asked.question, state_while_waiting: stateWhileWaiting, states_after_wait_started: states, tool_result: tr?.message.content[0].text, reply: out, done: { delivered_at: record.delivered_at } },
    };
  },

  async "ask-timeout"() {
    const e = new Env("ask-timeout");
    e.startListener();
    const rpc = new Rpc(e);
    const { sid, file } = await warmUp(e, rpc);
    await rpc.call({ type: "prompt", message: 'Call the hermes_ask tool exactly once with question "Proceed?" and timeout_s 5. Then reply with exactly: RESULT=<first six words of the tool result>' });
    const asked = await until("asked event", () => e.accepted().find((x) => x.kind === "asked"), 90_000);
    await until("turn end", () => rpc.count("agent_end") >= 2, 90_000);
    const tool = entriesOf(file).find((x) => x.type === "message" && x.message.role === "toolResult" && x.message.toolName === "hermes_ask");
    const toolText = tool?.message.content[0].text as string;
    const late = await e.send(sid, "answer", "Too late.", asked.question.id);
    await until("late done", () => done(e, sid).includes(`${late}.json`), 30_000);
    const record = readDone(e, sid, late);
    const injected = countMarker(file, late);
    await rpc.close();
    e.cleanup();
    return {
      result: toolText.startsWith("No answer from Hermes within 5 seconds") && record.dropped === "late" && record.dropped_at && !record.delivered_at && injected === 0 ? "pass" : "fail",
      observed: { timeout_s: asked.question.timeout_s, tool_result: toolText, late_done: record, late_answer_entries_in_session: injected, inbox_left: e.inbox(sid).filter((n) => n.endsWith(".json")) },
    };
  },

  async "ask-session-ended"() {
    const e = new Env("ask-session-ended");
    e.startListener();
    const rpc = new Rpc(e);
    const { sid, file } = await warmUp(e, rpc);
    await rpc.call({ type: "prompt", message: 'Call the hermes_ask tool exactly once with question "Proceed?" and timeout_s 600.' });
    const asked = await until("asked event", () => e.accepted().find((x) => x.kind === "asked"), 90_000);
    await rpc.close(); // session ends while the question waits
    await sleep(500);
    const endedState = e.registration(sid)?.state;
    const late = await e.send(sid, "answer", "Answer after the session ended.", asked.question.id);
    const next = new Rpc(e, ["--resume", file]);
    await next.ready();
    await until("late done", () => done(e, sid).includes(`${late}.json`), 30_000);
    const record = readDone(e, sid, late);
    const injected = countMarker(file, late);
    await next.close();
    e.cleanup();
    return {
      result: endedState === "ended" && record.dropped === "late" && injected === 0 && next.count("agent_start") === 0 ? "pass" : "fail",
      observed: { state_after_close: endedState, late_done: record, late_answer_entries_in_session: injected, turns_started_after_resume: next.count("agent_start") },
    };
  },

  async outbox() {
    const e = new Env("outbox");
    const rpc = new Rpc(e); // no listener yet
    const { sid } = await warmUp(e, rpc);
    await until("first attempt failed", () => e.outbox().length >= 1, 30_000);
    const queuedWhileDown = e.outbox().length;
    await rpc.call({ type: "prompt", message: "Reply with exactly: still-working" });
    await until("second turn", () => rpc.count("agent_end") >= 2, 90_000);
    const alive = e.registration(sid)?.state;
    const queuedAfterTwoTurns = e.outbox().length;
    const t0 = Date.now();
    e.startListener();
    await until("outbox drained", () => e.outbox().length === 0 && e.accepted().length >= 2, 120_000);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const events = e.accepted();
    await rpc.close();
    e.cleanup();
    return {
      result: queuedWhileDown >= 1 && queuedAfterTwoTurns === 2 && alive === "idle" && events.length === 2 && events.every((x) => x.kind === "ended") ? "pass" : "fail",
      observed: { queued_while_hermes_down: queuedWhileDown, queued_after_two_turns: queuedAfterTwoTurns, session_state_meanwhile: alive, drained_after_listener_start_s: seconds, delivered: events.map((x) => [x.kind, x.summary]), signature_rejections: e.lines().filter((l) => l.result === "rejected").length },
    };
  },

  async "kill-1-before-inject"() {
    const e = new Env("kill-1");
    e.startListener();
    const rpc = new Rpc(e);
    const { sid, file } = await warmUp(e, rpc);
    rpc.kill9();
    await rpc.proc.exited;
    // State a kill leaves right after the marker is created and before sendUserMessage runs.
    const id = await e.send(sid, "prompt", "Reply with exactly: kill1-ok");
    mkMarker(e, sid, id);
    const next = new Rpc(e, ["--resume", file]);
    await next.ready();
    await until("done", () => done(e, sid).includes(`${id}.json`), 90_000);
    const n = countMarker(file, id);
    await next.close();
    e.cleanup();
    return { result: n === 1 ? "pass" : "fail", observed: { marker_entries_in_session: n, note: "state constructed: marker present, no session entry; a real kill cannot be aimed at this microsecond window" } };
  },

  async "kill-2-after-idle-inject"() {
    const e = new Env("kill-2");
    e.startListener();
    const rpc = new Rpc(e);
    const { sid, file } = await warmUp(e, rpc);
    const id = await e.send(sid, "prompt", "Reply with exactly: kill2-ok");
    await until("message persisted", () => countMarker(file, id) >= 1, 60_000, 5);
    rpc.kill9();
    await rpc.proc.exited;
    const doneAtKill = done(e, sid).includes(`${id}.json`);
    const markerAtKill = e.inbox(sid, "delivering").includes(id);
    const inboxAtKill = e.inbox(sid).includes(`${id}.json`);
    const next = new Rpc(e, ["--resume", file]);
    await next.ready();
    await until("done", () => done(e, sid).includes(`${id}.json`), 90_000);
    await sleep(2500);
    const n = countMarker(file, id);
    const turns = next.count("agent_start");
    await next.close();
    e.cleanup();
    return {
      result: !doneAtKill && markerAtKill && inboxAtKill && n === 1 && turns === 0 ? "pass" : "fail",
      observed: { at_kill: { done: doneAtKill, marker: markerAtKill, inbox_file: inboxAtKill }, marker_entries_after_restart: n, turns_started_by_restart: turns },
    };
  },

  async "kill-3-followup-not-persisted"() {
    const e = new Env("kill-3");
    e.startListener();
    const rpc = new Rpc(e);
    const { sid, file } = await warmUp(e, rpc);
    await rpc.call({ type: "prompt", message: "Use the bash tool to run `sleep 40`, then reply with exactly: slow-done" });
    await until("tool start", () => rpc.frames.find((f) => f.type === "tool_execution_start"), 60_000);
    const id = await e.send(sid, "prompt", "Reply with exactly: kill3-ok");
    await until("marker created", () => e.inbox(sid, "delivering").includes(id), 30_000, 5);
    await sleep(300);
    const inFileAtKill = countMarker(file, id);
    rpc.kill9();
    await rpc.proc.exited;
    const next = new Rpc(e, ["--resume", file]);
    await next.ready();
    await until("done", () => done(e, sid).includes(`${id}.json`), 120_000);
    await sleep(2500);
    const n = countMarker(file, id);
    const startedTurn = next.count("agent_start");
    await next.close(5_000);
    e.cleanup();
    return {
      result: inFileAtKill === 0 && n === 1 && startedTurn >= 1 ? "pass" : "fail",
      observed: { entries_at_kill: inFileAtKill, entries_after_restart: n, turns_started_by_restart: startedTurn },
    };
  },

  async "session-switch"() {
    const e = new Env("session-switch");
    e.startListener();
    const rpc = new Rpc(e);
    const first = await warmUp(e, rpc);
    await rpc.call({ type: "new_session" });
    const second = (await rpc.state()).sessionId;
    await until("new registration", () => e.registration(second));
    await sleep(500);
    const oldState = e.registration(first.sid)?.state;
    const newState = e.registration(second)?.state;
    const id = await e.send(second, "prompt", "Reply with exactly: switched-ok");
    await until("done in new session", () => done(e, second).includes(`${id}.json`), 90_000);
    const file = (await rpc.state()).sessionFile as string;
    const n = countMarker(file, id);
    await rpc.close();
    e.cleanup();
    return {
      result: first.sid !== second && oldState === "ended" && newState !== "ended" && n === 1 ? "pass" : "fail",
      observed: { old_session_state: oldState, new_session_state: newState, inbox_prompt_delivered_in_new_session: n === 1 },
    };
  },

  async "state-failure"() {
    const e = new Env("state-failure");
    e.startListener();
    const { rpc, probeLines } = withProbe(e, "deadprov/dead-model");
    await rpc.ready();
    const { sessionId: sid } = await rpc.state();
    await until("registration", () => e.registration(sid));
    const watch = watchStates(e, sid);
    await rpc.call({ type: "prompt", message: "hi" });
    await until("failed event", () => e.accepted().find((x) => x.kind === "failed"), 120_000);
    await sleep(500);
    const states = watch.stop();
    const events = e.accepted();
    const ends = rpc.frames.filter((f) => f.type === "agent_end").map((f) => ({ isTerminal: f.isTerminal, willContinue: f.willContinue }));
    await rpc.close();
    e.cleanup();
    return {
      result: events.length === 1 && events[0].kind === "failed" && states.join() === "idle,working,idle" ? "pass" : "fail",
      observed: { states, events: events.map((x) => [x.kind, x.summary]), agent_end_frames: ends, extension_agent_end: probeLines().filter((p) => p.event === "agent_end") },
    };
  },

  async "state-abort-streaming"() {
    const e = new Env("state-abort-stream");
    e.startListener();
    const { rpc, probeLines } = withProbe(e);
    await rpc.ready();
    const { sessionId: sid } = await rpc.state();
    await until("registration", () => e.registration(sid));
    const watch = watchStates(e, sid);
    await rpc.call({ type: "prompt", message: "Write a 600 word essay about oak trees." });
    await until("streaming", () => rpc.count("message_update") >= 3, 60_000);
    await rpc.call({ type: "abort" });
    await until("event", () => e.accepted().length >= 1, 30_000);
    await sleep(500);
    const states = watch.stop();
    const events = e.accepted();
    await rpc.close();
    e.cleanup();
    return {
      result: events.length === 1 && events[0].kind === "failed" && states.join() === "idle,working,idle" ? "pass" : "fail",
      observed: { states, events: events.map((x) => [x.kind, x.summary]), extension_agent_end: probeLines().filter((p) => p.event === "agent_end") },
    };
  },

  async "state-abort-tool"() {
    const e = new Env("state-abort-tool");
    e.startListener();
    const { rpc, probeLines } = withProbe(e);
    await rpc.ready();
    const { sessionId: sid } = await rpc.state();
    await until("registration", () => e.registration(sid));
    const watch = watchStates(e, sid);
    await rpc.call({ type: "prompt", message: "Use the bash tool to run `sleep 60`." });
    await until("tool start", () => rpc.frames.find((f) => f.type === "tool_execution_start"), 60_000);
    await rpc.call({ type: "abort" });
    await until("event", () => e.accepted().length >= 1, 60_000);
    await sleep(500);
    const states = watch.stop();
    const events = e.accepted();
    const ends = rpc.frames.filter((f) => f.type === "agent_end").map((f) => ({ isTerminal: f.isTerminal }));
    await rpc.close();
    e.cleanup();
    return {
      result: events.length === 1 && events[0].kind === "failed" ? "pass" : "fail",
      observed: { states, events: events.map((x) => [x.kind, x.summary]), agent_end_frames: ends, extension_agent_end: probeLines().filter((p) => p.event === "agent_end") },
    };
  },

  async "subagent-silent"() {
    const e = new Env("subagent");
    e.startListener();
    const { rpc, probeLines } = withProbe(e);
    const { sid, file } = await warmUp(e, rpc);
    await rpc.call({ type: "prompt", message: "Use the task tool exactly once to spawn one subagent whose assignment is: reply with exactly sub-ok. After it returns, reply with exactly: parent-done" });
    await until("parent turn end", () => rpc.count("agent_end") >= 2, 180_000);
    await sleep(1500);
    const probe = probeLines();
    const sub = probe.filter((p) => p.kind === "sub");
    const events = e.accepted();
    const usedTask = entriesOf(file).some((x) => x.type === "message" && x.message.role === "assistant" && JSON.stringify(x.message.content).includes('"name":"task"'));
    const regs = e.sessionFiles().length;
    await rpc.close();
    delete process.env.PROBE_LOG;
    e.cleanup();
    return {
      result: usedTask && sub.length > 0 && regs === 1 && events.every((x) => x.session_id === sid) ? "pass" : "fail",
      observed: { task_tool_used: usedTask, subagent_events_seen_by_probe: sub.map((s) => s.event), registrations: regs, events_sent: events.map((x) => [x.kind, x.session_id === sid ? "main" : "OTHER"]) },
    };
  },
};

function mkMarker(e: Env, sid: string, id: string): void {
  writeFileSync(join(e.root, "inbox", sid, "delivering", id), "", { mode: 0o600 });
}

const wanted = process.argv.slice(2);
for (const [name, run] of Object.entries(scenarios)) {
  if (wanted.length && !wanted.includes(name)) continue;
  try {
    report({ scenario: name, ...(await run()) });
  } catch (error) {
    report({ scenario: name, result: "fail", observed: { error: String(error) } });
  }
}
appendFileSync(join(process.env.ACCEPT_DIR ?? ".", "accept.done"), "");
