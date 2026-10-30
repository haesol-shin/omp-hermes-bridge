import { homedir } from "node:os";
import { join } from "node:path";
import { Bridge, type Host } from "./bridge.ts";
import { ConfigStore } from "./config.ts";
import type { ExtensionApiLike, ExtensionCtx, ToolResultLike } from "./types.ts";
import { errText } from "./util.ts";

function agentDirOf(pi: ExtensionApiLike): string {
  try {
    return pi.pi.getAgentDir();
  } catch {
    return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
  }
}

function hostFrom(pi: ExtensionApiLike, ctx: ExtensionCtx): Host {
  return {
    sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
    isIdle: () => ctx.isIdle(),
    hasPendingMessages: () => ctx.hasPendingMessages(),
    sessionFile: () => ctx.sessionManager.getSessionFile(),
    sessionName: () => ctx.sessionManager.getSessionName(),
    setInterval: (fn, ms) => ctx.setInterval(fn, ms),
    setTimeout: (fn, ms) => ctx.setTimeout(fn, ms),
    clearTimer: (timer) => ctx.clearTimer(timer),
  };
}

export default function ompHermesBridge(pi: ExtensionApiLike): void {
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

  const isSub = (ctx: ExtensionCtx) => ctx.agent?.kind === "sub";
  const attach = (ctx: ExtensionCtx) =>
    bridge.attach(hostFrom(pi, ctx), {
      id: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      awaitSends: ctx.mode === "print" || ctx.mode === "json",
    });

  // An unhandled throw out of an extension kills the session, so every handler is wrapped.
  const on = (event: string, run: (e: any, ctx: ExtensionCtx) => unknown) =>
    pi.on(event, async (e, ctx) => {
      try {
        if (isSub(ctx)) return;
        await run(e, ctx);
      } catch (error) {
        log(`${event}: ${errText(error)}`);
      }
    });

  on("session_start", (_e, ctx) => attach(ctx));
  on("session_switch", (_e, ctx) => attach(ctx));
  on("session_branch", (_e, ctx) => attach(ctx));
  on("agent_start", (_e, ctx) => {
    attach(ctx);
    bridge.onAgentStart();
  });
  on("agent_end", async (e, ctx) => {
    attach(ctx);
    await bridge.onAgentEnd(e.messages, e.willContinue);
  });
  on("session_shutdown", () => bridge.shutdown());

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
    async execute(
      _id: string,
      params: { question: string; choices?: string[]; timeout_s?: number },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionCtx,
    ): Promise<ToolResultLike> {
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
