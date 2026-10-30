// Acceptance helper: logs which agent kind each session event reaches, to prove subagent sessions
// do run the extensions (and that omp-hermes-bridge stayed silent in them), and what `agent_end` carries
// (`willContinue`, and `stopReason` of the last assistant message).
import { appendFileSync } from "node:fs";

export default function (pi: any) {
  for (const event of ["session_start", "agent_start", "agent_end", "session_shutdown"]) {
    pi.on(event, (e: any, ctx: any) => {
      const last = (e?.messages ?? []).filter((m: any) => m?.role === "assistant").at(-1);
      appendFileSync(
        process.env.PROBE_LOG ?? "agent-kind-probe.jsonl",
        `${JSON.stringify({
          event,
          kind: ctx.agent?.kind,
          session: ctx.sessionManager.getSessionId(),
          ...(event === "agent_end" ? { willContinue: e.willContinue, stopReason: last?.stopReason, errorMessage: last?.errorMessage } : {}),
        })}\n`,
      );
    });
  }
}
