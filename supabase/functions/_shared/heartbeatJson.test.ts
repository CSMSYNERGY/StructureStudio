// The heartbeat answer (heartbeatJson.ts, 2026-09-25): a 200 at once, a space every so often, then
// the JSON the work answered with. What only this module can get wrong, and what is pinned here:
//
//   1. The 200 and the first byte go out BEFORE the work settles. That is the whole point: the
//      gateway ends a request that is silent for 150 s.
//   2. The work's own 2xx body arrives byte for byte, after the heartbeat, and parses as the same
//      object (JSON.parse skips leading whitespace).
//   3. A non-2xx answer becomes its own object plus `status`, every other key kept in its order.
//   4. A throw becomes { error: "Internal Server Error", status: 500 }.
//   5. The beats keep coming while the work runs, and stop when it ends (no timer left behind: Deno's
//      test sanitizer fails a test that leaks one).
//   6. A caller that goes away stops the beats and the writes, and does NOT stop the work: the work
//      holds money and has to release or capture it with nobody listening.
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine with no
// registry access, the same rule the other _shared tests follow.

import { HEARTBEAT, HEARTBEAT_MS, heartbeatJsonResponse, streamedAnswer } from "./heartbeatJson.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HEADERS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A gate the test opens, so "before the work settles" is a fact rather than a race.
function gate<T>() {
  let open!: (v: T) => void;
  const p = new Promise<T>((r) => { open = r; });
  return { p, open };
}

Deno.test("the heartbeat is ten seconds and one space, the numbers the live probe ran on", () => {
  assertEquals(HEARTBEAT_MS, 10_000);
  assertEquals(HEARTBEAT, " ");
});

Deno.test("the 200 and the first space go out before the work has answered", async () => {
  const g = gate<Response>();
  let started = false;
  const res = heartbeatJsonResponse(() => { started = true; return g.p; }, { headers: HEADERS, heartbeatMs: 1_000 });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json");
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assert(started, "the work starts with the answer, not when someone reads it");
  const reader = res.body!.getReader();
  const first = await reader.read();
  assertEquals(new TextDecoder().decode(first.value), " ", "one space, at once");
  g.open(jsonResponse({ ok: true }));
  let rest = "";
  for (;;) {
    const c = await reader.read();
    if (c.done) break;
    rest += new TextDecoder().decode(c.value);
  }
  assertEquals(rest, '{"ok":true}');
});

Deno.test("a 2xx body arrives byte for byte after the heartbeat, and parses as the same object", async () => {
  const body = { ok: true, d3: { roof: { type: "shed", highSide: "front" } }, frames: 12, dropped: 0, observed: null, balanceCents: null, dims: null, frameMap: null, checkId: "x" };
  const text = JSON.stringify(body);
  const out = await heartbeatJsonResponse(async () => {
    await sleep(35);
    return jsonResponse(body);
  }, { headers: HEADERS, heartbeatMs: 5 }).text();
  assert(out.endsWith(text), "the work's own bytes, unchanged");
  const lead = out.slice(0, out.length - text.length);
  assert(/^ +$/.test(lead), `only spaces before it: ${JSON.stringify(lead)}`);
  assert(lead.length >= 3, `the beats kept coming while the work ran (${lead.length})`);
  assertEquals(JSON.parse(out), body, "JSON.parse skips the heartbeat");
});

Deno.test("a non-2xx answer becomes its own object plus the status it would have had", async () => {
  const cases: [Record<string, unknown>, number][] = [
    [{ error: "The AI took too long to answer - please try again.", retryable: true }, 504],
    [{ error: "The AI ran out of room before finishing - please try again.", retryable: true }, 502],
    [{ error: "This 3D generation costs $20.00 and your wallet has $5.00. Add funds in Settings → Billing.", code: "insufficient_funds", priceCents: 2000, balanceCents: 500 }, 402],
    [{ error: "We already charged you for this generation.", code: "already_charged" }, 409],
    [{ error: "Daily limit reached (10 AI drafts)." }, 429],
    [{ error: "At least one photo URL is required." }, 400],
  ];
  for (const [obj, status] of cases) {
    const out = await heartbeatJsonResponse(() => Promise.resolve(jsonResponse(obj, status)), { headers: HEADERS, heartbeatMs: 5 });
    assertEquals(out.status, 200, "the status line is always 200");
    const text = await out.text();
    assertEquals(text.trimStart(), JSON.stringify({ ...obj, status }), `${status}: the object, key for key, then status`);
    assertEquals(streamedAnswer(status, JSON.stringify(obj)), JSON.stringify({ ...obj, status }));
  }
});

Deno.test("streamedAnswer: a 2xx is untouched, and a body that is not an object still reads as an error", () => {
  assertEquals(streamedAnswer(200, '{"ok":true}'), '{"ok":true}');
  assertEquals(streamedAnswer(204, ""), "", "a 2xx is never rewritten, whatever it holds");
  assertEquals(streamedAnswer(500, "Internal Server Error"), JSON.stringify({ error: "Internal Server Error", status: 500 }));
  assertEquals(streamedAnswer(502, ""), JSON.stringify({ error: "HTTP 502", status: 502 }));
  assertEquals(streamedAnswer(502, "[1,2]"), JSON.stringify({ error: "[1,2]", status: 502 }));
});

Deno.test("a throw becomes what Deno.serve answers an uncaught throw with: a 500", async () => {
  const out = await heartbeatJsonResponse(async () => {
    await sleep(12);
    throw new TypeError("a refactor's typo");
  }, { headers: HEADERS, heartbeatMs: 5 }).text();
  assertEquals(JSON.parse(out), { error: "Internal Server Error", status: 500 });
});

Deno.test("a caller that goes away stops the beats, and the work still runs to its end", async () => {
  const g = gate<Response>();
  let finished = false;
  const res = heartbeatJsonResponse(async () => {
    const r = await g.p;
    finished = true;
    return r;
  }, { headers: HEADERS, heartbeatMs: 5 });
  const reader = res.body!.getReader();
  await reader.read();
  await sleep(15);
  await reader.cancel("the tab closed");
  // The work outlives the caller: this is where it would release or capture the hold.
  g.open(jsonResponse({ ok: true }));
  await sleep(20);
  assert(finished, "the work ran to its end with nobody listening");
  // And nothing threw into the void: a write after the cancel is dropped, not raised.
});
