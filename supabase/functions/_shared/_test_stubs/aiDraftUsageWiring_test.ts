// The draft call's usage write (251), RUN against a database with and without the columns.
//
// WHY THIS EXISTS. On 2026-09-21 one generation in twelve was cut off at max_tokens after 103 s,
// and nothing could say how close the other eleven came, because a draft's tokens were only ever
// stored through wallet_capture and the meter is inactive for every tenant. 251 adds
// `draft_tokens` / `draft_ms` and portal-settings writes them on every exit that reached the
// model. Three things about that write are easy to break and silent when broken:
//
//   1. It must be its OWN update. PostgREST refuses a whole statement naming an unknown column
//      (PGRST204), so the two keys riding on the 226 `recorded` write would take drafted,
//      observed and frames down with them on any deploy that lands before the migration.
//   2. It must never reject or throw into the handler. A diagnostics write is not allowed to
//      fail a generation, and a builder who has been charged must keep their draft.
//   3. It must carry SHAPES only — counts, the stop reason, block types and the answer's
//      length — never the model's text.
//
// HOW: the same slice-and-run idiom as aiLedgerDimsWiring_test. The helper's body and the
// reply-site block are lifted between stable anchors and executed against a hand-rolled client,
// so nothing is copied out and nothing can drift.
//
// ⚠️ WHAT THIS DOES NOT PROVE. That PostgREST answers PGRST204 for a missing column (an
// assumption encoded in the fake, as in the dims test), or that Anthropic's `usage` keeps these
// key names. What it proves is the handler's own behaviour given those answers.

import { assert, assertEquals } from "jsr:@std/assert";
import { aiModelFields, draftReadSample } from "../styleD3.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SOURCE = await read("../../portal-settings/index.ts");
const MIG = await read("../../../migrations/251_ai_style_calls_draft_usage.sql");

function lift(start: string, end: string, what: string): { i: number; j: number; text: string } {
  const i = SOURCE.indexOf(start);
  const j = i < 0 ? -1 : SOURCE.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiDraftUsageWiring_test: could not find ${what} in portal-settings/index.ts ` +
        `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
    );
  }
  return { i, j, text: SOURCE.slice(i + start.length, j) };
}

// The helper. Its signature is the only typed line and is the anchor, so the body is plain JS.
const SIG = "    const recordDraftUsage = async (tokens: Record<string, unknown> | null) => {";
// The end anchor stops at the call, not at its number: the abort moved from 110 s to 125 s on
// 2026-09-24, and a timeout is not what this test is about.
const HELPER = lift(SIG, "\n    };\n\n    const aiSignal = AbortSignal.timeout(", "the recordDraftUsage helper");
// The reply-site block that builds the shape and starts the write.
const SITE_START = "    const draftUsage = data?.usage ?? {};";
const SITE = lift(SITE_START, '    if (reply.stopReason === "refusal") {', "the draft-usage reply-site block");
const SITE_BLOCK = SITE_START + SITE.text;

for (const name of ["draft_tokens", "draft_ms", "ai_style_draft_usage_log_failed", ".eq(\"id\", ledgerRow.id)"]) {
  assert(HELPER.text.includes(name), `the lifted helper is missing ${name} — re-point the anchors`);
}
assertEquals(HELPER.text.split(".update(").length - 1, 1, "the helper makes exactly one update call");
assert(SITE_BLOCK.includes("const draftUsageLogged = recordDraftUsage("), "the reply site starts the write");

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Logged = { code: string; message: string };

