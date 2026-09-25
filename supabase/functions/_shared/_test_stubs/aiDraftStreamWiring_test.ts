// The STREAMED v2 draft (2026-09-25), driven through the SHIPPED portal-settings handler.
//
// WHY THIS EXISTS. The gateway ends a request that is silent for 150 s, so the draft's model abort
// had to stop at 125 s, and at effort "high" all three consensus reads ran past it. The gateway
// times silence, not the request, so the new shell asks for `stream: true` and the server answers
// 200 at once, writes a space every ten seconds, then writes the JSON (heartbeatJson.ts); the draft
// gets 230 s and thinks at "high". That change is safe only if all of this holds, and each is pinned
// here:
//
//   1. WHICH requests stream: stream:true AND the v2 prompt AND not lean -- decided before the branch
//      runs (wantsStreamedDraft), and never in disagreement with the branch's own v2Prompt and lean.
//   2. A request that does not stream is answered exactly as before: the branch's own Response, not a
//      stream; the one call, the three calls, effort "medium" (or "low" when lean), the 125 s budget.
//   3. A streamed request gets a 200 and a heartbeat at once, and then the SAME answer the plain
//      request would have given: a success byte for byte, and every failure as its own object plus
//      the status it would have had, `retryable`, `code` and `error` untouched.
//   4. Everything around the answer happens exactly as it does unstreamed, in the same order: the
//      ledger row, the hold and its release on every failure, the capture, the usage write, the coded
//      app_errors rows AND the rows the error wrapper files, which it cannot see through a 200.
//   5. Effort "high" and the 230/260 s budget only on the streamed request.
//   6. The new shell's half (it asks for the stream, and reads a failure in the body exactly like a
//      non-2xx) is aiDraftStreamShell_test.
//
// HOW. The real handler, not a lifted copy: Deno.serve is stubbed while portal-settings/index.ts is
// imported (the customerAuthSlots_test idiom), and a request goes through withErrorLog, resolveTenant
// and the branch as it does live. The import map swaps supabase-js for supabase_stub.ts, whose stubDb
// and stubRpc hooks route every table read and write, every wallet RPC and every app_errors insert
// into the fake below. fetch is stubbed for the Anthropic API only, AbortSignal.timeout records the
// budget it was given, and no --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE. A literal one puts portal-settings in this file's
// type-checked graph, where it is checked against the stub's deliberately partial client type and
// fails on every storage and auth.admin call it makes. preflight's `deno check` types it against the
// real client; here it only has to run.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";
import { parseKnownDims, wantsStreamedDraft, wantsV2Prompt } from "../styleD3.ts";
import { HEARTBEAT_MS } from "../heartbeatJson.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SOURCE = await read("../../portal-settings/index.ts");

function lift(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiDraftStreamWiring_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
type ModelPlan = { status?: number; body?: string; delayMs?: number; hang?: boolean; throws?: string; gate?: Promise<void> };
type World = {
  cap?: number | null;          // client_settings.ai_style_daily_cap (null = the default 10)
  used?: number;                // generations in the last 24 h
  ledgerFails?: boolean;        // the ai_style_calls insert errors
  hold?: Record<string, unknown>;
  holdErr?: { message: string };
  captureErr?: boolean;
  noKey?: boolean;              // ANTHROPIC_API_KEY unset
  throwOn?: string;             // a table whose read throws (an unhandled bug)
  model?: ModelPlan[];          // one plan per model call, in send order
  abortAfterMs?: number;        // when the draft's deadline really fires
  setupMs?: number;             // how long the set-up (the auto top-up read) seems to take
};
type Trace = {
  db: unknown[];                // every awaited table op and rpc, in order
  released: string[];
  captured: unknown[];
  rows: Record<string, unknown>[];   // app_errors
  sent: any[];                  // Anthropic request bodies
  timeouts: number[];           // AbortSignal.timeout(ms)
  intervals: number[];          // setInterval(ms)
};

const DIMS = { widthFt: 30, lengthFt: 20, wallHeightFt: 8 };
const FRAMES = Array.from({ length: 12 }, (_, i) => `https://example.test/walk/f${i + 1}.jpg`);
const V2 = { action: "calibrate_style_ai", photoUrls: FRAMES, styleValue: "barn", source: "video", videoCount: 12, idempotencyKey: "press-1", dims: DIMS, frame: "front" };
const STREAMED = { ...V2, stream: true };
const LEDGER_ID = "11111111-2222-4333-8444-555555555555";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
  ANTHROPIC_API_KEY: "test-key",
};

