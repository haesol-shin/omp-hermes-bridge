// The slice of the public omp extension API this extension uses. Declared here
// so the extension has no runtime or type dependency on omp internals.

export type Timer = unknown;

export interface SessionManagerView {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionName(): string | undefined;
}

export interface ExtensionCtx {
  mode: "tui" | "rpc" | "json" | "print";
  cwd: string;
  agent?: { kind: "main" | "sub" };
  sessionManager: SessionManagerView;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  setInterval(fn: () => void, ms: number): Timer;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimer(timer: Timer): void;
}

export interface AgentEndEventLike {
  messages?: unknown[];
  willContinue?: boolean;
}

export interface ToolResultLike {
  content: { type: "text"; text: string }[];
  details?: unknown;
  isError?: boolean;
}

export interface ExtensionApiLike {
  on(event: string, handler: (event: any, ctx: ExtensionCtx) => unknown): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; attribution?: "user" | "agent" },
  ): void;
  registerTool(tool: Record<string, unknown>): void;
  zod: any;
  logger: { warn(msg: string, data?: unknown): void; debug(msg: string, data?: unknown): void };
  pi: { getAgentDir(): string };
}