/** A fake `ai_style_calls`: any payload naming a column it does not have is refused WHOLE. */
function fakeAdmin(known: string[], mode: "ok" | "throws" | "rejects" = "ok") {
  const attempts: Row[] = [];
  const stored: Row[] = [];
  return {
    attempts,
    stored,
    from(table: string) {
      if (mode === "throws") throw new Error("client exploded before sending anything");
      assertEquals(table, "ai_style_calls", "the usage write goes to the generation ledger");
      return {
        update(row: Row) {
          attempts.push(row);
          const unknown = Object.keys(row).filter((k) => !known.includes(k));
          return {
            eq(col: string, _id: unknown) {
              assertEquals(col, "id", "the write is scoped to the row by id");
              if (mode === "rejects") return Promise.reject(new Error("socket hang up"));
              if (unknown.length) {
                return Promise.resolve({
                  error: {
                    code: "PGRST204",
                    message: `Could not find the '${unknown[0]}' column of 'ai_style_calls' in the schema cache`,
                  },
                });
              }
              stored.push(row);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

const BEFORE_251 = ["drafted", "observed", "frames", "video_count", "dims", "self_check_tokens", "self_check_ms"];
const AFTER_251 = [...BEFORE_251, "draft_tokens", "draft_ms"];

/** Build the SHIPPED helper with the free variables the handler gives it. `draftEffort` and
 * `streamed` (2026-09-25) are the branch's: the effort the request sent, and whether it streamed.
 * Absent here, they are a plain request's: "medium", not streamed. */
function helper(admin: unknown, logged: Logged[], opts: { ledgerRow?: unknown; t0?: number; draftEffort?: string; streamed?: boolean } = {}) {
  const make = new Function(
    "ledgerRow", "admin", "logEdgeError", "req", "clientId", "t0", "draftEffort", "streamed",
    `return async (tokens) => {${HELPER.text}\n};`,
  );
  return make(
    "ledgerRow" in opts ? opts.ledgerRow : { id: "11111111-2222-3333-4444-555555555555" },
    admin,
    // deno-lint-ignore require-await
    async (e: Logged) => { logged.push({ code: e.code, message: e.message }); },
    null,
    "harness-tenant",
    opts.t0 ?? Date.now() - 1234,
    opts.draftEffort ?? "medium",
    opts.streamed ?? false,
  ) as (tokens: unknown) => Promise<void>;
}

/** Run the SHIPPED reply-site block and hand back the promise it started. `v2Prompt` is the
 * rollout gate the handler passes to aiModelFields, which the real function answers here.
 * `callsUsage` is consensus drafting's record of every call (2026-09-25): null on a single call,
 * which is every case below but one, so those pin the single call's record exactly as it was.
 * `lead` is the call the handler answers from (2026-09-26): its reading carries `pitch` only on a
 * measured v2 read. The default is a legacy reading, which records no samples. */
function site(data: unknown, reply: Row, recordDraftUsage: unknown, v2Prompt = false, callsUsage: unknown = null, lead: unknown = { reading: { d3: null } }): Promise<void> {
  const run = new Function(
    "data", "reply", "text", "recordDraftUsage", "aiModelFields", "v2Prompt", "callsUsage", "lead", "draftReadSample",
    `${SITE_BLOCK}\nreturn draftUsageLogged;`,
  );
  return run(data, reply, reply.text, recordDraftUsage, aiModelFields, v2Prompt, callsUsage, lead, draftReadSample);
}

// Text the model "wrote". It must never appear in anything that was stored.
const SENTINEL = "SENTINEL-reply-text-must-not-be-stored";
const REPLY_TEXT = `{"roof":{"type":"gambrel"},"note":"${SENTINEL}"}`;
const TRUNCATED = {
  text: REPLY_TEXT,
  stopReason: "max_tokens",
  blockTypes: ["thinking", "text"],
  outputTokens: 8000,
};
const DATA = {
  stop_reason: "max_tokens",
  usage: { input_tokens: 21000, output_tokens: 8000, cache_read_input_tokens: 0, cache_creation_input_tokens: 12 },
};

Deno.test("a truncated reply's usage lands as SHAPES only, in its own two-column update", async () => {
  const admin = fakeAdmin(AFTER_251);
  const logged: Logged[] = [];
  await site(DATA, TRUNCATED, helper(admin, logged));
  assertEquals(admin.attempts.length, 1, "one round trip");
  assertEquals(Object.keys(admin.stored[0]).sort(), ["draft_ms", "draft_tokens"], "nothing else rides on this write");
  assertEquals(admin.stored[0].draft_tokens, {
    model: "claude-sonnet-5",
    input: 21000,
    output: 8000,
    cache_read: 0,
    cache_creation: 12,
    stopReason: "max_tokens",
    textChars: REPLY_TEXT.length,
    blockTypes: ["thinking", "text"],
    effort: "medium",
    streamed: false,
  });
  assert(!JSON.stringify(admin.stored).includes(SENTINEL), "⚠️ the model's text reached the table");
  assert(typeof admin.stored[0].draft_ms === "number" && admin.stored[0].draft_ms >= 1234, "elapsed since t0");
  assertEquals(logged, [], "a healthy write is silent");
});

Deno.test("a reply with no usage block records nulls, not zeros", async () => {
  // Zero would read as "the model produced nothing", which is a different, false, statement.
  const admin = fakeAdmin(AFTER_251);
  const reply = { text: "", stopReason: null, blockTypes: [], outputTokens: null };
  for (const data of [null, {}, { usage: null }, { usage: { input_tokens: "12", output_tokens: NaN } }]) {
    admin.stored.length = 0;
    await site(data, reply, helper(admin, []));
    assertEquals(admin.stored[0].draft_tokens, {
      model: "claude-sonnet-5",
      input: null, output: null, cache_read: null, cache_creation: null,
      stopReason: null, textChars: 0, blockTypes: [],
      effort: "medium", streamed: false,
    });
  }
});

Deno.test("the usage names the model the request ran, so the cost basis can be re-priced per model", async () => {
  // 2026-09-25: the v2 path moved to Opus while every capture was still priced at Sonnet's rate,
  // and no row said which model had run. The model rides in the jsonb, not in a new column.
  for (const [v2, model] of [[false, "claude-sonnet-5"], [true, "claude-opus-5-5"]] as const) {
    const admin = fakeAdmin(AFTER_251);
    await site(DATA, TRUNCATED, helper(admin, []), v2);
    assertEquals(admin.stored[0].draft_tokens.model, model, `v2Prompt ${v2}`);
    assertEquals(Object.keys(admin.stored[0]).sort(), ["draft_ms", "draft_tokens"], "still only the two 251 columns");
  }
});

Deno.test("several calls (consensus drafting) record their summed record in place of the single call's", async () => {
  // aiDraftConsensusWiring_test proves what that record holds; here, only that the reply site takes
  // it whole when there is one, through the same single write.
  const admin = fakeAdmin(AFTER_251);
  const tokens = { model: "claude-opus-5-5", input: 84000, output: 28000, calls: [{ ok: true }, { ok: true }, { ok: false }, { ok: true }, { ok: true }] };
  await site(DATA, TRUNCATED, helper(admin, []), true, { tokens, usage: {} });
  assertEquals(admin.attempts.length, 1, "one round trip, as before");
  assertEquals(admin.stored[0].draft_tokens, { ...tokens, effort: "medium", streamed: false });
  assertEquals(Object.keys(admin.stored[0]).sort(), ["draft_ms", "draft_tokens"], "still only the two 251 columns");
});

Deno.test("a measured v2 single read (the lean retry) records its roof and pitch sources in `samples`; a legacy read records none", async () => {
  // 2026-09-26: each v2 gable read's pitch is worked out from its own pixel points, and where it came
  // from rides in draft_tokens.samples. Five reads record every read's (draftCallsUsage); the lean
  // retry's single read records its one, under the same key, so one query reads both.
  const roof = { type: "gable", pitch: 0.36, porchOutFt: 6, porchPitch: 0.3 };
  const pitch = { pitchSource: "points", modelPitch: 0.7 };
  const admin = fakeAdmin(AFTER_251);
  await site(DATA, TRUNCATED, helper(admin, [], { draftEffort: "low" }), true, null, { reading: { d3: { roof }, pitch } });
  const tokens = admin.stored[0].draft_tokens;
  assertEquals(tokens.samples, [{ ...roof, ...pitch }], "the one read, with where its pitches came from");
  assertEquals(tokens.model, "claude-opus-5-5");
  assertEquals(Object.keys(admin.stored[0]).sort(), ["draft_ms", "draft_tokens"], "still only the two 251 columns");
  // A reading with no `pitch` (every legacy read) records exactly the object it always did.
  const legacy = fakeAdmin(AFTER_251);
  await site(DATA, TRUNCATED, helper(legacy, []), false, null, { reading: { d3: { roof } } });
  assert(!("samples" in legacy.stored[0].draft_tokens), "no samples key on a legacy read");
});

Deno.test("draft_tokens says which effort the request ran at and whether it streamed, at its top level", async () => {
  // 2026-09-25: a streamed v2 draft thinks at "high" with 20000 tokens, the lean retry at "low", every
  // other request at "medium", and nothing recorded which, so "did high help?" had no query. Two keys
  // at the top of the existing jsonb, no new column: the write is still the two 251 columns.
  const tokens = { model: "claude-opus-5-5", input: 105000, output: 75000, calls: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }] };
  for (const [effort, streamed] of [["high", true], ["medium", false], ["low", false]] as const) {
    const admin = fakeAdmin(AFTER_251);
    await site(DATA, TRUNCATED, helper(admin, [], { draftEffort: effort, streamed }), true, { tokens, usage: {} });
    assertEquals(admin.stored[0].draft_tokens, { ...tokens, effort, streamed }, `${effort}, streamed ${streamed}`);
    assertEquals(Object.keys(admin.stored[0]).sort(), ["draft_ms", "draft_tokens"]);
  }
  // A reply that never came stays null: that is what "no reply" means in this column (251's comment).
  const admin = fakeAdmin(AFTER_251);
  await helper(admin, [], { draftEffort: "high", streamed: true })(null);
  assertEquals(admin.stored[0].draft_tokens, null);
  // Both come from the branch itself, never from the tokens it was handed.
  assert(HELPER.text.includes("draft_tokens: tokens ? { ...tokens, effort: draftEffort, streamed } : tokens"), "the helper's own shape");
});

Deno.test("⚠️ before 251 is applied, the write fails ALONE, says so once, and does not throw", async () => {
  // Deploy first, migrate second. The 226 columns are untouched because this is not their
  // statement; here the only casualty is draft usage, and the row names the migration.
  const admin = fakeAdmin(BEFORE_251);
  const logged: Logged[] = [];
  await site(DATA, TRUNCATED, helper(admin, logged));
  assertEquals(admin.stored.length, 0);
  assertEquals(logged.map((l) => l.code), ["ai_style_draft_usage_log_failed"]);
  assert(logged[0].message.includes("251"), "the row names the migration that fixes it");
});

Deno.test("a client that throws or rejects never reaches the handler", async () => {
  for (const mode of ["throws", "rejects"] as const) {
    const logged: Logged[] = [];
    // If this rejected, the await in each of the handler's returns would turn a diagnostics
    // failure into a 500 for a builder who already has their draft.
    await site(DATA, TRUNCATED, helper(fakeAdmin(AFTER_251, mode), logged));
    assertEquals(logged.map((l) => l.code), ["ai_style_draft_usage_log_failed"], `${mode}: swallowed for the builder, but filed once`);
    assert(logged[0].message.startsWith("Draft-usage write threw:"), `${mode}: says it threw`);
  }
});

Deno.test("no ledger row, no write", async () => {
  const admin = fakeAdmin(AFTER_251);
  await helper(admin, [], { ledgerRow: null })(null);
  assertEquals(admin.attempts.length, 0);
});

Deno.test("the no-reply exits record draft_ms with null tokens", async () => {
  const admin = fakeAdmin(AFTER_251);
  await helper(admin, [], { t0: Date.now() - 110_000 })(null);
  assertEquals(admin.stored[0].draft_tokens, null);
  assert(admin.stored[0].draft_ms >= 110_000);
});

// ── Static wiring: the parts that only exist as source order ────────────────────────────────
Deno.test("⚠️ the 226 `recorded` write does not name either 251 column", () => {
  // Same anchors as aiLedgerDimsWiring_test, so both tests break together if the block moves.
  const start = SOURCE.indexOf("    if (ledgerRow?.id) {\n      const recorded = {");
  const end = SOURCE.indexOf("    // `frames` makes a silent truncation visible", start);
  assert(start > 0 && end > start, "found the 226 block");
  const block = SOURCE.slice(start, end);
  for (const name of ["draft_tokens", "draft_ms", "recordDraftUsage", "draftUsage"]) {
    assert(!block.includes(name), `${name} must not ride on the 226 write (PGRST204 would take drafted with it)`);
  }
});

Deno.test("every exit after the model call waits for the usage write before it returns", () => {
  // Started without await so it overlaps the rest of the handler; each return then waits for it,
  // because a task still in flight after the response is not guaranteed to finish.
  for (const ret of ["return refused;", "return failed;", "return json({ ok: true, d3: drafted.d3,"]) {
    const k = SOURCE.indexOf(ret, SITE.j);
    assert(k > 0, `found ${ret}`);
    assert(
      SOURCE.slice(0, k).trimEnd().endsWith("await draftUsageLogged;"),
      `${ret} is not preceded by await draftUsageLogged`,
    );
  }
  // The two upstream exits answer through upstreamFailed since 2026-09-26 (a plain sentence, one
  // coded row); each still waits for the usage write first.
  for (const ret of ["return timedOut;", "return unreachable;", "return upstream;"]) {
    const k = SOURCE.indexOf(ret, HELPER.j);
    assert(k > 0 && k < SITE.i, `found ${ret} between the helper and the reply site`);
    assert(SOURCE.slice(0, k).trimEnd().endsWith("await usageLogged;"), `${ret} is not preceded by await usageLogged`);
  }
});

Deno.test("the truncation row carries the answer's length", () => {
  const k = SOURCE.indexOf("    const replyShape = {");
  const shape = SOURCE.slice(k, SOURCE.indexOf("};", k));
  assert(shape.includes("textChars: text.length"), "replyShape reports textChars");
});

Deno.test("251 adds both columns, nullable, re-runnable, and proves they landed", () => {
  const a = MIG.indexOf("alter table public.ai_style_calls");
  assert(a > 0, "it alters the ledger");
  const alter = MIG.slice(a, MIG.indexOf(";", a) + 1);
  assert(alter.includes("add column if not exists draft_tokens jsonb"), "draft_tokens jsonb");
  assert(/add column if not exists draft_ms\s+integer;/.test(alter), "draft_ms integer");
  assert(!/\bnot null\b|\bdefault\b/i.test(alter), "nullable with no default: existing rows recorded nothing, and no rewrite");
  assert(!/^\s*(grant|revoke)\b/im.test(MIG), "no grant change on a service-role-only table");
  assert(MIG.includes("raise exception '251 did not add ai_style_calls columns"), "the do-block refuses a silent miss");
});