function answer(world: World, trace: Trace, target: string, ops: any[][]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  if (target === "client_users") return { data: [{ client_id: "harness-tenant", role: "owner", title: null, access: null }], error: null };
  if (target === "client_settings") return { data: world.cap === undefined ? null : { ai_style_daily_cap: world.cap }, error: null };
  if (target === "ai_style_calls") {
    if (has("select") && (arg("select") === "id") && ops.some((o) => o[0] === "select" && o[2] && o[2].head)) return { count: world.used ?? 0, error: null };
    if (has("insert")) return world.ledgerFails ? { data: null, error: { message: "the ledger is gone" } } : { data: { id: LEDGER_ID }, error: null };
    return { data: null, error: null };
  }
  if (target === "wallet_accounts") {
    if (has("select")) {
      // The auto top-up's read: the last thing before the model's clock starts.
      if (world.setupMs) clock.offset += world.setupMs;
      return { data: { balance_cents: 8000, held_cents: 2000, auto_topup_enabled: false }, error: null };
    }
    return { data: null, error: null };
  }
  if (target === "billing_customers") return { data: null, error: null };
  if (target === "rpc:wallet_hold") {
    return world.holdErr ? { data: null, error: world.holdErr } : { data: world.hold ?? { hold_id: 77, err: null, price_cents: 2000, balance_after: 6000 }, error: null };
  }
  if (target === "rpc:wallet_release") { trace.released.push(String(arg("args")?.p_reason)); return { data: null, error: null }; }
  if (target === "rpc:wallet_capture") {
    trace.captured.push(arg("args"));
    return world.captureErr ? { data: null, error: { message: "capture is down" } } : { data: 6000, error: null };
  }
  throw new Error(`the fake database has no answer for ${target} ${JSON.stringify(ops)}`);
}

function chain(world: World, trace: Trace, target: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, target, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "gt", "lt", "is", "in", "limit", "order", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (target === "app_errors") {
      const row = (ops.find((o) => o[0] === "insert") ?? [])[1];
      trace.rows.push(row);
      return Promise.resolve({ error: null }).then(ok, bad);
    }
    trace.db.push([target, ...ops]);
    return Promise.resolve().then(() => answer(world, trace, target, ops)).then(ok, bad);
  };
  return q;
}

// A clock the fake database can move forward, so a slow set-up costs no real time.
const clock = { offset: 0 };
const realNow = Date.now;

