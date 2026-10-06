// My Synergy Phone — the phone-call-summary edge function's decisions
// (supabase/functions/phone-call-summary/summary.ts): who may call it, the idempotent claim,
// what Claude is asked, what is stored, and that no transcript or summary ever reaches a log or
// an answer. The database, the environment, Claude and the logger are stubs.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
//
// Every value here is an obviously fake fixture: this repo is public.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  callerAllowed, cleanSummary, costMicros, handleSummaryRequest, MAX_SUMMARY_ATTEMPTS, SUMMARY_LEASE_S, SUMMARY_MAX_CHARS,
  SUMMARY_MODEL, type SummaryDeps, userPrompt,
} from "../../supabase/functions/phone-call-summary/summary.ts";

const REC = "00000000-0000-4000-8000-0000000ae001";
const KEY = "test-service-key";
const SECRET_WORDS = "the gate code is 4321";
const TRANSCRIPT = `Customer: Hi, is my 12x24 ready? Also ${SECRET_WORDS}.\nTeam: Yes, Friday.`;
const NOW = new Date("2026-10-04T12:00:00Z");

/** A service_role JWT as the gateway would have verified it (the signature is not checked here). */
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const serviceJwt = `${b64({ alg: "HS256" })}.${b64({ role: "service_role" })}.sig`;
const anonJwt = `${b64({ alg: "HS256" })}.${b64({ role: "anon" })}.sig`;

interface World {
  claim?: unknown;
  claimError?: string;
  apiKey?: string | null;
  claude?: (body: Record<string, unknown>) => Response | Promise<Response>;
}

function world(w: World = {}) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const updates: { id: string; patch: Record<string, unknown>; onlyIf: string }[] = [];
  const logs: { code: string; message: string; severity?: string; context?: Record<string, unknown> }[] = [];
  const asked: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const claimed = {
    id: REC, client_id: "demo-tenant", transcript: TRANSCRIPT, summary_attempts: 1, direction: "in", duration_s: 125,
  };
  const deps: SummaryDeps = {
    env: (k) => ({ SUPABASE_SERVICE_ROLE_KEY: KEY, ANTHROPIC_API_KEY: w.apiKey === null ? undefined : (w.apiKey ?? "test-anthropic-key") } as Record<string, string | undefined>)[k],
    rpc: (name, args) => {
      rpcs.push({ name, args });
      return Promise.resolve(w.claimError ? { data: null, error: { message: w.claimError } } : { data: w.claim === undefined ? claimed : w.claim, error: null });
    },
    update: (id, patch, onlyIf) => {
      updates.push({ id, patch, onlyIf });
      return Promise.resolve({ error: null });
    },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body));
      asked.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body });
      return w.claude ? await w.claude(body) : new Response(JSON.stringify({
        stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Cam asked whether his 12x24 is ready; it will be on Friday.\n\nAction items:\n- Team: confirm Friday delivery." }],
        usage: { input_tokens: 600, output_tokens: 60 },
      }), { status: 200 });
    },
    log: (e) => {
      logs.push(e);
      return Promise.resolve();
    },
    now: () => NOW,
  };
  return { deps, rpcs, updates, logs, asked };
}

const post = (auth: string | null, body: unknown = { recording_id: REC }) => new Request("https://example.test/functions/v1/phone-call-summary", {
  method: "POST",
  headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
  body: JSON.stringify(body),
});

Deno.test("who may call: the service key or the summary secret (constant time), or a gateway-verified service_role JWT; nobody else", () => {
  const keys = { serviceKey: KEY, secret: "a-separate-secret", gatewayVerified: true };
  assert(callerAllowed(`Bearer ${KEY}`, keys));
  assert(callerAllowed("Bearer a-separate-secret", keys));
  assert(callerAllowed(`Bearer ${serviceJwt}`, keys));
  assert(!callerAllowed(`Bearer ${anonJwt}`, keys));
  assert(!callerAllowed(`Bearer ${serviceJwt}`, { ...keys, gatewayVerified: false }));
  assert(!callerAllowed("Bearer test-service-ke", keys));
  assert(!callerAllowed(KEY, keys)); // no Bearer
  assert(!callerAllowed(null, keys));
  assert(!callerAllowed("Bearer ", { serviceKey: "", secret: "" }));
});

