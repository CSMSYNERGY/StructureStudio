// The STREAMED v2 draft (2026-09-25), driven through the SHIPPED portal-settings handler.
//
// WHY THIS EXISTS. The gateway ends a request that is silent for 150 s, so the draft's model abort
// had to stop at 125 s, and at effort "high" all three consensus reads ran past it. The gateway
// times silence, not the request, so the new shell asks for `stream: true` and the server answers
// 200 at once, writes a space every ten seconds, then writes the JSON (heartbeatJson.ts); the draft
// gets 300 s and thinks at "high". That change is safe only if all of this holds, and each is pinned
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
//   5. Effort "high", 20000 tokens and the 300/330 s budget only on the streamed request, and
//      draft_tokens says which effort ran and whether it streamed. The budget also ends 75 s before
//      the WORKER does (2026-09-26): the platform's 400 s is a worker's life, not a request's.
//   6. The work behind the answer is handed to EdgeRuntime.waitUntil; a watchdog closes the answer at
//      DRAFT_STREAM_DEADLINE_MS, or 40 s before the worker's end if that is sooner, with
//      `stream_deadline` while the work runs on to its capture and ledger row; a browser that goes
//      away mid-stream changes nothing about the hold or the row; and a worker that shuts down with
//      streamed drafts in flight files one error row saying so (2026-09-26).
//   7. The press's key rides on its ledger row (253), and the frame map just before `drafted`, neither
//      able to fail a generation. calibrate_style_ai_recover: the generation's own gate, only the
//      caller's own rows found BY THE PRESS'S KEY (tenant, user, key, style), the success body rebuilt
//      from the key's newest row -- frame map and all -- and the money said from the press's own wallet
//      rows whenever the answer is not a recovered draft.
//   8. The new shell's half (it asks for the stream, reads a failure in the body exactly like a
//      non-2xx, and picks a dropped draft up) is aiDraftStreamShell_test.
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
import {
  aiDraftCostCents, DRAFT_RECOVER_PENDING_MS, DRAFT_RECOVER_SETTLE_MS, DRAFT_STREAM_DEADLINE_MS, EDGE_WALL_CLOCK_MS, parseKnownDims,
  SELF_CHECK_CLAIM_WINDOW_MS, streamedDraftBudgetMs, streamedDraftDeadlineMs, wantsStreamedDraft, wantsV2Prompt,
} from "../styleD3.ts";
import { HEARTBEAT_MS, STREAM_DEADLINE_BODY } from "../heartbeatJson.ts";

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
const MODULE = await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;
// When this "worker" was born: the module's own WORKER_BORN_MS, read when the import above evaluated
// it. A world's `workerAgeMs` moves the clock so its request arrives on a worker exactly that old.
const WORKER_BORN = (MODULE as { WORKER_BORN_MS?: unknown }).WORKER_BORN_MS;
if (typeof WORKER_BORN !== "number" || !Number.isFinite(WORKER_BORN)) throw new Error("portal-settings exports no WORKER_BORN_MS");

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
  workerAgeMs?: number;         // the request arrives on a worker this old (default: however long ago this file imported it)
  deadlineScale?: number;       // the answer's watchdog runs this many times faster (default 100)
  ledger?: Record<string, unknown>[];   // ai_style_calls rows the recover action can read
  recoverErr?: boolean;         // the recover action's ledger read errors
  wallet?: Record<string, unknown>[];   // wallet_transactions rows the recover action can read
  walletErr?: boolean;          // the recover action's wallet read errors
  noIdemColumn?: boolean;       // ai_style_calls has no idem_key column (253 not applied)
  frameMapFails?: "error" | "throw";    // the frame_map write errors, or throws
  member?: Record<string, unknown>;     // the caller's client_users row, over an owner's
};
type Trace = {
  db: unknown[];                // every awaited table op and rpc, in order
  released: string[];
  captured: unknown[];
  rows: Record<string, unknown>[];   // app_errors
  sent: any[];                  // Anthropic request bodies
  timeouts: number[];           // AbortSignal.timeout(ms)
  intervals: number[];          // setInterval(ms)
  deadlines: number[];          // the watchdog's setTimeout(ms), before scaling
  kept: Promise<unknown>[];     // what was handed to EdgeRuntime.waitUntil
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
  if (target === "client_users") return { data: [{ client_id: "harness-tenant", role: "owner", title: null, access: null, ...(world.member ?? {}) }], error: null };
  if (target === "client_settings") return { data: world.cap === undefined ? null : { ai_style_daily_cap: world.cap }, error: null };
  if (target === "ai_style_calls") {
    if (has("select") && (arg("select") === "id") && ops.some((o) => o[0] === "select" && o[2] && o[2].head)) return { count: world.used ?? 0, error: null };
    // The recover action's read: a real filter over world.ledger, so what it returns is decided by
    // the filters the handler actually put on the query, and nothing else.
    if (has("select") && has("in")) {
      if (world.recoverErr) return { data: null, error: { message: "the ledger read timed out" } };
      return { data: filtered(world.ledger ?? [], ops), error: null };
    }
    if (has("insert")) {
      // PostgREST refuses the WHOLE insert when one key names a column it does not have (PGRST204).
      if (world.noIdemColumn && "idem_key" in (arg("insert") ?? {})) {
        return { data: null, error: { code: "PGRST204", message: "Could not find the 'idem_key' column of 'ai_style_calls' in the schema cache" } };
      }
      return world.ledgerFails ? { data: null, error: { message: "the ledger is gone" } } : { data: { id: LEDGER_ID }, error: null };
    }
    if (has("update") && "frame_map" in (arg("update") ?? {})) {
      if (world.frameMapFails === "throw") throw new TypeError("the frame_map write blew up");
      if (world.frameMapFails === "error") return { data: null, error: { code: "PGRST204", message: "Could not find the 'frame_map' column of 'ai_style_calls' in the schema cache" } };
    }
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
  if (target === "wallet_transactions") {
    // Only the recover action reads it (the wallet RPCs are rpc:... below): the same real filter.
    if (world.walletErr) return { data: null, error: { message: "the wallet read timed out" } };
    return { data: filtered(world.wallet ?? [], ops), error: null };
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

// A read over rows, by exactly the filters the handler put on its query, then its column list.
function filtered(rows: Record<string, unknown>[], ops: any[][]) {
  let out = [...rows];
  for (const o of ops) {
    if (o[0] === "eq") out = out.filter((r) => r[o[1]] === o[2]);
    if (o[0] === "in") out = out.filter((r) => (o[2] as unknown[]).includes(r[o[1]]));
    if (o[0] === "gte") out = out.filter((r) => Date.parse(String(r[o[1]])) >= Date.parse(String(o[2])));
    if (o[0] === "order") out.sort((a, b) => (Date.parse(String(a[o[1]])) - Date.parse(String(b[o[1]]))) * (o[2] && o[2].ascending === false ? -1 : 1));
    if (o[0] === "limit") out = out.slice(0, o[1]);
  }
  const cols = String((ops.find((o) => o[0] === "select") ?? [])[1]).split(",").map((c) => c.trim());
  return out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
}

function chain(world: World, trace: Trace, target: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, target, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "gt", "gte", "lt", "is", "in", "limit", "order", "single", "maybeSingle"]) {
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
  const trace: Trace = { db: [], released: [], captured: [], rows: [], sent: [], timeouts: [], intervals: [], deadlines: [], kept: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  if (world.noKey) Deno.env.delete("ANTHROPIC_API_KEY");
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const timers: ReturnType<typeof setTimeout>[] = [];
  // The Supabase runtime's waitUntil, which Deno's runner does not have: what the heartbeat asks it
  // to keep alive is kept here, so a test can wait for the work behind an answer nobody read.
  (globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => { trace.kept.push(p); } };
  // The answer's watchdog (DRAFT_STREAM_DEADLINE_MS, minutes): a hundred times faster by default, so
  // 360 s is 3.6 s here and no fast test meets it; the watchdog's own test runs it faster still.
  // Every timer of 100 s or more is the watchdog: on a worker 199 s old it is armed at 161 s, and
  // nothing else on the draft's path sets one that long (the consensus grace is 60 s).
  (globalThis as any).setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if (typeof ms === "number" && ms >= 100_000) {
      trace.deadlines.push(ms);
      return realSetTimeout(fn, Math.max(1, Math.round(ms / (world.deadlineScale ?? 100))), ...rest);
    }
    return realSetTimeout(fn, ms, ...rest);
  };
  stubAuth.user = { id: "00000000-0000-4000-8000-000000000001", email: "harness@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => {
    if (world.throwOn === table) throw new TypeError(`the ${table} read blew up`);
    return chain(world, trace, table, []);
  };
  stubRpc.rpc = (fn: string, args?: unknown) => chain(world, trace, `rpc:${fn}`, [["args", args]]);
  clock.offset = 0;
  // A worker of a chosen age: the clock moved so the request arrives WORKER_BORN + workerAgeMs.
  if (world.workerAgeMs !== undefined) clock.offset = (WORKER_BORN as number) + world.workerAgeMs - realNow();
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
    // The work behind an answer nobody finished reading runs on (heartbeatJson); the world stays up
    // until it has settled, as the runtime's waitUntil would keep the worker up for it.
    await Promise.allSettled(trace.kept);
    return { trace, out };
  } finally {
    for (const t of timers) clearTimeout(t);
    globalThis.fetch = realFetch;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: realTimeout });
    (globalThis as any).setInterval = realSetInterval;
    (globalThis as any).setTimeout = realSetTimeout;
    delete (globalThis as any).EdgeRuntime;
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

// The ledger's usage write with its `effort` and `streamed` checked against what the request should
// have recorded and then taken out, so a streamed trace can be compared with a plain one on
// everything else. A write without the two keys (a null: no reply) is left as it is.
function howItRan(db: unknown[], want: { effort: string; streamed: boolean }): unknown[] {
  return db.map((op) => {
    if (!Array.isArray(op) || op[0] !== "ai_style_calls") return op;
    return op.map((step) => {
      if (!Array.isArray(step) || step[0] !== "update") return step;
      const row = step[1] as Record<string, any>;
      const tok = row && row.draft_tokens;
      if (!tok || typeof tok !== "object") return step;
      assertEquals({ effort: tok.effort, streamed: tok.streamed }, want, "draft_tokens says how the draft ran");
      const { effort: _e, streamed: _s, ...rest } = tok;
      return ["update", { ...row, draft_tokens: rest }, ...step.slice(2)];
    });
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
  const open = "): Promise<Response> | Response {";
  assert(fn.includes(open), "draftAnswer's signature");
  const body = fn.slice(fn.indexOf(open) + open.length).split("\n").map((l) => l.trim()).filter(Boolean);
  assertEquals(body[0], "if (!wantsStreamedDraft(payload)) return work(false);", "the first thing it does");
  // And `streamed` changes exactly these things inside the branch: the effort (draftEffort, which the
  // request sends and draft_tokens records beside `streamed`), the budget, and the room to think in.
  const BRANCH = lift(SOURCE, 'if (action === "calibrate_style_ai") return await draftAnswer(', "// ── THE FREE SECOND PASS", "the branch");
  const uses = BRANCH.split("\n").filter((l) => /\bstreamed\b/.test(l) && !l.trim().startsWith("//")).map((l) => l.trim());
  assertEquals(uses, [
    'if (action === "calibrate_style_ai") return await draftAnswer(req, payload, { requestStartMs, clientId }, async (streamed: boolean): Promise<Response> => {',
    'const draftEffort = lean ? "low" : streamed ? "high" : "medium";',
    "const draftAbortMs = streamed",
    '.update({ draft_tokens: tokens ? { ...tokens, effort: draftEffort, streamed } : tokens, draft_ms: Date.now() - t0 }).eq("id", ledgerRow.id);',
    "max_tokens: streamed ? 20000 : 12000,",
  ]);
  const effortUses = BRANCH.split("\n").filter((l) => /\bdraftEffort\b/.test(l) && !l.trim().startsWith("//")).map((l) => l.trim());
  assertEquals(effortUses, [
    'const draftEffort = lean ? "low" : streamed ? "high" : "medium";',
    '.update({ draft_tokens: tokens ? { ...tokens, effort: draftEffort, streamed } : tokens, draft_ms: Date.now() - t0 }).eq("id", ledgerRow.id);',
    "output_config: { effort: draftEffort },",
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
    // Everything around the answer, in the same order -- but for the two keys draft_tokens carries to
    // say how the draft ran (2026-09-25), which are checked on their own right after.
    assertEquals(norm(howItRan(streamed.trace.db, { effort: "high", streamed: true })), norm(howItRan(plain.trace.db, { effort: "medium", streamed: false })), "the same database work, in the same order");
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
Deno.test("effort high and 20000 tokens only on the streamed v2 draft; every other request as before", async () => {
  const s = await drive(STREAMED, { model: THREE(GOOD()) });
  assertEquals(s.trace.sent.map((b) => b.output_config.effort), ["high", "high", "high"]);
  assertEquals(s.trace.sent.map((b) => b.max_tokens), [20000, 20000, 20000]);
  assertEquals(s.trace.sent.map((b) => b.model), ["claude-opus-5", "claude-opus-5", "claude-opus-5"]);
  // Apart from the effort and the room to think in, the very request the plain v2 press sends.
  const p = await drive(V2, { model: THREE(GOOD()) });
  assertEquals(p.trace.sent.map((b) => b.output_config.effort), ["medium", "medium", "medium"]);
  assertEquals(p.trace.sent.map((b) => b.max_tokens), [12000, 12000, 12000]);
  assertEquals(s.trace.sent[0], { ...p.trace.sent[0], max_tokens: 20000, output_config: { effort: "high" } });
  // Every request that does not stream keeps 12000: the lean retry, and production's older shell.
  for (const payload of [{ ...STREAMED, lean: true }, { ...STREAMED, frame: undefined }] as Record<string, unknown>[]) {
    const o = await drive(payload, { model: THREE(GOOD()) });
    assertEquals(o.trace.sent.map((b) => b.max_tokens), [12000], JSON.stringify({ lean: payload.lean, frame: payload.frame }));
  }
  // And the ledger says which: draft_tokens.effort and .streamed, at the top of the object.
  const usage = (t: Trace) => (t.db.filter((op: any) => op[0] === "ai_style_calls" && op[1][0] === "update" && op[1][1] && "draft_tokens" in op[1][1]) as any[])
    .map((op) => ({ effort: op[1][1].draft_tokens.effort, streamed: op[1][1].draft_tokens.streamed }));
  assertEquals(usage(s.trace), [{ effort: "high", streamed: true }]);
  assertEquals(usage(p.trace), [{ effort: "medium", streamed: false }]);
});

Deno.test("20000 tokens cannot make a streamed press cost more than its price: three full reads, at list price", () => {
  // aiDraftCostCents is our cost basis (never the builder's price, which is the held $20). Three reads
  // at a generous 21,000 input tokens each, all three spending all 20000: under $2, a tenth of the price.
  const worst = aiDraftCostCents(true, 3 * 21_000, 3 * 20_000);
  assertEquals(worst, 181.5);
  assert(worst < 2000 / 10, `${worst} cents`);
});

Deno.test("the budget: streamed min(300 s, 330 s - set-up, 75 s before the worker's end), never under 60 s; plain as before", async () => {
  // [payload, set-up, the worker's age when the request arrives, the budget]
  const cases: [Record<string, unknown>, number, number, number][] = [
    // A fresh worker: the rule of 2026-09-25 while the set-up is under 25 s...
    [STREAMED, 0, 0, 300_000],
    [STREAMED, 20_000, 0, 300_000],
    // ...and past that the worker's end, 5 s before the request's 330 s (the worker was born first).
    [STREAMED, 50_000, 0, 275_000],
    [STREAMED, 100_000, 0, 225_000],
    [STREAMED, 300_000, 0, 60_000],
    // A warm worker: its end decides.
    [STREAMED, 3_000, 30_000, 292_000],
    [STREAMED, 3_000, 150_000, 172_000],
    [STREAMED, 30_000, 199_000, 96_000],
    // A request that does not stream keeps the gateway's rule, whatever the worker's age.
    [V2, 0, 0, 125_000],
    [V2, 50_000, 0, 95_000],
    [V2, 100_000, 0, 60_000],
    [V2, 0, 199_000, 125_000],
  ];
  for (const [payload, setupMs, workerAgeMs, want] of cases) {
    const { trace } = await drive(payload, { model: THREE(GOOD()), setupMs, workerAgeMs });
    assertEquals(trace.timeouts.length, 1, "one deadline for all the reads");
    const got = trace.timeouts[0];
    // The set-up is measured on the real clock too, so a few milliseconds of it are real.
    assert(got <= want && got > want - 250, `${payload === STREAMED ? "streamed" : "plain"} after ${setupMs} ms of set-up on a worker ${workerAgeMs} ms old: ${got}, want ${want}`);
  }
  // WIRED: the streamed arm is the helper, handed the branch's own clocks and this worker's birth;
  // the arm every other request gets is the gateway's rule, character for character as it was.
  const decl = lift(SOURCE, "const draftAbortMs =", ";\n", "the draft budget") + ";";
  assertEquals(decl.split("\n").map((l) => l.trim()), [
    "const draftAbortMs = streamed",
    "? streamedDraftBudgetMs({ t0, requestStartMs, workerBornMs: WORKER_BORN_MS })",
    ": Math.max(60_000, Math.min(125_000, 145_000 - (t0 - requestStartMs)));",
  ]);
  // The formula itself, over set-ups and worker ages, from the shipped declaration and helper.
  const run = new Function("t0", "requestStartMs", "streamed", "streamedDraftBudgetMs", "WORKER_BORN_MS", `${decl}; return draftAbortMs;`);
  const budget = (streamed: boolean, spent: number, age = 0) =>
    run(1_000_000 + spent, 1_000_000, streamed, streamedDraftBudgetMs, 1_000_000 - age) as number;
  for (let spent = 0; spent <= 360_000; spent += 1_000) {
    for (const age of [0, 50_000, 150_000, 199_000]) {
      assertEquals(budget(true, spent, age), Math.max(60_000, Math.min(300_000, 330_000 - spent, 325_000 - age - spent)), `streamed, ${spent}, worker ${age}`);
      assertEquals(budget(false, spent, age), Math.max(60_000, Math.min(125_000, 145_000 - spent)), `plain, ${spent}, worker ${age}`);
    }
    // The whole streamed request ends by 325 s on a fresh worker whenever the set-up left the model
    // more than its floor.
    if (spent <= 265_000) assert(spent + budget(true, spent) <= 325_000, `streamed, ${spent}: inside 325 s`);
  }
  // THE ANSWER'S OWN DEADLINE sits after the reads' and below the worker's wall clock: on a fresh
  // worker the reads end by 325 s, the answer closes at DRAFT_STREAM_DEADLINE_MS, which leaves 30 s
  // or more for the capture and the ledger write, and the worker's 400 s is the hard stop above both.
  // The invariants below sweep every age a worker can be when a request lands on it.
  assertEquals(DRAFT_STREAM_DEADLINE_MS, 360_000);
  assert(DRAFT_STREAM_DEADLINE_MS - 330_000 >= 30_000 && DRAFT_STREAM_DEADLINE_MS < 400_000);
});

// ⚠️ THE STREAMED CLOCKS' INVARIANTS (2026-09-25, when the reads went from 230 s to 300 s; rewritten
// 2026-09-26, when the platform's 400 s turned out to be a WORKER's life and not a request's), read off
// the shipped declarations rather than restated, so a change to any one of them that breaks the chain
// fails here. Live on 2026-09-25 Opus streamed ~70 output tokens/s, and 8 presses in 12 had a read cut
// at the old 230 s: the budget exists to let a whole read finish, and everything after it (the
// capture, the ledger write, the answer) has to fit before the platform ends the worker. A worker is
// ended 400 s after its birth, in flight or not, and takes new requests until it is 200 s old, so a
// request that lands on a worker A seconds old is ended 400 - A seconds after it arrived. Over every
// such age (0-199 s) and every ordinary set-up (0-30 s; the slowest step, the auto top-up, stops at
// 30 s):
//   * the reads end at least 30 s before the answer's watchdog (the capture and the ledger write);
//   * the watchdog fires at least 30 s before the worker's end, so the answer is always a whole body;
//   * the reads never get more than 300 s, and the 60 s floor never decides;
//   * on a fresh worker after an ordinary 3 s set-up they get all 300 s, the fast path unchanged;
//   * the reads always end by 330 s after the request, so a healthy draft stays pending for a pickup;
//   * a read that spends the whole of the streamed max_tokens at 70 tokens/s ends inside that 300 s.
const MEASURED_OPUS_TOKENS_PER_S = 70;
Deno.test("⚠️ the streamed clocks' invariants, worker 0-199 s old, set-up 0-30 s: reads + 30 s <= watchdog, watchdog + 30 s <= the worker's end, reads <= 300 s", () => {
  const decl = lift(SOURCE, "const draftAbortMs =", ";\n", "the draft budget") + ";";
  const runBudget = new Function("t0", "requestStartMs", "streamed", "streamedDraftBudgetMs", "WORKER_BORN_MS", `${decl}; return draftAbortMs;`);
  const arm = lift(lift(SOURCE, "function draftAnswer(", "\n}\n", "draftAnswer"), "deadlineMs:", ",\n", "the watchdog's deadline");
  const runDeadline = new Function("streamedDraftDeadlineMs", "Date", "at", "WORKER_BORN_MS", `return ({ ${arm} }).deadlineMs;`);
  // Every time below is in ms from the request's arrival; the worker was born `age` before it.
  const REQ = 1_000_000;
  const budget = (age: number, setup: number) =>
    runBudget(REQ + setup, REQ, true, streamedDraftBudgetMs, REQ - age) as number;
  // draftAnswer arms the watchdog as the request is dispatched, a moment after it arrived.
  const watchdogAt = (age: number, armedAfter: number) =>
    armedAfter + (runDeadline(streamedDraftDeadlineMs, { now: () => REQ + armedAfter }, { requestStartMs: REQ }, REQ - age) as number);
  assertEquals(EDGE_WALL_CLOCK_MS, 400_000, "a worker's wall clock on the paid plan");
  let latestReads = 0;
  for (let age = 0; age < 200_000; age += 1_000) {
    const workerEnd = EDGE_WALL_CLOCK_MS - age;
    for (const armedAfter of [0, 1_000]) {
      const dog = watchdogAt(age, armedAfter);
      assert(dog + 30_000 <= workerEnd, `worker ${age}: the watchdog at ${dog} is not 30 s before the worker's end at ${workerEnd}`);
      for (let setup = 0; setup <= 30_000; setup += 1_000) {
        const b = budget(age, setup);
        const readsEnd = setup + b;
        latestReads = Math.max(latestReads, readsEnd);
        assert(readsEnd + 30_000 <= dog, `worker ${age}, set-up ${setup}: the reads end at ${readsEnd}, not 30 s before the watchdog at ${dog}`);
        assert(b <= 300_000, `worker ${age}, set-up ${setup}: a budget of ${b}`);
        assert(b > 60_000, `worker ${age}, set-up ${setup}: the 60 s floor decided`);
      }
    }
  }
  assertEquals(budget(0, 3_000), 300_000, "a fresh worker after an ordinary set-up: all 300 s, as before");
  assert(latestReads <= 330_000, `the streamed reads end by 330 s after the request: ${latestReads}`);
  // A healthy draft whose reads ran to the end is still pending for a pickup, never lost as stale.
  assert(latestReads < DRAFT_RECOVER_PENDING_MS && DRAFT_RECOVER_PENDING_MS <= EDGE_WALL_CLOCK_MS, String(DRAFT_RECOVER_PENDING_MS));
  const line = SOURCE.split("\n").find((l) => l.includes("max_tokens: streamed ?")) ?? "";
  assertEquals(line.trim(), "max_tokens: streamed ? 20000 : 12000,");
  const maxTokens = new Function("streamed", `return {${line.trim()}}.max_tokens;`)(true) as number;
  const fullReadMs = (maxTokens / MEASURED_OPUS_TOKENS_PER_S) * 1000;
  assert(fullReadMs <= budget(0, 3_000), `${maxTokens} tokens at ${MEASURED_OPUS_TOKENS_PER_S}/s is ${Math.round(fullReadMs)} ms, over ${budget(0, 3_000)}`);
});

// ─── 6. The work behind the answer: waitUntil, the watchdog, a caller that goes away ───────────
Deno.test("draftAnswer arms the watchdog from the request AND this worker's birth, read once at module scope", () => {
  const fn = lift(SOURCE, "function draftAnswer(", "\n}\n", "draftAnswer");
  assertEquals(fn.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("deadlineMs:")), [
    "deadlineMs: streamedDraftDeadlineMs({ now: Date.now(), requestStartMs: at.requestStartMs, workerBornMs: WORKER_BORN_MS }),",
  ]);
  // One declaration, at module scope (column 0, outside every function), read when the worker
  // evaluates the module, and a const: nothing sets it again.
  assertEquals(SOURCE.split("\n").filter((l) => /\bWORKER_BORN_MS\s*=[^=]/.test(l)), ["export const WORKER_BORN_MS = Date.now();"]);
  assert(SOURCE.indexOf("export const WORKER_BORN_MS = Date.now();") < SOURCE.indexOf("Deno.serve("), "declared before the handler");
});

Deno.test("a streamed draft's work is handed to EdgeRuntime.waitUntil and watched by a deadline; a plain one's is not", async () => {
  const s = await drive(STREAMED, { model: THREE(GOOD()), workerAgeMs: 0 });
  assertEquals(s.trace.kept.length, 1, "the work behind the answer, once");
  assertEquals(s.trace.deadlines.length, 1, "one watchdog");
  assert(s.trace.deadlines[0] <= DRAFT_STREAM_DEADLINE_MS && s.trace.deadlines[0] > DRAFT_STREAM_DEADLINE_MS - 1_000,
    `armed at the deadline measured from the request: ${s.trace.deadlines[0]}`);
  assertEquals(s.trace.rows, [], "a draft that answered in time files nothing");
  const p = await drive(V2, { model: THREE(GOOD()) });
  assertEquals(p.trace.kept.length, 0, "a plain request answers with its own Response");
  assertEquals(p.trace.deadlines, []);
  // On a warm worker the watchdog is armed 40 s before the worker's end: 360 s less its age.
  for (const age of [30_000, 150_000, 199_000]) {
    const w = await drive(STREAMED, { model: THREE(GOOD()), workerAgeMs: age });
    const want = streamedDraftDeadlineMs({ now: WORKER_BORN + age, requestStartMs: WORKER_BORN + age, workerBornMs: WORKER_BORN });
    assertEquals(want, DRAFT_STREAM_DEADLINE_MS - age);
    assertEquals(w.trace.deadlines.length, 1, `worker ${age}: one watchdog`);
    assert(w.trace.deadlines[0] <= want && w.trace.deadlines[0] > want - 1_000, `worker ${age}: armed at ${w.trace.deadlines[0]}, want ${want}`);
    assertEquals(w.trace.rows, [], `worker ${age}: a draft that answered in time files nothing`);
  }
});

Deno.test("the watchdog: a draft still working at the deadline is answered stream_deadline, and the work runs on to its capture and its ledger row", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const plan = { ...GOOD(), gate };
  // A thousand times faster: the 360 s deadline is 360 ms here, and the reads' own abort is later.
  await inWorld({ model: [plan, plan, plan], deadlineScale: 1_000, abortAfterMs: 5_000, workerAgeMs: 0 }, async (trace) => {
    const res = await HANDLER(request(STREAMED));
    assertEquals(res.status, 200);
    const text = await res.text();
    assert(/^ +[{]/.test(text), "the heartbeat, then the watchdog's body");
    assertEquals(text.trimStart(), STREAM_DEADLINE_BODY);
    const body = JSON.parse(text);
    assertEquals([body.code, body.status, "retryable" in body], ["stream_deadline", 504, false], "not retryable: the work may still charge");
    assertEquals(trace.captured, [], "the reads were still out when the answer closed");
    assertEquals(trace.rows.map((r) => [r.code, r.severity]), [["ai_draft_stream_deadline", "error"]], "one coded row for the hang");
    // The reads come back after the answer has gone. Nobody is reading; the work finishes anyway.
    open();
    await Promise.allSettled(trace.kept);
    assertEquals(trace.captured.length, 1, "captured exactly once");
    assertEquals(trace.released, [], "and never released");
    const drafted = trace.db.filter((op: any) => op[0] === "ai_style_calls" && op[1][0] === "update" && op[1][1] && op[1][1].drafted);
    assertEquals(drafted.length, 1, "the ledger row got its draft: that is where the browser picks it up");
    assertEquals(trace.rows.map((r) => r.code), ["ai_draft_stream_deadline"], "and no other row");
  });
});

// A browser that goes away mid-stream (a closed tab, a phone that put it to sleep): the body is
// cancelled after its first space, the model answers afterwards, and the work settles the hold
// exactly once and writes the ledger exactly as it would have for a browser that stayed.
const DISCONNECTS: [string, ModelPlan, { captured: number; released: string[]; drafted: number; codes: string[] }][] = [
  ["the reads draft", GOOD(), { captured: 1, released: [], drafted: 1, codes: [] }],
  ["every read is cut off", TRUNCATED, { captured: 0, released: ["reply truncated"], drafted: 0, codes: ["ai_spec_truncated"] }],
];
for (const [what, base, want] of DISCONNECTS) {
  Deno.test(`the browser goes away mid-stream and ${what}: the work runs on and settles the hold exactly once`, async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const plan = { ...base, gate };
    await inWorld({ model: [plan, plan, plan] }, async (trace) => {
      const res = await HANDLER(request(STREAMED));
      const reader = res.body!.getReader();
      const first = await reader.read();
      assertEquals(new TextDecoder().decode(first.value), " ", "the first space arrived");
      // Gone at once, before the work has even sent its reads.
      await reader.cancel("the phone put the tab to sleep");
      assertEquals(trace.kept.length, 1, "the work is the one thing kept alive");
      // The work carries on with nobody listening: its reads go out, and wait on the model.
      for (let i = 0; i < 200 && trace.sent.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
      assertEquals(trace.sent.length, 3, "the reads went out after the browser had gone");
      assertEquals([trace.captured.length, trace.released.length], [0, 0], "nothing settled yet");
      open();
      await Promise.allSettled(trace.kept);
      assertEquals(trace.captured.length, want.captured, "captures");
      assertEquals(trace.released, want.released, "releases");
      assertEquals(trace.captured.length + trace.released.length, 1, "the hold settled exactly once");
      const ledger = trace.db.filter((op: any) => op[0] === "ai_style_calls" && op[1][0] === "update") as any[];
      assertEquals(ledger.filter((op) => op[1][1].drafted).length, want.drafted, "the draft on the ledger row");
      const usage = ledger.filter((op) => "draft_tokens" in op[1][1]);
      assertEquals(usage.length, 1, "the usage written once");
      assertEquals([usage[0][1][1].draft_tokens.effort, usage[0][1][1].draft_tokens.streamed], ["high", true]);
      assertEquals(trace.rows.map((r) => r.code), want.codes, "the app_errors rows a browser that stayed would have seen");
    });
  });
}

// A worker that shuts down under a streamed draft (2026-09-26): the runtime's `beforeunload` files ONE
// error row, with the reason, how many drafts were in flight and the worker's age, and prints the same
// line to the function's log. An ordinary shutdown, with nothing in flight, files and prints nothing,
// and so does one after every draft has settled, however it settled.
const SHUTDOWN = "worker_shutdown_mid_draft";
async function shutdown(detail: unknown) {
  globalThis.dispatchEvent(new CustomEvent("beforeunload", { detail }));
  // The row is fire-and-forget: let its insert land.
  await new Promise((r) => setTimeout(r, 20));
}
Deno.test("a worker shutting down under streamed drafts files ONE error row (reason, inFlight, workerAgeMs); with none in flight, nothing", async () => {
  const printed: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { printed.push(a.map(String).join(" ")); };
  try {
    // Nothing in flight: an ordinary shutdown.
    await inWorld({}, async (trace) => {
      await shutdown({ reason: "early_drop" });
      assertEquals(trace.rows, [], "no row");
    });
    assertEquals(printed.filter((l) => l.includes(SHUTDOWN)), [], "and no line");
    // Two streamed drafts on a worker 100 s old, their reads out, then the wall clock's notice.
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const plan = { ...GOOD(), gate };
    await inWorld({ model: Array(6).fill(plan), workerAgeMs: 100_000 }, async (trace) => {
      const a = await HANDLER(request(STREAMED));
      const b = await HANDLER(request({ ...STREAMED, idempotencyKey: "press-2" }));
      for (let i = 0; i < 400 && trace.sent.length < 6; i++) await new Promise((r) => setTimeout(r, 5));
      assertEquals(trace.sent.length, 6, "both drafts' reads are out");
      await shutdown({ reason: "wall_clock" });
      const rows = trace.rows.filter((r) => r.code === SHUTDOWN);
      assertEquals(rows.length, 1, "one row, however many drafts are in flight");
      const ctx = rows[0].context as Record<string, unknown>;
      assertEquals([rows[0].severity, ctx.reason, ctx.inFlight], ["error", "wall_clock", 2]);
      assert(typeof ctx.workerAgeMs === "number" && ctx.workerAgeMs >= 100_000 && ctx.workerAgeMs < 105_000, `the worker's age: ${ctx.workerAgeMs}`);
      assertEquals(Object.keys(ctx), ["reason", "inFlight", "workerAgeMs"]);
      const lines = printed.filter((l) => l.includes(SHUTDOWN));
      assertEquals(lines.length, 1, "and one line in the function's log");
      assertEquals(JSON.parse(lines[0].slice(lines[0].indexOf("{"))), ctx, "saying the same");
      // The runtime's type declaration has the reason as `detail` itself: read either way.
      await shutdown("memory");
      const again = trace.rows.filter((r) => r.code === SHUTDOWN);
      assertEquals(again.length, 2, "one row per notice");
      assertEquals([(again[1].context as any).reason, (again[1].context as any).inFlight], ["memory", 2]);
      // The drafts settle: nothing is in flight any more.
      open();
      await a.text();
      await b.text();
      await Promise.allSettled(trace.kept);
      await shutdown({ reason: "wall_clock" });
      assertEquals(trace.rows.filter((r) => r.code === SHUTDOWN).length, 2, "no row once both settled");
    });
    // A draft that THROWS settles too: it is counted out, and a later shutdown files nothing.
    await inWorld({ throwOn: "client_settings" }, async (trace) => {
      const res = await HANDLER(request(STREAMED));
      assertEquals(JSON.parse(await res.text()).status, 500);
      await Promise.allSettled(trace.kept);
      await shutdown({ reason: "wall_clock" });
      assertEquals(trace.rows.filter((r) => r.code === SHUTDOWN), [], "a thrown draft is not in flight");
    });
    // A draft that does not stream is never counted: it has no answer to cut off behind a 200.
    let openPlain!: () => void;
    const plainGate = new Promise<void>((r) => { openPlain = r; });
    const plainPlan = { ...GOOD(), gate: plainGate };
    await inWorld({ model: Array(3).fill(plainPlan) }, async (trace) => {
      const pending = HANDLER(request(V2));
      for (let i = 0; i < 400 && trace.sent.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
      assertEquals(trace.sent.length, 3, "the plain draft's reads are out");
      await shutdown({ reason: "wall_clock" });
      assertEquals(trace.rows.filter((r) => r.code === SHUTDOWN), [], "not counted");
      openPlain();
      const res = await pending;
      assertEquals(res.status, 200);
      assert((await res.text()).startsWith('{"ok":true,'), "its own answer, as before");
    });
  } finally {
    console.error = realError;
  }
});

// ─── 7. The press's key on its row, and picking the draft up by it (calibrate_style_ai_recover) ─
const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";
const KEY = "press-1";          // STREAMED's own idempotencyKey
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const RECOVER = (o: Record<string, unknown> = {}) => ({ action: "calibrate_style_ai_recover", styleValue: "barn", idempotencyKey: KEY, ...o });
const ROW = (o: Record<string, unknown> = {}) => ({
  id: LEDGER_ID, client_id: "harness-tenant", user_id: USER_ID, idem_key: KEY, style_key: "barn", source: "video",
  called_at: ago(30_000), drafted: null, observed: null, frames: 12, video_count: 12, dims: DIMS,
  draft_ms: null, frame_map: null, charged_cents: null, ...o,
});
const TX = (o: Record<string, unknown> = {}) => ({
  client_id: "harness-tenant", idempotency_key: KEY, actor_user_id: USER_ID, meter_kind: "video_3d_generation",
  kind: "debit", state: "held", posted_at: null, ...o,
});
const NOT_CHARGED = "We could not pick the draft up from the server: that generation did not finish, so you are not charged for it. Press Generate to try again.";
const inserts = (t: Trace) => (t.db.filter((op: any) => op[0] === "ai_style_calls" && op[1][0] === "insert") as any[]).map((op) => op[1][1]);
const ledgerUpdates = (t: Trace) => (t.db.filter((op: any) => op[0] === "ai_style_calls" && op[1][0] === "update") as any[]).map((op) => op[1][1]);
const walletReads = (t: Trace) => t.db.filter((op: any) => op[0] === "wallet_transactions");
const holdIdem = (t: Trace) => ((t.db.find((op: any) => op[0] === "rpc:wallet_hold") ?? []) as any[])[1]?.[1]?.p_idem;
const rowsOf = (t: Trace) => t.rows.map((r) => [r.code, r.severity]);

// One real streamed draft: its answer, and what it wrote onto its ledger row (through a jsonb round trip).
let liveRun: { answer: Record<string, unknown>; wrote: Record<string, any> } | null = null;
async function live() {
  if (liveRun) return liveRun;
  const s = await drive(STREAMED, { model: [GOOD({ centerEaveFt: 15 }), GOOD({ centerEaveFt: 13 }), GOOD({ centerEaveFt: 14 })] });
  liveRun = { answer: JSON.parse(s.out.text), wrote: JSON.parse(JSON.stringify(Object.assign({}, ...ledgerUpdates(s.trace)))) };
  return liveRun;
}

Deno.test("the press's key rides on its ledger row: the same key wallet_hold files the hold under, and a keyless press inserts what it always did", async () => {
  for (const payload of [STREAMED, V2] as Record<string, unknown>[]) {
    const { trace, out } = await drive(payload, { model: THREE(GOOD()) });
    assert(/"ok":true/.test(out.text), "a draft");
    assertEquals(inserts(trace), [{ client_id: "harness-tenant", user_id: USER_ID, style_key: "barn", source: "video", idem_key: KEY }]);
    assertEquals(holdIdem(trace), KEY, "the key the hold is filed under is the key on the row");
  }
  // One cut for both: a key past 120 characters is cut the same way on the row and on the hold.
  const long = "k".repeat(150);
  const cut = await drive({ ...STREAMED, idempotencyKey: long }, { model: THREE(GOOD()) });
  assertEquals(inserts(cut.trace)[0].idem_key, "k".repeat(120));
  assertEquals(holdIdem(cut.trace), "k".repeat(120));
  // No key (an older caller): exactly the object the insert has always written, and no null key.
  const keyless = await drive({ ...V2, idempotencyKey: undefined }, { model: THREE(GOOD()) });
  assertEquals(inserts(keyless.trace), [{ client_id: "harness-tenant", user_id: USER_ID, style_key: "barn", source: "video" }]);
  assertEquals(Object.keys(inserts(keyless.trace)[0]), ["client_id", "user_id", "style_key", "source"], "the same keys in the same order as before 253");
  assertEquals(holdIdem(keyless.trace), null);
});

Deno.test("⚠️ a missing idem_key column never fails a generation: the insert is retried without it, with one info row", async () => {
  for (const payload of [STREAMED, V2] as Record<string, unknown>[]) {
    const { trace, out } = await drive(payload, { model: THREE(GOOD()), noIdemColumn: true });
    const body = JSON.parse(out.text.trimStart());
    assertEquals([body.ok, body.checkId], [true, LEDGER_ID], `${payload.stream ? "streamed" : "plain"}: the draft, on the row the retry wrote`);
    assertEquals(inserts(trace), [
      { client_id: "harness-tenant", user_id: USER_ID, style_key: "barn", source: "video", idem_key: KEY },
      { client_id: "harness-tenant", user_id: USER_ID, style_key: "barn", source: "video" },
    ], "tried with the key, then once without");
    assertEquals(rowsOf(trace), [["ai_style_idem_key_write_failed", "info"]], "one info row, and nothing filed as a fault");
    assert(/253/.test(String(trace.rows[0].message)), "naming the migration");
    assertEquals(holdIdem(trace), KEY, "the hold still carries the key");
    assertEquals(trace.captured.length, 1, "and the press went on to its capture");
  }
  // A ledger that is really down fails the retry too, and refuses exactly as before: a 503, no hold.
  const down = await drive(V2, { ledgerFails: true });
  assertEquals(down.out.status, 503);
  assertEquals(inserts(down.trace).length, 2);
  assertEquals(down.trace.db.filter((op: any) => op[0] === "rpc:wallet_hold"), [], "no money is touched");
  // A keyless press that fails is not retried: there is no key to take out.
  const keyless = await drive({ ...V2, idempotencyKey: undefined }, { ledgerFails: true });
  assertEquals([keyless.out.status, inserts(keyless.trace).length, keyless.trace.rows.filter((r) => r.code === "ai_style_idem_key_write_failed").length], [503, 1, 0]);
});

Deno.test("the frame map is kept on the row BEFORE the draft, and a failing map write never costs `drafted` or the answer", async () => {
  const ok = await drive(STREAMED, { model: THREE(GOOD()) });
  const answer = JSON.parse(ok.out.text);
  assert(answer.frameMap && answer.frameMap.front, "the answer carries a map");
  const ups = ledgerUpdates(ok.trace);
  const at = (k: string) => ups.findIndex((u) => k in u);
  // Before `drafted`, so a pickup that sees the draft always sees its map too.
  assert(at("frame_map") >= 0 && at("drafted") > at("frame_map"), `its own update, before drafted: ${JSON.stringify(ups.map((u) => Object.keys(u)))}`);
  assertEquals(ups[at("frame_map")], { frame_map: answer.frameMap }, "the answer's own map, and nothing else in that write");
  assert(!("frame_map" in ups[at("drafted")]), "never a key on the 226 write");
  // The write fails (253 not applied) or throws: the draft is on the row and the answer is the same.
  for (const how of ["error", "throw"] as const) {
    const bad = await drive(STREAMED, { model: THREE(GOOD()), frameMapFails: how });
    assertEquals(norm(JSON.parse(bad.out.text)), norm(answer), `${how}: the same answer`);
    const bu = ledgerUpdates(bad.trace);
    assertEquals(bu.filter((u) => "drafted" in u).length, 1, `${how}: drafted written`);
    assertEquals(norm(bu.find((u) => "drafted" in u)), norm(ups[at("drafted")]), `${how}: the same 226 write`);
    assertEquals(rowsOf(bad.trace), [["ai_style_frame_map_write_failed", "info"]], `${how}: one info row`);
    assertEquals(bad.trace.captured.length, 1, `${how}: captured once`);
  }
  // A reply with no map writes nothing more than it did before 253.
  const noMap: ModelPlan = { body: reply(JSON.stringify({ ...SPEC, frameMap: undefined })), delayMs: 2 };
  const bare = await drive(STREAMED, { model: THREE(noMap) });
  assertEquals(JSON.parse(bare.out.text).frameMap, null);
  assertEquals(ledgerUpdates(bare.trace).filter((u) => "frame_map" in u), [], "no map, no write");
});

Deno.test("the recover action is gated exactly like calibrate_style_ai", async () => {
  const gates = lift(SOURCE, "const GATES: GateTable = {", "\n};", "the GATES table");
  const gate = (a: string) => (gates.split("\n").find((l) => l.trim().startsWith(`${a}:`)) ?? "").trim().replace(/^[a-z_0-9]+:\s*/, "");
  assert(gate("calibrate_style_ai").length > 0, "calibrate_style_ai has a gate line");
  assertEquals(gate("calibrate_style_ai_recover"), gate("calibrate_style_ai"));
  // And through resolveTenant: whoever the generation refuses, the pickup refuses the same way.
  for (const member of [{ role: "user", access: { settings_structures: "view" } }, { role: "user", access: { settings_structures: "none" } }]) {
    const gen = await drive(STREAMED, { member, model: THREE(GOOD()) });
    const rec = await drive(RECOVER(), { member, ledger: [ROW()] });
    assertEquals(gen.out.status, 403, JSON.stringify(member));
    assertEquals(rec.out.status, gen.out.status, `the same refusal: ${JSON.stringify(member)}`);
    assertEquals(rec.trace.db.filter((op: any) => op[0] === "ai_style_calls" || op[0] === "wallet_transactions"), [], "and nothing is read");
  }
});

Deno.test("a drafted row answers what the streamed success answered, rebuilt from the row -- frame map and all -- plus recovered", async () => {
  const { answer, wrote } = await live();
  assertEquals(answer.ok, true);
  assert(wrote.frame_map && wrote.drafted, "the live run wrote its draft and its map");
  const row = ROW({ ...wrote, called_at: ago(200_000) });
  const got = await drive(RECOVER(), { ledger: [row] });
  assertEquals(got.out.status, 200);
  const body = JSON.parse(got.out.text);
  // Field for field and in the same order. The frame map is the answer's own (253), so the free
  // self-check runs on a recovered draft; only `dropped` (the shell knows what it sent) and
  // `balanceCents` (a pickup takes no money) are said to be missing.
  assertEquals(Object.keys(body), [...Object.keys(answer), "recovered"]);
  assertEquals(body, { ...answer, dropped: null, balanceCents: null, recovered: true });
  assertEquals(body.frameMap, answer.frameMap, "the self-check has its map");
  assertEquals(body.checkId, LEDGER_ID, "the row it came from");
  assertEquals(rowsOf(got.trace), [["ai_draft_recovered", "info"]], "one countable row");
  // Nothing but a read -- and a drafted row never reads the wallet.
  assertEquals([got.trace.sent.length, got.trace.captured.length, got.trace.released.length], [0, 0, 0]);
  assertEquals(walletReads(got.trace), [], "the draft is the answer whatever the money says");
  assertEquals(got.trace.db.filter((op: any) => op[0] === "ai_style_calls" && op.some((s: any) => s[0] === "update" || s[0] === "insert")), []);
  // A row written before 253 has no map: the draft still comes back, and the check is skipped.
  const old = await drive(RECOVER(), { ledger: [ROW({ ...wrote, frame_map: null })] });
  assertEquals(JSON.parse(old.out.text).frameMap, null);
  // A row older than the check's claim window keeps its map, but the claim would refuse the check:
  // the draft comes back without it, and the designer skips the check instead of asking.
  const stale = await drive(RECOVER(), { ledger: [ROW({ ...wrote, called_at: ago(SELF_CHECK_CLAIM_WINDOW_MS + 60_000) })] });
  const staleBody = JSON.parse(stale.out.text);
  assertEquals([staleBody.recovered, staleBody.checkId, staleBody.frameMap], [true, LEDGER_ID, null]);
});

Deno.test("⛔ never another tenant's, user's or key's row -- nor a LATER press's row on the same style under its own key", async () => {
  const { wrote } = await live();
  const drafted = wrote.drafted;
  assert(drafted && typeof drafted === "object", "a real draft to hide");
  const others = [
    ROW({ id: "a0000000-0000-4000-8000-000000000001", client_id: "another-tenant", drafted }),
    ROW({ id: "a0000000-0000-4000-8000-000000000002", user_id: OTHER_USER, drafted }),
    ROW({ id: "a0000000-0000-4000-8000-000000000003", idem_key: "some-other-press", drafted }),
    ROW({ id: "a0000000-0000-4000-8000-000000000004", idem_key: null, drafted }),
    ROW({ id: "a0000000-0000-4000-8000-000000000005", style_key: "shed", drafted }),
    ROW({ id: "a0000000-0000-4000-8000-000000000006", source: "photos", drafted }),
    // THE LATER PRESS (issue 4): another tab or device, the same user and style, its own key,
    // newer than anything of this press's, and drafted. Matching by time returned exactly this.
    ROW({ id: "a0000000-0000-4000-8000-000000000007", idem_key: "the-later-press", called_at: ago(1_000), drafted }),
  ];
  const none = await drive(RECOVER(), { ledger: others });
  assertEquals(JSON.parse(none.out.text), { ok: true, pending: false, reason: "no_row", message: NOT_CHARGED }, "nothing of anyone else's");
  // The query names the RESOLVED tenant and user, the key and the style, and nothing else from the body.
  const q = none.trace.db.find((op: any) => op[0] === "ai_style_calls") as any[];
  assertEquals(q.slice(1).filter((s: any) => s[0] !== "select"), [
    ["eq", "client_id", "harness-tenant"], ["eq", "user_id", USER_ID], ["eq", "idem_key", KEY], ["eq", "style_key", "barn"],
    ["in", "source", ["video", "combined"]], ["order", "called_at", { ascending: false }], ["limit", 20],
  ]);
  assert(!q.some((s: any) => s[0] === "gte" || s[0] === "gt" || s[0] === "lt"), "no time window of any kind");
  // A body that names another tenant or user, or carries the old clock fields, changes nothing.
  const forged = await drive(RECOVER({ clientId: "another-tenant", client_id: "another-tenant", userId: OTHER_USER, user_id: OTHER_USER, since: ago(1), clientNow: 0 }), { ledger: others });
  assertEquals(JSON.parse(forged.out.text).reason, "no_row");
  // This press's own row among all of them: its answer, never the later press's draft.
  const mine = ROW({ id: "b0000000-0000-4000-8000-000000000001", called_at: ago(60_000) });
  const found = await drive(RECOVER(), { ledger: [...others, mine] });
  assertEquals(JSON.parse(found.out.text), { ok: true, pending: true }, "this press is still running; the later draft is not its answer");
  // The later press asks with its own key, and gets its own draft.
  const theirs = await drive(RECOVER({ idempotencyKey: "the-later-press" }), { ledger: [...others, mine] });
  assertEquals(JSON.parse(theirs.out.text).checkId, "a0000000-0000-4000-8000-000000000007");
});

Deno.test("a key that owns several rows answers from the NEWEST: a failed row then a drafted retry is the retry", async () => {
  const { wrote } = await live();
  const failed = ROW({ id: "c0000000-0000-4000-8000-000000000001", called_at: ago(300_000), draft_ms: 120_000 });
  const retried = ROW({ id: "c0000000-0000-4000-8000-000000000002", called_at: ago(100_000), drafted: wrote.drafted, frame_map: wrote.frame_map });
  for (const ledger of [[failed, retried], [retried, failed]]) {
    const got = await drive(RECOVER(), { ledger, wallet: [TX({ state: "released" }), TX({ state: "posted", posted_at: ago(90_000) })] });
    const body = JSON.parse(got.out.text);
    assertEquals([body.recovered, body.checkId], [true, "c0000000-0000-4000-8000-000000000002"]);
  }
  // A newer attempt under the same key that is still running is the one answered: it is pending.
  const running = ROW({ id: "c0000000-0000-4000-8000-000000000003", called_at: ago(5_000) });
  for (const ledger of [[running, failed, retried], [retried, failed, running]]) {
    const got = await drive(RECOVER(), { ledger, wallet: [TX({ state: "released" }), TX({ state: "held" })] });
    assertEquals(JSON.parse(got.out.text), { ok: true, pending: true });
  }
});

Deno.test("⚠️ an unreadable draft on a CHARGED press reads the wallet and says 'charged once', never 'not charged'", async () => {
  for (const drafted of ["gable", [1, 2], 7]) {
    const got = await drive(RECOVER(), { ledger: [ROW({ drafted })], wallet: [TX({ state: "posted", posted_at: ago(600_000) })] });
    const body = JSON.parse(got.out.text);
    assert(body.pending === false && body.reason === "unreadable", `${JSON.stringify(drafted)}: ${JSON.stringify(body)}`);
    assert(/charged once/.test(body.message) && /not been charged twice/.test(body.message) && !/not charged for it/.test(body.message), body.message);
    assertEquals(walletReads(got.trace).length, 1, `${JSON.stringify(drafted)}: the wallet was read`);
    assertEquals(rowsOf(got.trace), [["ai_draft_recover_none", "error"]]);
  }
  // A readable draft is still the answer whatever the money says, and never reads the wallet.
  const { wrote } = await live();
  const fine = await drive(RECOVER(), { ledger: [ROW({ ...wrote })], wallet: [TX({ state: "posted", posted_at: ago(600_000) })] });
  assertEquals([JSON.parse(fine.out.text).recovered, walletReads(fine.trace).length], [true, 0]);
});

Deno.test("⚠️ no draft: the answer about money is the press's own wallet rows, never the timing", async () => {
  const young = ROW({ called_at: ago(20_000) });
  const cases: [string, Record<string, unknown>, Record<string, unknown>[], (b: any) => boolean, string[][]][] = [
    ["released, however young the row: the draft failed, NOT charged", young, [TX({ state: "released" })],
      (b) => b.pending === false && b.reason === "failed" && b.message === NOT_CHARGED, [["ai_draft_recover_none", "info"]]],
    ["captured a while ago with no draft: charged once, and lost -- a fault", young, [TX({ state: "released" }), TX({ state: "posted", posted_at: ago(DRAFT_RECOVER_SETTLE_MS + 60_000) })],
      (b) => b.pending === false && b.reason === "charged_unsaved" && /charged once/.test(b.message) && /not been charged twice/.test(b.message) && !/not charged for it/.test(b.message), [["ai_draft_recover_none", "error"]]],
    ["captured a moment ago: the draft is a write behind it, so wait", young, [TX({ state: "posted", posted_at: ago(2_000) })],
      (b) => b.pending === true, []],
    ["held, however old the row: the work is still running", ROW({ called_at: ago(DRAFT_RECOVER_PENDING_MS + 60_000), draft_ms: 100_000 }), [TX({ state: "held" })],
      (b) => b.pending === true, []],
    ["no wallet row (the meter inactive) and the work has not ended: wait", young, [],
      (b) => b.pending === true, []],
    ["no wallet row and the work ended long ago without a draft: failed, and not charged is true", ROW({ called_at: ago(100_000 + DRAFT_RECOVER_SETTLE_MS + 30_000), draft_ms: 100_000 }), [],
      (b) => b.pending === false && b.reason === "failed" && b.message === NOT_CHARGED, [["ai_draft_recover_none", "info"]]],
    // The reads never ended, so the worker was ended under them (2026-09-26): an error row, and the
    // sentence is still the money's.
    ["no wallet row and nothing written past the wall clock: lost, not charged -- a fault", ROW({ called_at: ago(DRAFT_RECOVER_PENDING_MS + 5_000) }), [],
      (b) => b.pending === false && b.reason === "stale" && b.message === NOT_CHARGED, [["ai_draft_recover_none", "error"]]],
  ];
  for (const [what, row, wallet, ok, rows] of cases) {
    const got = await drive(RECOVER(), { ledger: [row], wallet });
    const body = JSON.parse(got.out.text);
    assert(ok(body), `${what}: ${JSON.stringify(body)}`);
    assertEquals(rowsOf(got.trace), rows, `${what}: a row only when the wait ends`);
  }
  // The wallet is read by the press's key, for the resolved tenant and user and this meter only.
  const got = await drive(RECOVER(), { ledger: [young], wallet: [TX({ state: "released" })] });
  const q = walletReads(got.trace)[0] as any[];
  assertEquals(q.slice(1).filter((s: any) => s[0] !== "select"), [
    ["eq", "client_id", "harness-tenant"], ["eq", "idempotency_key", KEY], ["eq", "actor_user_id", USER_ID],
    ["eq", "meter_kind", "video_3d_generation"], ["eq", "kind", "debit"],
  ]);
  // So another tenant's charge under the same key, another user's, or another meter's never reads as this press's.
  const foreign = [
    TX({ client_id: "another-tenant", state: "posted", posted_at: ago(600_000) }),
    TX({ actor_user_id: OTHER_USER, state: "posted", posted_at: ago(600_000) }),
    TX({ meter_kind: "sms_segment", state: "posted", posted_at: ago(600_000) }),
    TX({ state: "released" }),
  ];
  const clean = await drive(RECOVER(), { ledger: [young], wallet: foreign });
  assertEquals(JSON.parse(clean.out.text).message, NOT_CHARGED);
});

Deno.test("no row under the key: reason no_row, the sentence chosen by the money, one row", async () => {
  const nothing = await drive(RECOVER(), { ledger: [] });
  assertEquals(JSON.parse(nothing.out.text), { ok: true, pending: false, reason: "no_row", message: NOT_CHARGED });
  assertEquals(rowsOf(nothing.trace), [["ai_draft_recover_none", "info"]]);
  // A charge under the key that no row carries (an insert that fell back without it): never "not charged".
  const paid = await drive(RECOVER(), { ledger: [], wallet: [TX({ state: "posted", posted_at: ago(600_000) })] });
  const body = JSON.parse(paid.out.text);
  assert(body.reason === "no_row" && /charged once/.test(body.message), JSON.stringify(body));
  assertEquals(rowsOf(paid.trace), [["ai_draft_recover_none", "error"]]);
});

Deno.test("the body names the style and the press's key, and nothing else is read from it", async () => {
  for (const [what, o] of [
    ["no key", { idempotencyKey: undefined }],
    ["an empty key", { idempotencyKey: "" }],
    ["the old since/clientNow and no key", { idempotencyKey: undefined, since: ago(1_000), clientNow: Date.now() }],
    ["no style", { styleValue: "" }],
  ] as [string, Record<string, unknown>][]) {
    const got = await drive(RECOVER(o), { ledger: [ROW()] });
    assertEquals(got.out.status, 400, what);
    assertEquals(got.trace.db.filter((op: any) => op[0] === "ai_style_calls" || op[0] === "wallet_transactions"), [], `${what}: refused before anything is read`);
  }
  // The key is cut exactly as the insert cut it, so a long key finds its row.
  const long = "k".repeat(150);
  const got = await drive(RECOVER({ idempotencyKey: long }), { ledger: [ROW({ idem_key: "k".repeat(120) })] });
  assertEquals(JSON.parse(got.out.text), { ok: true, pending: true });
});

Deno.test("a ledger or wallet that cannot be read is not an answer about the draft: 503, one coded row, and the shell asks again", async () => {
  for (const [what, world] of [["the ledger", { ledger: [ROW()], recoverErr: true }], ["the wallet", { ledger: [ROW()], walletErr: true }]] as [string, World][]) {
    const got = await drive(RECOVER(), world);
    assertEquals(got.out.status, 503, what);
    const body = JSON.parse(got.out.text);
    assert(!("pending" in body), `${what}: never pending:false for a read that failed`);
    assertEquals(got.trace.rows.map((r) => r.code), ["ai_draft_recover_failed"], `${what}: the wrapper adds no copy`);
    assert(String(got.trace.rows[0].message).includes(`Could not read ${what}`), `${what}: says which read`);
    // The ledger read names the migration its two columns come from; the wallet's has nothing to do with it.
    assertEquals(/253/.test(String(got.trace.rows[0].message)), what === "the ledger", `${what}: ${got.trace.rows[0].message}`);
  }
});
