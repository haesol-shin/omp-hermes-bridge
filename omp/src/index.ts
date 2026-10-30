import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEndEvent, AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Bridge, type Host } from "./bridge.ts";
import { ConfigStore } from "./config.ts";
import { errText } from "./util.ts";

function agentDirOf(pi: ExtensionAPI): string {
  try {
    return pi.pi.getAgentDir();
  } catch {
    return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
  }
}

function hostFrom(pi: ExtensionAPI, ctx: ExtensionContext): Host {
  return {
    sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
    isIdle: () => ctx.isIdle(),
    hasPendingMessages: () => ctx.hasPendingMessages(),
    sessionFile: () => ctx.sessionManager.getSessionFile(),
    sessionName: () => ctx.sessionManager.getSessionName(),
    setInterval: (fn, ms) => ctx.setInterval(fn, ms),
    setTimeout: (fn, ms) => ctx.setTimeout(fn, ms),
    // The bridge treats timers as opaque and only passes back what setInterval/setTimeout returned.
    clearTimer: (timer) => ctx.clearTimer(timer as Parameters<ExtensionContext["clearTimer"]>[0]),
  };
}

export default function ompHermesBridge(pi: ExtensionAPI): void {
  const log = (message: string) => {
    try {
      pi.logger.warn(`omp-hermes-bridge: ${message}`);
    } catch {
      // Logging must never be the thing that throws.
    }
  };
  const bridge = new Bridge({
    config: new ConfigStore(agentDirOf(pi)),
    fetch: globalThis.fetch as never,
    log,
  });

  const isSub = (ctx: ExtensionContext) => ctx.agent?.kind === "sub";
  const attach = (ctx: ExtensionContext) =>
    bridge.attach(hostFrom(pi, ctx), {
      id: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      awaitSends: ctx.mode === "print" || ctx.mode === "json",
    });

  // An unhandled throw out of an extension kills the session, so every handler is wrapped.
  const guard =
    <E>(event: string, run: (e: E, ctx: ExtensionContext) => unknown) =>
    async (e: E, ctx: ExtensionContext): Promise<void> => {
      try {
        if (isSub(ctx)) return;
        await run(e, ctx);
      } catch (error) {
        log(`${event}: ${errText(error)}`);
      }
    };

  pi.on("session_start", guard("session_start", (_e, ctx) => attach(ctx)));
  pi.on("session_switch", guard("session_switch", (_e, ctx) => attach(ctx)));
  pi.on("session_branch", guard("session_branch", (_e, ctx) => attach(ctx)));
  pi.on(
    "agent_start",
    guard("agent_start", (_e, ctx) => {
      attach(ctx);
      bridge.onAgentStart();
    }),
  );
  pi.on(
    "agent_end",
    guard("agent_end", async (e: AgentEndEvent, ctx) => {
      attach(ctx);
      await bridge.onAgentEnd(e.messages, e.willContinue);
    }),
  );
  pi.on("session_shutdown", guard("session_shutdown", () => bridge.shutdown()));

  const z = pi.zod;
  pi.registerTool({
    name: "hermes_ask",
    label: "Ask via Hermes",
    description:
      "Send a question to the user through Hermes (their chat assistant) and wait for the answer. " +
      "Use it only when you need a human decision to continue and cannot proceed safely without it. " +
      "The answer comes back as this tool's result. If no answer arrives before timeout_s, the result says so.",
    parameters: z.object({
      question: z.string().describe("The question, self-contained: the reader may not have this session open."),
      choices: z.array(z.string()).optional().describe("Optional answer options to show."),
      timeout_s: z.number().optional().describe("Seconds to wait for the answer (default 1800, at most 86400)."),
    }),
    approval: "read",
    loadMode: "essential",
    async execute(_id, params: { question: string; choices?: string[]; timeout_s?: number }, signal, _onUpdate, ctx): Promise<AgentToolResult> {
      try {
        if (isSub(ctx)) {
          return { content: [{ type: "text", text: "hermes_ask is only available to the main session." }], isError: true };
        }
        attach(ctx);
        return await bridge.ask(
          { question: params.question, choices: params.choices, timeoutS: params.timeout_s },
          signal,
        );
      } catch (error) {
        log(`hermes_ask: ${errText(error)}`);
        return { content: [{ type: "text", text: "hermes_ask failed; continue without an answer." }], isError: true };
      }
    },
  });
}
