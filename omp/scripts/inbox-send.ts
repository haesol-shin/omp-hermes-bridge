// Writes one Hermes-to-omp inbox message the way the Hermes side must: .tmp in the same directory, then rename.
//   bun scripts/inbox-send.ts --root R --session SID --kind prompt|answer --text T [--reply-to QUESTION_ID]
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    session: { type: "string" },
    kind: { type: "string", default: "prompt" },
    text: { type: "string" },
    "reply-to": { type: "string" },
  },
});
if (!values.root || !values.session || !values.text) {
  console.error("usage: inbox-send.ts --root R --session SID --kind prompt|answer --text T [--reply-to ID]");
  process.exit(2);
}
const msgId = randomUUID();
const message: Record<string, unknown> = {
  schema_version: 1,
  msg_id: msgId,
  kind: values.kind,
  text: values.text,
  ...(values["reply-to"] ? { reply_to: values["reply-to"] } : {}),
  created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
};
const dir = join(values.root, "inbox", values.session);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${msgId}.json`);
writeFileSync(`${file}.tmp`, JSON.stringify(message), { mode: 0o600 });
renameSync(`${file}.tmp`, file);
console.log(msgId);
