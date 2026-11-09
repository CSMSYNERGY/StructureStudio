import { assert, assertEquals } from "./test_assert.ts";
import { addUsage, apiReason, askClaude, type Fetcher, zeroTotals } from "./claude.ts";

const ok = () => new Response(JSON.stringify({ stop_reason: "end_turn", content: [] }), { status: 200 });
const body = { model: "claude-sonnet-5-5" };

Deno.test("a blip is asked again", async () => {
  let n = 0;
  const f: Fetcher = () => Promise.resolve(n++ === 0 ? new Response("{}", { status: 529 }) : ok());
  const r = await askClaude(f, "k", body, 60_000);
  assert(r.ok);
  assertEquals(n, 2);
});

Deno.test("an answer a retry can't fix isn't sent twice", async () => {
  for (const status of [400, 401, 403, 404]) {
    let n = 0;
    const f: Fetcher = () => { n++; return Promise.resolve(new Response("{}", { status })); };
    const r = await askClaude(f, "k", body, 60_000);
    assert(!r.ok);
    assertEquals(n, 1, String(status));
  }
});

Deno.test("a retry never runs past the budget", async () => {
  let n = 0;
  const f: Fetcher = () => { n++; return Promise.resolve(new Response("{}", { status: 503, headers: { "retry-after": "120" } })); };
  const started = Date.now();
  const r = await askClaude(f, "k", body, 60_000);
  assert(!r.ok);
  assertEquals(n, 1);
  assert(Date.now() - started < 1000);
});

Deno.test("a body that stalls after its headers still times out", async () => {
  const f: Fetcher = (_u, init) => Promise.resolve(new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("{"));
      init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
    },
  }), { status: 200 }));
  const started = Date.now();
  const r = await askClaude(f, "k", body, 1200);
  assert(!r.ok);
  if (!r.ok) assertEquals(r.why, "timeout");
  assert(Date.now() - started < 3000);
});

Deno.test("the models a fallback lands on are priced as what they are", () => {
  const usage = { input_tokens: 5000, output_tokens: 500, cache_read_input_tokens: 2000 };
  assertEquals(addUsage(zeroTotals(), usage, "claude-sonnet-5").costMicros, addUsage(zeroTotals(), usage, "claude-sonnet-5-5").costMicros);
  assert(addUsage(zeroTotals(), usage, "claude-opus-4-8").costMicros < addUsage(zeroTotals(), usage, "some-new-model").costMicros);
});

Deno.test("a refused request keeps the API's reason for the log, masked; a spend limit and a 5xx don't", async () => {
  const err = (status: number, type: string, message: string) => () =>
    Promise.resolve(new Response(JSON.stringify({ type: "error", error: { type, message } }), { status }));
  const r = await askClaude(err(400, "invalid_request_error", "tools.3.input_schema: too complex"), "k", body, 60_000);
  assertEquals(r, { ok: false, why: "http", status: 400, detail: "invalid_request_error: tools.3.input_schema: too complex" });
  const lim = await askClaude(err(400, "invalid_request_error", "You have reached your specified API usage limits."), "k", body, 60_000);
  assertEquals(lim, { ok: false, why: "limit", status: 400 });
  assertEquals(apiReason(JSON.stringify({ error: { type: "x", message: "dale@example.com or (816) 555-0142\nsaid hi" } })), "x: [email] or ([number] said hi");
  assertEquals(apiReason("not json"), "");
  assertEquals(apiReason(JSON.stringify({ error: { type: "t", message: "a".repeat(900) } })).length, 300);
});