async function inWorld<T>(world: World, body: (trace: Trace) => Promise<T>): Promise<{ trace: Trace; out: T }> {
  const trace: Trace = { db: [], released: [], captured: [], rows: [], sent: [], timeouts: [], intervals: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  if (world.noKey) Deno.env.delete("ANTHROPIC_API_KEY");
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const realSetInterval = globalThis.setInterval;
  const timers: ReturnType<typeof setTimeout>[] = [];
  stubAuth.user = { id: "00000000-0000-4000-8000-000000000001", email: "harness@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => {
    if (world.throwOn === table) throw new TypeError(`the ${table} read blew up`);
    return chain(world, trace, table, []);
  };
  stubRpc.rpc = (fn: string, args?: unknown) => chain(world, trace, `rpc:${fn}`, [["args", args]]);
  clock.offset = 0;
  Date.now = () => realNow() + clock.offset;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true, writable: true,
    value: (ms: number) => {
      trace.timeouts.push(ms);
      const c = new AbortController();
      timers.push(setTimeout(() => c.abort(new DOMException("Signal timed out.", "TimeoutError")), world.abortAfterMs ?? 3_000));
      return c.signal;
    },
  });
  // The heartbeat's clock, a thousand times faster: ten seconds is ten milliseconds here.
  (globalThis as any).setInterval = (fn: () => void, ms: number) => {
    trace.intervals.push(ms);
    return realSetInterval(fn, Math.max(1, Math.round(ms / 1000)));
  };
  let calls = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://api.anthropic.com/v1/messages") throw new Error(`unexpected fetch: ${url}`);
    const plan = (world.model ?? [])[calls++] ?? { hang: true };
    trace.sent.push(JSON.parse(String(init?.body)));
    const signal = init?.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      if (plan.throws) { reject(new TypeError(plan.throws)); return; }
      let t: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => { if (t !== undefined) clearTimeout(t); reject(new DOMException("The signal has been aborted", "AbortError")); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (plan.hang) return;
      (plan.gate ?? Promise.resolve()).then(() => {
        if (signal.aborted) return;
        t = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve(new Response(plan.body ?? "", { status: plan.status ?? 200 }));
        }, plan.delayMs ?? 1);
        timers.push(t!);
      });
    });
  }) as typeof fetch;
  try {
    const out = await body(trace);
    return { trace, out };
  } finally {
    for (const t of timers) clearTimeout(t);
    globalThis.fetch = realFetch;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: realTimeout });
    (globalThis as any).setInterval = realSetInterval;
    Date.now = realNow;
    clock.offset = 0;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

function request(payload: Record<string, unknown>): Request {
  return new Request("https://stub.supabase.co/functions/v1/portal-settings", {
    method: "POST",
    headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
    body: JSON.stringify(payload),
  });
}

type Answered = { status: number; headers: Headers; text: string; threw: string | null };
async function drive(payload: Record<string, unknown>, world: World = {}) {
  return await inWorld(world, async (): Promise<Answered> => {
    try {
      const res = await HANDLER(request(payload));
      // Read to the end: a streamed answer's work finishes behind the 200, and the world has to
      // stay up until it has.
      return { status: res.status, headers: res.headers, text: await res.text(), threw: null };
    } catch (e) {
      return { status: 0, headers: new Headers(), text: "", threw: e instanceof Error ? e.message : String(e) };
    }
  });
}

// Timing and stack noise out, everything else compared as it is.
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/(^ms$|Ms$|_ms$)/.test(k) && typeof x === "number") out[k] = "<ms>";
      else if (k === "stack" && typeof x === "string") out[k] = "<stack>";
      else out[k] = norm(x);
    }
    return out;
  }
  if (typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:/.test(v)) return "<iso>";
  return v;
}

