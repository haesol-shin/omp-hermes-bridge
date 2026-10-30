import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type MarkerKind = "prompt" | "answer";

const MARKER_PREFIX = "[bridge msg_id=";
const MARKER_BYTES = Buffer.from(MARKER_PREFIX);
const FIRST_LINE = /^\[bridge msg_id=([0-9a-f-]{36})\](?:\r?\n|$)/i;
const CHUNK = 8 * 1024 * 1024;

export const markerLine = (msgId: string): string => `[bridge msg_id=${msgId}]`;

/**
 * Finds delivery proof in omp's session file: an entry whose first text starts with the marker line.
 * Every line is searched (not only the current branch). A prompt is proven by a `message` entry with
 * role user or by a `custom_message` entry; an answer by a `toolResult` message. The marker must be
 * the first line of the first text, so quoting it later in other text or in the model's own output is not proof.
 * Only bytes appended since the last scan are read; a moved, replaced or shrunk file is read again from the start.
 */
export class MarkerScanner {
  #path: string | undefined;
  #ino = -1;
  #offset = 0;
  #seen = new Map<string, Set<MarkerKind>>();

  /** Returns false when no session file exists yet (nothing is delivered yet). */
  scan(path: string | undefined): boolean {
    if (!path) return false;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return false;
    }
    try {
      const st = fstatSync(fd);
      if (path !== this.#path || st.ino !== this.#ino || st.size < this.#offset) {
        this.#path = path;
        this.#ino = st.ino;
        this.#offset = 0;
      }
      this.#readFrom(fd, st.size);
      return true;
    } finally {
      closeSync(fd);
    }
  }

  #readFrom(fd: number, size: number): void {
    let pos = this.#offset;
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK);
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let start = 0;
      for (let nl = chunk.indexOf(10, start); nl >= 0; nl = chunk.indexOf(10, start)) {
        const line = chunk.subarray(start, nl);
        if (line.includes(MARKER_BYTES)) this.#inspect(line.toString("utf8"));
        start = nl + 1;
      }
      carry = chunk.subarray(start);
      this.#offset = pos - carry.length;
    }
  }

  #inspect(line: string): void {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    let content: unknown;
    let kind: MarkerKind | undefined;
    if (entry?.type === "message" && entry.message) {
      content = entry.message.content;
      if (entry.message.role === "user") kind = "prompt";
      else if (entry.message.role === "toolResult" && (entry.message.toolName ?? "hermes_ask") === "hermes_ask") {
        kind = "answer";
      }
    } else if (entry?.type === "custom_message") {
      content = entry.content;
      kind = "prompt";
    }
    if (!kind) return;
    const id = FIRST_LINE.exec(firstText(content) ?? "")?.[1]?.toLowerCase();
    if (!id) return;
    const kinds = this.#seen.get(id) ?? new Set<MarkerKind>();
    kinds.add(kind);
    this.#seen.set(id, kinds);
  }

  has(msgId: string, kind: MarkerKind): boolean {
    return this.#seen.get(msgId.toLowerCase())?.has(kind) === true;
  }
}

function firstText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") return block.text;
  }
  return undefined;
}
