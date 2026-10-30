import { UUID4 } from "./util.ts";

export interface InboxMessage {
  schema_version: 1;
  msg_id: string;
  kind: "prompt" | "answer";
  text: string;
  reply_to?: string;
  created_at: string;
}

const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const KEYS = new Set(["schema_version", "msg_id", "kind", "text", "reply_to", "created_at"]);

/** Hand-written mirror of contract/schema/inbox-message.schema.json; the tests check both agree. */
export function parseInbox(raw: string, fileMsgId: string): InboxMessage | undefined {
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((k) => !KEYS.has(k))) return undefined;
  if (value.schema_version !== 1) return undefined;
  if (typeof value.msg_id !== "string" || !UUID4.test(value.msg_id)) return undefined;
  if (value.msg_id.toLowerCase() !== fileMsgId.toLowerCase()) return undefined;
  if (value.kind !== "prompt" && value.kind !== "answer") return undefined;
  if (typeof value.text !== "string" || value.text === "") return undefined;
  if (typeof value.created_at !== "string" || !UTC_TIME.test(value.created_at)) return undefined;
  if (!isRealTime(value.created_at)) return undefined;
  if (value.kind === "answer") {
    if (typeof value.reply_to !== "string" || !UUID4.test(value.reply_to)) return undefined;
  } else if ("reply_to" in value) {
    return undefined;
  }
  // The file name is the identity everywhere (pending map, done/, marker); a case difference in the body must not split it.
  const message: InboxMessage = {
    schema_version: 1,
    msg_id: fileMsgId,
    kind: value.kind,
    text: value.text,
    created_at: value.created_at,
  };
  if (value.kind === "answer") message.reply_to = value.reply_to;
  return message;
}

/**
 * Calendar-exact check. `Date.parse` rolls 02-30 over to March, and
 * `Date.UTC` maps years 0-99 to 1900-1999, so the day count is checked here.
 */
function isRealTime(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (h > 23 || mi > 59 || s > 59) return false;
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[mo - 1];
}