// ─── Replies ───────────────────────────────────────────────────────────────────────────────────
const SPEC = {
  roof: {
    type: "gable", front: "gable", pitch: 0.5, overhangIn: 6, eave: "fascia",
    wingSide: "both", wingWidthFt: 9, wingPitch: 0.25, centerEaveFt: 14,
    porchOutFt: 6, porchEnd: "front", porchAttachFt: 10, porchPosts: 4, porchPitch: 0.2, porchSteps: "center",
  },
  colors: { body: "#333333", trim: "#222222", roof: "#1a1a1a", corner: "#333333", fascia: "#1a1a1a" },
  roofMaterial: "metal",
  observed: { roofNote: "raised gable centre, a wing each side", porch: "projecting", wings: "both", confidence: "medium" },
  frameMap: { front: { frame: 1, azimuthDeg: 0 }, back: { frame: 7, azimuthDeg: 180 } },
};
function reply(text: string, o: { stop?: string; out?: number } = {}) {
  return JSON.stringify({
    content: [{ type: "thinking", thinking: "" }, { type: "text", text }],
    stop_reason: o.stop ?? "end_turn",
    usage: { input_tokens: 21000, output_tokens: o.out ?? 7000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}
const GOOD = (roof: Record<string, unknown> = {}): ModelPlan => ({ body: reply(JSON.stringify({ ...SPEC, roof: { ...SPEC.roof, ...roof } })), delayMs: 2 });
const TRUNCATED: ModelPlan = { body: reply('{"roof":{"type":"gable","pit', { stop: "max_tokens", out: 12000 }), delayMs: 2 };
const UNPARSEABLE: ModelPlan = { body: reply("I could not tell what this building is."), delayMs: 2 };
const REFUSED: ModelPlan = { body: reply("", { stop: "refusal" }), delayMs: 2 };
const OVERLOADED: ModelPlan = { status: 529, body: '{"type":"error","error":{"type":"overloaded_error"}}', delayMs: 2 };
const THREE = (p: ModelPlan) => [p, p, p];

// Every way the branch can answer, each one run plain and streamed against the same world.
const SCENARIOS: [string, World, number][] = [
  ["a draft (three reads, a consensus)", { model: [GOOD({ centerEaveFt: 15 }), GOOD({ centerEaveFt: 13 }), GOOD({ centerEaveFt: 14 })] }, 200],
  ["a draft whose capture failed", { model: THREE(GOOD()), captureErr: true }, 200],
  ["no API key", { noKey: true }, 500],
  ["the daily cap", { cap: 10, used: 10 }, 429],
  ["the ledger insert failing", { ledgerFails: true }, 503],
  ["the wallet hold failing", { holdErr: { message: "rpc down" } }, 503],
  ["insufficient funds", { hold: { err: "insufficient_funds", price_cents: 2000, balance_after: 500 } }, 402],
  ["a hold already in flight", { hold: { err: "hold_in_flight" } }, 409],
  ["a press already charged (hold_replayed)", { hold: { err: "hold_replayed" } }, 409],
  ["an unpriced meter", { hold: { err: "meter_unknown" } }, 503],
  ["every read timing out", { model: THREE({ hang: true }), abortAfterMs: 40 }, 504],
  ["every read cut off at max_tokens", { model: THREE(TRUNCATED) }, 502],
  ["every read unparseable", { model: THREE(UNPARSEABLE) }, 502],
  ["every read refused", { model: THREE(REFUSED) }, 502],
  ["the API overloaded", { model: THREE(OVERLOADED) }, 502],
  ["the API unreachable", { model: THREE({ throws: "connection reset" }) }, 502],
];

// ─── 1. Which requests stream ──────────────────────────────────────────────────────────────────
Deno.test("wantsStreamedDraft is stream:true AND the branch's own v2Prompt AND not lean, over every combination", () => {
  // The branch's own decisions, lifted and run: the source, the dims, the v2 gate and lean.
  const BRANCH = lift(SOURCE, 'if (action === "calibrate_style_ai") return await draftAnswer(', "// ── THE FREE SECOND PASS", "the branch");
  const line = (needle: string) => (BRANCH.split("\n").find((l) => l.includes(needle)) ?? "").trim();
  const decls = [
    line("const fromVideo ="), line("const combined ="), line("const shapeFirst ="), line("const dimsRead ="),
    line("const dims = shapeFirst"), line("const v2Prompt ="), line("const lean ="),
  ];
  assertEquals(decls.filter((d) => !d).length, 0, "every declaration was found");
  const branch = new Function("payload", "parseKnownDims", "wantsV2Prompt",
    `${decls.join("\n")}\nreturn { v2Prompt, lean, dimsOk: dimsRead.ok };`) as (p: unknown, a: unknown, b: unknown) => { v2Prompt: boolean; lean: boolean; dimsOk: boolean };
  let n = 0, streamed = 0;
  for (const stream of [true, false, "true", 1, undefined]) {
    for (const lean of [true, false, "true", undefined]) {
      for (const source of ["video", "combined", "photos", undefined]) {
        for (const frame of ["front", "FRONT", undefined]) {
          for (const dims of [DIMS, undefined, {}, { widthFt: 30 }, { widthFt: 30, lengthFt: 20, wallHeightFt: 99 }]) {
            const p: Record<string, unknown> = { action: "calibrate_style_ai", stream, lean, source, frame, dims };
            const b = branch(p, parseKnownDims, wantsV2Prompt);
            // A request whose dims do not parse is refused with a 400 before v2 is decided; it never streams.
            const want = stream === true && b.dimsOk && b.v2Prompt && !b.lean;
            assertEquals(wantsStreamedDraft(p), want, JSON.stringify(p));
            n++; if (want) streamed++;
          }
        }
      }
    }
  }
  assertEquals(n, 5 * 4 * 4 * 3 * 5);
  // A real stream:true, lean anything but a real true (false, "true", absent), video or combined,
  // frame "front" and good dims: 3 x 2 of the grid, and nothing else.
  assertEquals(streamed, 3 * 2, "only a real stream:true, not a real lean, video or combined, frame front, good dims");
  assertEquals(wantsStreamedDraft(null), false);
  assertEquals(wantsStreamedDraft([STREAMED]), false);
});

Deno.test("draftAnswer answers a request that does not stream with the branch's own Response, untouched", () => {
  const fn = lift(SOURCE, "function draftAnswer(", "\n}\n", "draftAnswer");
  const body = fn.slice(fn.indexOf("{") + 1).split("\n").map((l) => l.trim()).filter(Boolean);
  assertEquals(body[0], "if (!wantsStreamedDraft(payload)) return work(false);", "the first thing it does");
  // And `streamed` changes exactly two things inside the branch: the budget and the effort.
  const BRANCH = lift(SOURCE, 'if (action === "calibrate_style_ai") return await draftAnswer(', "// ── THE FREE SECOND PASS", "the branch");
  const uses = BRANCH.split("\n").filter((l) => /\bstreamed\b/.test(l) && !l.trim().startsWith("//")).map((l) => l.trim());
  assertEquals(uses, [
    'if (action === "calibrate_style_ai") return await draftAnswer(req, payload, async (streamed: boolean): Promise<Response> => {',
    "const draftAbortMs = streamed",
    'output_config: { effort: lean ? "low" : streamed ? "high" : "medium" },',
  ]);
});

// ─── 2. A request that does not stream ─────────────────────────────────────────────────────────
Deno.test("requests that do not stream are answered as before: a plain Response, effort medium or low, 125 s", async () => {
  const cases: [string, Record<string, unknown>, { calls: number; effort: string; model: string }][] = [
    ["the new shell's v2 press without stream (an older edge caller)", V2, { calls: 3, effort: "medium", model: "claude-opus-5" }],
    ["the lean retry, even if it says stream", { ...STREAMED, lean: true }, { calls: 1, effort: "low", model: "claude-opus-5" }],
    ["production's older shell (no frame), even if it says stream", { ...STREAMED, frame: undefined }, { calls: 1, effort: "medium", model: "claude-sonnet-5" }],
    ["stream as a string", { ...V2, stream: "true" }, { calls: 3, effort: "medium", model: "claude-opus-5" }],
  ];
  for (const [what, payload, want] of cases) {
    const { trace, out } = await drive(payload, { model: THREE(GOOD()) });
    assertEquals(out.status, 200, what);
    assert(out.text.startsWith('{"ok":true,'), `${what}: no heartbeat, the JSON itself`);
    assertEquals(trace.sent.length, want.calls, `${what}: calls`);
    for (const b of trace.sent) {
      assertEquals(b.output_config, { effort: want.effort }, what);
      assertEquals(b.model, want.model, what);
    }
    assertEquals(trace.timeouts, [125_000], `${what}: the 125 s budget`);
    assertEquals(trace.intervals, [], `${what}: no heartbeat`);
  }
});

// ─── 3 + 4. A streamed request: the same answer, and the same everything around it ─────────────
for (const [what, world, status] of SCENARIOS) {
  Deno.test(`streamed, ${what}: 200 at once, then today's ${status} answer, with the same ledger, hold, capture and log rows`, async () => {
    const plain = await drive(V2, world);
    const streamed = await drive(STREAMED, world);
    assertEquals(plain.out.status, status, "the plain request's own status");
    // The streamed answer: a 200, a heartbeat, then the plain answer.
    assertEquals(streamed.out.status, 200);
    assertEquals(streamed.out.headers.get("content-type"), "application/json");
    assertEquals(streamed.out.headers.get("access-control-allow-origin"), plain.out.headers.get("access-control-allow-origin"));
    assertEquals(streamed.out.headers.get("access-control-allow-headers"), plain.out.headers.get("access-control-allow-headers"));
    assert(/^ +[{]/.test(streamed.out.text), `a heartbeat before the JSON: ${JSON.stringify(streamed.out.text.slice(0, 20))}`);
    const last = streamed.out.text.trimStart();
    if (status < 300) {
      // Byte for byte, apart from the model's own numbers (the consensus's usage), which match too.
      assertEquals(norm(JSON.parse(last)), norm(JSON.parse(plain.out.text)));
      assertEquals(Object.keys(JSON.parse(last)), Object.keys(JSON.parse(plain.out.text)), "the same keys, in the same order");
    } else {
      const was = JSON.parse(plain.out.text);
      assertEquals(JSON.parse(last), { ...was, status }, "its own object plus the status it would have had");
      assertEquals(Object.keys(JSON.parse(last)), [...Object.keys(was), "status"]);
    }
    // Everything around the answer, in the same order.
    assertEquals(norm(streamed.trace.db), norm(plain.trace.db), "the same database work, in the same order");
    assertEquals(streamed.trace.released, plain.trace.released, "the hold released for the same reason");
    assertEquals(norm(streamed.trace.captured), norm(plain.trace.captured), "the same capture");
    assertEquals(norm(streamed.trace.rows), norm(plain.trace.rows), "the same app_errors rows, the wrapper's included");
    // The heartbeat is the ten seconds the live probe ran on.
    assertEquals(streamed.trace.intervals, [HEARTBEAT_MS]);
  });
}

Deno.test("every failure after the hold releases it once, streamed, with its retryable and its row; a draft captures", async () => {
  const want: Record<string, { release: string; retryable: boolean; code: string | null; status: number }> = {
    "every read timing out": { release: "model timeout", retryable: true, code: "ai_call_timeout", status: 504 },
    "every read cut off at max_tokens": { release: "reply truncated", retryable: true, code: "ai_spec_truncated", status: 502 },
    "every read unparseable": { release: "unparseable spec", retryable: false, code: "ai_spec_unparseable", status: 502 },
    "every read refused": { release: "model refused", retryable: false, code: "ai_spec_refused", status: 502 },
    "the API overloaded": { release: "upstream 529", retryable: false, code: "502", status: 502 },
    "the API unreachable": { release: "fetch failed", retryable: false, code: "502", status: 502 },
  };
  for (const [what, world] of SCENARIOS) {
    const w = want[what];
    if (!w) continue;
    const { trace, out } = await drive(STREAMED, world);
    const body = JSON.parse(out.text);
    assertEquals(body.status, w.status, what);
    assertEquals(body.retryable === true, w.retryable, `${what}: retryable`);
    assertEquals(trace.released, [w.release], `${what}: released once, for this reason`);
    assertEquals(trace.captured, [], `${what}: never captured`);
    // The coded row, or (uncoded) the wrapper's row, filed exactly once.
    assertEquals(trace.rows.filter((r) => r.code === w.code).length, 1, `${what}: ${w.code} filed once`);
    assertEquals(trace.rows.filter((r) => r.code === String(w.status)).length, w.code === String(w.status) ? 1 : 0, `${what}: the wrapper adds no copy of a coded row`);
  }
  // And a draft is captured once and released never.
  const ok = await drive(STREAMED, { model: THREE(GOOD()) });
  assertEquals(ok.trace.released, []);
  assertEquals(ok.trace.captured.length, 1);
});

Deno.test("a throw inside the streamed draft is filed as the wrapper files it, and answers a 500", async () => {
  const plain = await drive(V2, { throwOn: "client_settings" });
  const streamed = await drive(STREAMED, { throwOn: "client_settings" });
  assertEquals(plain.out.threw, "the client_settings read blew up", "unstreamed, the platform turns it into a 500");
  assertEquals(streamed.out.status, 200);
  assertEquals(JSON.parse(streamed.out.text), { error: "Internal Server Error", status: 500 });
  assertEquals(norm(streamed.trace.rows), norm(plain.trace.rows));
  assertEquals(streamed.trace.rows.map((r) => r.code), ["unhandled"]);
});

Deno.test("the 200 and a space go out before the model has answered", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const plan = { ...GOOD(), gate };
  await inWorld({ model: [plan, plan, plan] }, async (trace) => {
    const res = await HANDLER(request(STREAMED));
    assertEquals(res.status, 200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assertEquals(new TextDecoder().decode(first.value), " ");
    // The branch is still waiting on the model: the ledger row and the hold are in, the capture is not.
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(trace.sent.length, 3, "the three reads are out");
    assertEquals(trace.captured, [], "and nothing has been captured yet");
    open();
    let text = "";
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      text += new TextDecoder().decode(c.value);
    }
    assert(/^ *[{]"ok":true,/.test(text), text.slice(0, 40));
    assert(text.indexOf("{") > 0, "more beats came while the reads ran");
    assertEquals(trace.captured.length, 1);
  });
});

// ─── 5. Effort and budget ──────────────────────────────────────────────────────────────────────
Deno.test("effort high only on the streamed v2 draft; every other request as before", async () => {
  const s = await drive(STREAMED, { model: THREE(GOOD()) });
  assertEquals(s.trace.sent.map((b) => b.output_config.effort), ["high", "high", "high"]);
  assertEquals(s.trace.sent.map((b) => b.model), ["claude-opus-5", "claude-opus-5", "claude-opus-5"]);
  // Apart from the effort, the very request the plain v2 press sends.
  const p = await drive(V2, { model: THREE(GOOD()) });
  assertEquals(p.trace.sent.map((b) => b.output_config.effort), ["medium", "medium", "medium"]);
  assertEquals(s.trace.sent[0], { ...p.trace.sent[0], output_config: { effort: "high" } });
});

Deno.test("the budget: streamed min(230 s, 260 s - set-up), never under 60 s; plain as before", async () => {
  const cases: [Record<string, unknown>, number, number][] = [
    [STREAMED, 0, 230_000],
    [STREAMED, 20_000, 230_000],
    [STREAMED, 50_000, 210_000],
    [STREAMED, 230_000, 60_000],
    [V2, 0, 125_000],
    [V2, 50_000, 95_000],
    [V2, 100_000, 60_000],
  ];
  for (const [payload, setupMs, want] of cases) {
    const { trace } = await drive(payload, { model: THREE(GOOD()), setupMs });
    assertEquals(trace.timeouts.length, 1, "one deadline for all the reads");
    const got = trace.timeouts[0];
    // The set-up is measured on the real clock too, so a few milliseconds of it are real.
    assert(got <= want && got > want - 250, `${payload === STREAMED ? "streamed" : "plain"} after ${setupMs} ms of set-up: ${got}, want ${want}`);
  }
  // The formula itself, over the whole range, from the shipped declaration.
  const decl = lift(SOURCE, "const draftAbortMs =", ";\n", "the draft budget") + ";";
  const budget = (streamed: boolean, spent: number) =>
    new Function("t0", "requestStartMs", "streamed", `${decl}; return draftAbortMs;`)(1_000_000 + spent, 1_000_000, streamed) as number;
  for (let spent = 0; spent <= 300_000; spent += 1_000) {
    assertEquals(budget(true, spent), Math.max(60_000, Math.min(230_000, 260_000 - spent)), `streamed, ${spent}`);
    assertEquals(budget(false, spent), Math.max(60_000, Math.min(125_000, 145_000 - spent)), `plain, ${spent}`);
    // The whole streamed request ends by 260 s whenever the set-up left the model its floor.
    if (spent <= 200_000) assert(spent + budget(true, spent) <= 260_000, `streamed, ${spent}: inside 260 s`);
  }
});
