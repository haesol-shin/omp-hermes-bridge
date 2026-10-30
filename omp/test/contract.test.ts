import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInbox } from "../src/messages.ts";
import { signHeaders } from "../src/outbox.ts";
import { schemaErrors } from "./helpers.ts";

const EXAMPLES = join(import.meta.dir, "..", "..", "contract", "examples");
const example = (name: string) => readFileSync(join(EXAMPLES, name), "utf8");

describe("inbox parser agrees with the contract schema", () => {
  test("accepts both valid examples", () => {
    for (const name of ["inbox-prompt.json", "inbox-answer.json"]) {
      const value = JSON.parse(example(name));
      expect(schemaErrors("inbox-message", value)).toEqual([]);
      expect(parseInbox(example(name), value.msg_id)).toEqual(value);
    }
  });

  const base = JSON.parse(example("inbox-prompt.json"));
  const bad: [string, Record<string, unknown>][] = [
    ["answer without reply_to", { ...base, kind: "answer" }],
    ["prompt with reply_to", { ...base, reply_to: base.msg_id }],
    ["non-UTC time", { ...base, created_at: "2026-10-30T05:10:00+09:00" }],
    ["nonexistent date", { ...base, created_at: "2026-02-30T05:00:00Z" }],
    ["impossible time", { ...base, created_at: "2026-99-99T25:61:61Z" }],
    ["extra key", { ...base, delivered_at: "2026-10-30T05:10:00Z" }],
    ["empty text", { ...base, text: "" }],
    ["wrong version", { ...base, schema_version: 2 }],
    ["not a uuid4", { ...base, msg_id: "019a2f00-0000-7000-8000-000000000001" }],
  ];
  test.each(bad)("both reject: %s", (_name, value) => {
    expect(schemaErrors("inbox-message", value).length).toBeGreaterThan(0);
    expect(parseInbox(JSON.stringify(value), String(value.msg_id))).toBeUndefined();
  });

  const early: [string, string][] = [
    ["year 0099", "0099-01-01T05:00:00Z"],
    ["leap day in year 0000", "0000-02-29T05:00:00Z"],
    ["leap day in 2000", "2000-02-29T05:00:00Z"],
  ];
  test.each(early)("both accept: %s", (_name, created_at) => {
    const value = { ...base, created_at };
    expect(schemaErrors("inbox-message", value)).toEqual([]);
    expect(parseInbox(JSON.stringify(value), String(value.msg_id))).toEqual(value);
  });

  test("a leap day in a non-leap century is rejected", () => {
    const value = { ...base, created_at: "1900-02-29T05:00:00Z" };
    expect(parseInbox(JSON.stringify(value), String(value.msg_id))).toBeUndefined();
  });

  test("a file whose name and msg_id differ is rejected", () => {
    expect(parseInbox(example("inbox-prompt.json"), "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d")).toBeUndefined();
  });
});

describe("examples stay valid for the files this extension writes", () => {
  test("every contract example validates under its schema", () => {
    for (const name of readdirSync(EXAMPLES)) {
      const schema = name.startsWith("event-")
        ? "event"
        : name.startsWith("session")
          ? "session"
          : name.startsWith("done-")
            ? "done-message"
            : "inbox-message";
      expect(schemaErrors(schema, JSON.parse(example(name)))).toEqual([]);
    }
  });
});

describe("Generic V2 signature", () => {
  test("matches an independently computed HMAC-SHA256 of <timestamp>.<body>", () => {
    // Expected value computed outside this code base with Python's hmac module.
    const headers = signHeaders("s3cret", new TextEncoder().encode('{"a":1}'), "id-1", 1_790_000_000_500);
    expect(headers["X-Webhook-Timestamp"]).toBe("1790000000");
    expect(headers["X-Webhook-Signature-V2"]).toBe("b3e592eceaf8e8b6c5101a58c2678f5ff4e74c21bed3a56a3130ecc5c7f6ed82");
    expect(headers["X-Request-ID"]).toBe("id-1");
  });

  test("signs the exact bytes, including multi-byte text", () => {
    const body = new TextEncoder().encode('{"summary":"완료 ✓"}');
    const a = signHeaders("k", body, "i", 1_000_000);
    const b = signHeaders("k", new TextEncoder().encode('{"summary":"완료 ✓ "}'), "i", 1_000_000);
    expect(a["X-Webhook-Signature-V2"]).not.toBe(b["X-Webhook-Signature-V2"]);
  });
});
