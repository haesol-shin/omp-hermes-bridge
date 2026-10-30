// Local stand-in for the Hermes webhook route, used only for acceptance runs.
// Verifies the Generic V2 signature exactly as contract/README.md describes and logs one JSON line per request.
//   LISTEN_PORT=18791 LISTEN_SECRET=... LISTEN_LOG=events.jsonl [LISTEN_FAIL_FILE=path] bun scripts/webhook-listener.ts
// While LISTEN_FAIL_FILE exists the listener answers 503, to exercise the outbox.
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";

const port = Number(process.env.LISTEN_PORT ?? 18791);
const secret = process.env.LISTEN_SECRET ?? "";
const logFile = process.env.LISTEN_LOG ?? "webhook-events.jsonl";
const failFile = process.env.LISTEN_FAIL_FILE;
const WINDOW_S = 300;
const seen = new Set<string>();

const record = (entry: Record<string, unknown>) => appendFileSync(logFile, `${JSON.stringify(entry)}\n`);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const body = Buffer.from(await request.arrayBuffer());
    const timestamp = request.headers.get("x-webhook-timestamp") ?? "";
    const signature = request.headers.get("x-webhook-signature-v2") ?? "";
    const requestId = request.headers.get("x-request-id") ?? "";
    const at = new Date().toISOString();
    if (failFile && existsSync(failFile)) {
      record({ at, result: "unavailable", request_id: requestId });
      return new Response("unavailable", { status: 503 });
    }
    const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
    const sigOk =
      signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    const fresh = /^\d+$/.test(timestamp) && Math.abs(Date.now() / 1000 - Number(timestamp)) <= WINDOW_S;
    if (!sigOk || !fresh) {
      record({ at, result: "rejected", sig_ok: sigOk, fresh, request_id: requestId });
      return new Response("invalid", { status: 401 });
    }
    let event: any;
    try {
      event = JSON.parse(body.toString("utf8"));
    } catch {
      record({ at, result: "rejected", reason: "not json", request_id: requestId });
      return new Response("invalid", { status: 400 });
    }
    const duplicate = seen.has(requestId);
    seen.add(requestId);
    record({
      at,
      result: duplicate ? "duplicate" : "accepted",
      request_id_matches_event: requestId === event.event_id,
      event,
    });
    return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
  },
});
console.log(`listening on 127.0.0.1:${port}, log ${logFile}`);