Deno.test("the gateway door is open only while the gateway verifies: gatewayVerified true needs verify_jwt = true", async () => {
  const toml = (await Deno.readTextFile(new URL("../../supabase/config.toml", import.meta.url))).replace(/\r\n/g, "\n");
  const block = /\[functions\.phone-call-summary\]\n([\s\S]*?)(?=\n\[|$)/.exec(toml);
  assert(block, "config.toml has no [functions.phone-call-summary] block");
  const lines = (block?.[1] ?? "").split("\n").filter((l) => !/^\s*#/.test(l));
  const verified = lines.some((l) => /^\s*verify_jwt\s*=\s*true\s*$/.test(l));
  const src = await Deno.readTextFile(new URL("../../supabase/functions/phone-call-summary/summary.ts", import.meta.url));
  if (src.includes("gatewayVerified: true")) {
    assert(verified, "summary.ts trusts the gateway's signature check, so verify_jwt must stay true (with it false the service_role claim is forgeable)");
  }
});

Deno.test("refuses a stranger before reading anything, and a request with no recording id", async () => {
  const w = world();
  assertEquals((await handleSummaryRequest(post(null), w.deps)).status, 401);
  assertEquals((await handleSummaryRequest(post(`Bearer ${anonJwt}`), w.deps)).status, 401);
  assertEquals((await handleSummaryRequest(new Request("https://example.test/", { method: "GET" }), w.deps)).status, 405);
  assertEquals((await handleSummaryRequest(post(`Bearer ${KEY}`, { recording_id: "nope" }), w.deps)).status, 400);
  assertEquals(w.rpcs, []);
  assertEquals(w.asked, []);
});

Deno.test("claims the row, asks Claude once (Sonnet 5.5, low effort, server-side fallback), stores the summary and its cost", async () => {
  const w = world();
  const res = await handleSummaryRequest(post(`Bearer ${KEY}`), w.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, state: "done" });
  assertEquals(w.rpcs, [{ name: "phone_recording_summary_claim", args: { p_id: REC, p_lease_s: SUMMARY_LEASE_S } }]);
  assertEquals(w.asked.length, 1);
  const ask = w.asked[0];
  assertEquals(ask.url, "https://api.anthropic.com/v1/messages");
  assertEquals(ask.headers["x-api-key"], "test-anthropic-key");
  assertEquals(ask.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assertEquals(ask.body.model, SUMMARY_MODEL);
  assertEquals(ask.body.model, "claude-sonnet-5-5");
  assertEquals(ask.body.fallbacks, "default");
  assertEquals(ask.body.output_config, { effort: "low" });
  assert(!("thinking" in ask.body)); // budget_tokens / disabled are refused on this model
  const content = (ask.body.messages as { content: string }[])[0].content;
  assert(content.includes(`<transcript>\n${TRANSCRIPT}\n</transcript>`));
  assert(content.startsWith("The customer called the business. It lasted about 2 minute(s)."));
  assertEquals(w.updates, [{
    id: REC, onlyIf: "working",
    patch: {
      summary: "Cam asked whether his 12x24 is ready; it will be on Friday.\n\nAction items:\n- Team: confirm Friday delivery.",
      summary_status: "done", llm_cost_micros: 600 * 2 + 60 * 10, lease_until: null, last_error: null, summary_next_at: null,
    },
  }]);
  assertEquals(w.logs, []);
});

Deno.test("idempotent: a row already done, being written, deleted or without a transcript claims nothing and asks nobody", async () => {
  const w = world({ claim: null });
  const res = await handleSummaryRequest(post(`Bearer ${serviceJwt}`), w.deps);
  assertEquals(await res.json(), { ok: true, state: "nothing_to_do" });
  assertEquals(w.asked, []);
  assertEquals(w.updates, []);
});

Deno.test("Claude busy or down: back to pending with a back-off; a decline or the last attempt: failed", async () => {
  let w = world({ claude: () => new Response("{}", { status: 529 }) });
  assertEquals(await (await handleSummaryRequest(post(`Bearer ${KEY}`), w.deps)).json(), { ok: false, state: "retry" });
  assertEquals(w.updates[0].patch, { summary_status: "pending", summary_next_at: "2026-10-04T12:02:00.000Z", lease_until: null, last_error: "Claude answered HTTP 529" });
  assertEquals(w.logs[0].code, "phone_summary_retry");

  w = world({ claude: () => new Response(JSON.stringify({ stop_reason: "refusal", content: [] }), { status: 200 }) });
  assertEquals(await (await handleSummaryRequest(post(`Bearer ${KEY}`), w.deps)).json(), { ok: false, state: "failed" });
  assertEquals(w.updates[0].patch.summary_status, "failed");
  assertEquals(w.logs[0].code, "phone_summary_failed");

  w = world({ claim: { id: REC, client_id: "demo-tenant", transcript: TRANSCRIPT, summary_attempts: MAX_SUMMARY_ATTEMPTS, direction: "out", duration_s: 60 }, claude: () => new Response("{}", { status: 500 }) });
  assertEquals(await (await handleSummaryRequest(post(`Bearer ${KEY}`), w.deps)).json(), { ok: false, state: "failed" });

  w = world({ claude: () => new Response("{}", { status: 400 }) });
  assertEquals(await (await handleSummaryRequest(post(`Bearer ${KEY}`), w.deps)).json(), { ok: false, state: "failed" });
});

Deno.test("no ANTHROPIC_API_KEY: nothing sent anywhere, the row goes back, and it says so", async () => {
  const w = world({ apiKey: null });
  assertEquals(await (await handleSummaryRequest(post(`Bearer ${KEY}`), w.deps)).json(), { ok: false, state: "retry" });
  assertEquals(w.asked, []);
  assert(String(w.updates[0].patch.last_error).includes("ANTHROPIC_API_KEY"));
});

Deno.test("NO TRANSCRIPT OR SUMMARY IN ANY LOG OR ANSWER, whatever goes wrong", async () => {
  const outcomes: World[] = [
    { claude: () => new Response(JSON.stringify({ error: { message: `bad request near ${SECRET_WORDS}` } }), { status: 400 }) },
    { claude: () => new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: `Summary: ${SECRET_WORDS}` }], usage: {} }), { status: 200 }) },
    { claude: () => { throw new Error(`socket closed while sending ${SECRET_WORDS}`); } },
    { claimError: `relation broke near ${SECRET_WORDS}` },
  ];
  for (const o of outcomes) {
    const w = world(o);
    w.deps.update = (id, patch, onlyIf) => {
      w.updates.push({ id, patch, onlyIf });
      return Promise.resolve({ error: patch.summary ? { message: "violates check constraint" } : null });
    };
    const res = await handleSummaryRequest(post(`Bearer ${KEY}`), w.deps);
    const answer = await res.text();
    const logged = JSON.stringify(w.logs);
    for (const s of [answer, logged]) {
      assert(!s.includes("4321"), `leaked into ${s === answer ? "the answer" : "a log"}: ${s}`);
      assert(!s.includes("12x24"));
    }
  }
});

Deno.test("the stored summary fits 1,200 characters, cut at a line or sentence", () => {
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about the shed.`).join(" ");
  const cut = cleanSummary(long);
  assert(cut.length <= SUMMARY_MAX_CHARS);
  assert(cut.endsWith("."));
  assertEquals(cleanSummary("  One.\n\n\n\nTwo.  \n"), "One.\n\nTwo.");
  assertEquals(costMicros({ input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10 }), 1010 * 2 + 1000);
  assertEquals(costMicros(null), 0);
  assert(userPrompt({ transcript: "x", direction: "out", duration_s: null }).startsWith("The business called the customer.\n\n<transcript>"));
});
