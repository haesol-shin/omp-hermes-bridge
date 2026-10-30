import { createHmac } from "node:crypto";
import type { BridgeConfig } from "./config.ts";
import type { Queue } from "./queue.ts";
import { JSON_FILE } from "./queue.ts";
import { errText } from "./util.ts";

export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: Uint8Array; signal: AbortSignal; redirect: "error" },
) => Promise<{ status: number }>;

export interface EventBody {
  schema_version: 1;
  event_id: string;
  kind: "ended" | "failed" | "asked" | "blocked";
  host_id: string;
  session_id: string;
  cwd: string;
  at: string;
  summary?: string;
  question?: { id: string; text: string; choices?: string[]; timeout_s: number };
  reason?: string;
}

/** Generic V2 headers for one attempt: a fresh timestamp and signature each time, same body. */
export function signHeaders(secret: string, body: Uint8Array, eventId: string, nowMs: number): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature-V2": signature,
    "X-Request-ID": eventId,
  };
}

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 15 * 60_000;
/** Another process may be sending its own fresh event; leave files younger than this alone. */
const FOREIGN_GRACE_MS = 30_000;
const SEND_TIMEOUT_MS = 10_000;
/** Requests per pass, so one pass stays short even with a long backlog. */
const MAX_PER_FLUSH = 8;

export const retryDelayMs = (attempts: number): number => Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);

/**
 * Durable event delivery. Every event is written to outbox/<event_id>.json first and removed only
 * after Hermes answers 2xx, so a crash or an unreachable Hermes loses nothing. Retries re-send the
 * file's bytes unchanged with new timestamp and signature.
 */
export class Outbox {
  #retry = new Map<string, { attempts: number; next: number }>();
  #inflight = new Set<string>();

  constructor(
    private readonly queue: Queue,
    private readonly getConfig: () => BridgeConfig | undefined,
    private readonly doFetch: FetchLike,
    private readonly now: () => number = Date.now,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** False when the webhook is not configured; the event is then dropped, not queued without a consumer. */
  canSend(): boolean {
    const cfg = this.getConfig();
    return Boolean(cfg?.webhookUrl && cfg.webhookSecret);
  }

  async enqueue(event: EventBody, timeoutMs = SEND_TIMEOUT_MS): Promise<boolean> {
    if (!this.canSend()) return false;
    this.queue.writeAtomic(this.queue.outboxFile(event.event_id), JSON.stringify(event));
    await this.#send(event.event_id, timeoutMs);
    return true;
  }

  /** Sends every due file. `force` ignores retry delays and the foreign-file grace (used at shutdown). */
  async flush(timeoutMs = SEND_TIMEOUT_MS, force = false): Promise<void> {
    if (!this.canSend()) return;
    const now = this.now();
    let sent = 0;
    for (const name of this.queue.listFiles(this.queue.outboxDir(), JSON_FILE)) {
      const id = name.slice(0, -".json".length);
      const state = this.#retry.get(id);
      if (!force) {
        if (state && state.next > now) continue;
        const mtime = this.queue.mtimeMs(this.queue.outboxFile(id));
        if (!state && mtime !== undefined && now - mtime < FOREIGN_GRACE_MS && !this.#inflight.has(id)) continue;
      }
      if (force && this.now() - now > timeoutMs) break; // total budget at shutdown
      if (!force && sent >= MAX_PER_FLUSH) break;
      sent += 1;
      await this.#send(id, timeoutMs);
    }
  }

  pending(): number {
    return this.queue.listFiles(this.queue.outboxDir(), JSON_FILE).length;
  }

  async #send(id: string, timeoutMs: number): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg?.webhookUrl || !cfg.webhookSecret || this.#inflight.has(id)) return;
    const path = this.queue.outboxFile(id);
    const raw = this.queue.readText(path);
    if (raw === undefined) {
      this.#retry.delete(id);
      return;
    }
    const body = new TextEncoder().encode(raw);
    this.#inflight.add(id);
    try {
      const response = await this.doFetch(cfg.webhookUrl, {
        method: "POST",
        headers: signHeaders(cfg.webhookSecret, body, id, this.now()),
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (response.status >= 200 && response.status < 300) {
        this.queue.remove(path);
        this.#retry.delete(id);
        return;
      }
      this.#failed(id, `HTTP ${response.status}`);
    } catch (error) {
      this.#failed(id, errText(error));
    } finally {
      this.#inflight.delete(id);
    }
  }

  #failed(id: string, why: string): void {
    const attempts = (this.#retry.get(id)?.attempts ?? 0) + 1;
    this.#retry.set(id, { attempts, next: this.now() + retryDelayMs(attempts) });
    this.log(`event ${id} not accepted (${why}); attempt ${attempts}`);
  }
}
