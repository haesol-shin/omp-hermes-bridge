import { describe, expect, test } from "bun:test";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MarkerScanner } from "../src/scanner.ts";
import { tempDir } from "./helpers.ts";

const ID = "3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f";
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const user = (content: unknown) => line({ type: "message", message: { role: "user", content } });

describe("MarkerScanner", () => {
  test("proves a prompt from a user message or a custom_message, text array or string", () => {
    const dir = tempDir();
    const file = join(dir, "s.jsonl");
    writeFileSync(file, user([{ type: "text", text: `[bridge msg_id=${ID}]\nhello` }]));
    const s = new MarkerScanner();
    expect(s.scan(file)).toBe(true);
    expect(s.has(ID, "prompt")).toBe(true);
    expect(s.has(ID, "answer")).toBe(false);

    const other = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
    appendFileSync(file, line({ type: "custom_message", content: `[bridge msg_id=${other}]\nx` }));
    s.scan(file);
    expect(s.has(other, "prompt")).toBe(true);
  });

  test("proves an answer only from a toolResult message", () => {
    const file = join(tempDir(), "s.jsonl");
    writeFileSync(
      file,
      line({ type: "message", message: { role: "toolResult", toolName: "hermes_ask", content: [{ type: "text", text: `[bridge msg_id=${ID}]\nB` }] } }),
    );
    const s = new MarkerScanner();
    s.scan(file);
    expect(s.has(ID, "answer")).toBe(true);
    expect(s.has(ID, "prompt")).toBe(false);
  });

  test("ignores the marker in assistant output, in other tools' results and in later text", () => {
    const file = join(tempDir(), "s.jsonl");
    writeFileSync(
      file,
      line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `[bridge msg_id=${ID}]\nmine` }] } }) +
        line({ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: `[bridge msg_id=${ID}]\nfile` }] } }) +
        user(`see [bridge msg_id=${ID}] above`) +
        user([{ type: "text", text: "first" }, { type: "text", text: `[bridge msg_id=${ID}]` }]) +
        user(`x\n[bridge msg_id=${ID}]`),
    );
    const s = new MarkerScanner();
    s.scan(file);
    expect(s.has(ID, "prompt")).toBe(false);
    expect(s.has(ID, "answer")).toBe(false);
  });

  test("reads only appended bytes, waits for a complete line, and rereads a replaced file", () => {
    const dir = tempDir();
    const file = join(dir, "s.jsonl");
    writeFileSync(file, "");
    const s = new MarkerScanner();
    s.scan(file);
    const full = user(`[bridge msg_id=${ID}]\nhi`);
    appendFileSync(file, full.slice(0, 20));
    s.scan(file);
    expect(s.has(ID, "prompt")).toBe(false);
    appendFileSync(file, full.slice(20));
    s.scan(file);
    expect(s.has(ID, "prompt")).toBe(true);

    const other = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
    const moved = join(dir, "sibling.jsonl");
    writeFileSync(moved, `${"x".repeat(5000)}\n${user(`[bridge msg_id=${other}]\nhi`)}`);
    renameSync(moved, file); // file replaced by a different, larger one
    s.scan(file);
    expect(s.has(other, "prompt")).toBe(true);
  });

  test("a missing file is not delivery", () => {
    const s = new MarkerScanner();
    expect(s.scan(undefined)).toBe(false);
    expect(s.scan(join(tempDir(), "nope.jsonl"))).toBe(false);
    expect(s.has(ID, "prompt")).toBe(false);
  });

  test("tolerates unparseable lines", () => {
    const file = join(tempDir(), "s.jsonl");
    writeFileSync(file, `not json [bridge msg_id=${ID}]\n${user(`[bridge msg_id=${ID}]\nok`)}`);
    const s = new MarkerScanner();
    s.scan(file);
    expect(s.has(ID, "prompt")).toBe(true);
  });
});
