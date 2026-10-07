// AN OVERHANG THE CLOSE-UPS MEASURED IS LOCKED IN THE SELF-CHECK (2026-09-29), RUN through the shipped handler.
//
// WHY THIS EXISTS. The v2 draft now measures a gable's eave overhang from enlarged close-ups of its two
// corners (overhangZoom.ts) and keeps what it did in draft_tokens.overhangZoom. The v2 self-check's
// step 2 would judge that overhang again by eye, in a whole frame, which is the reading the close-ups
// replaced (the reads had given 6 in where the eaves stand 12 and 16 in). So a measured overhang is
// locked the way a measured pitch is (aiSelfCheckPitchLockWiring_test) and a builder-measured eave
// always was: measuredOverhangLock (styleD3.test.ts pins its rules) decides it off the ROW, the v2
// prompt says so, and applySelfCheck drops a correction to roof.overhang. What only the handler can
// get wrong:
//
//   1. the lock is worked out once, from the claimed row's draft_tokens and first draft, never from
//      the request;
//   2. a locked row's overhang correction is dropped (and logged, with the reason) while another
//      field's correction on the same answer lands, and the prompt sent says the overhang was measured;
//   3. a row whose close-up gave nothing, or whose overhang is not the close-up's, lets the correction
//      through with the prompt every check sent before this;
//   4. a builder-measured eave keeps exactly its own path;
//   5. the lock holds on a later round, sits beside the pitch lock, and a legacy check is untouched.
//
// HOW: aiSelfCheckPitchLockWiring_test's harness. Everything from the claim to the action's last
// `return` is lifted out of the shipped source and run as an async function against a stand-in
// ledger, fetch, logger and history writers, with the real styleD3 functions.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  applySelfCheck, measuredOverhangLock, measuredPitchLock, measuredPorchLock, modelReplyText, parseKnownDims, parseSelfCheck,
  porchPointsApply, sanitizeD3Spec,
  selfCheckChangedFields, selfCheckPrompt, selfCheckReverted, selfCheckRequest, selfCheckTotalChanges,
  legacySelfCheckPrompt, SELF_CHECK_CLAIM_WINDOW_MS, SELF_CHECK_MAX_ROUNDS,
} from "../styleD3.ts";
import type { D3Spec, KnownDims, SelfCheckPair } from "../styleD3.ts";

const SRC = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url)))
  .replace(/\r\n/g, "\n");

function lift(start: string, end: string, what: string): string {
  const i = SRC.indexOf(start);
  const j = i < 0 ? -1 : SRC.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiSelfCheckOverhangLockWiring_test: could not find ${what} in portal-settings/index.ts ` +
        `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
    );
  }
  if (SRC.indexOf(start, i + 1) >= 0) {
    throw new Error(`aiSelfCheckOverhangLockWiring_test: the start anchor for ${what} is no longer unique — re-point it.`);
  }
  return SRC.slice(i, j);
}

// From the claim to the end of the action (its closing brace left out).
let BLOCK = lift(
  "    const since = new Date(Date.now() - SELF_CHECK_CLAIM_WINDOW_MS).toISOString();",
  "\n  }\n\n  // Reorder this tenant's building styles.",
  "the check from the claim to its answer",
);
for (const [ts, js] of [["let checkRes: Response;", "let checkRes;"], ["let checkData: any = null;", "let checkData = null;"]]) {
  assertEquals(BLOCK.split(ts).length - 1, 1, `the lifted block has "${ts}" exactly once — re-point the edit`);
  BLOCK = BLOCK.replace(ts, js);
}
for (const must of [
  '.select("drafted, dims, self_check_after, self_check_changed, self_check_rounds, draft_tokens")',
  'const overhangLocked = v2Check && draftRead.d3.roof?.type === "gable" && measuredOverhangLock(claimed.draft_tokens, claimed.drafted);',
  "round, earlier: selfCheckChangedFields(claimed.self_check_changed), pitchLocked, overhangLocked,",
  "const applied = applySelfCheck(draftRead.d3, read, dims, checkMode, pitchLocked, overhangLocked, porchLocked);",
  "...(overhangLocked ? { overhangLocked } : {})",
]) {
  assert(BLOCK.includes(must), `the check lost ${must}`);
}
assertEquals(BLOCK.split("measuredOverhangLock(").length - 1, 1, "the lock is worked out once");

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** `ai_style_calls` under PostgREST, as aiSelfCheckPitchLockWiring_test's stand-in. */
function fakeAdmin(rows: Row[]) {
  return {
    from(table: string) {
      assertEquals(table, "ai_style_calls", "the claim is on the generation ledger");
      return {
        update(patch: Row) {
          const filters: [string, string, unknown][] = [];
          const chain: Row = {
            eq(col: string, val: unknown) { filters.push(["eq", col, val]); return chain; },
            is(col: string, val: unknown) { filters.push(["is", col, val]); return chain; },
            gt(col: string, val: unknown) { filters.push(["gt", col, val]); return chain; },
            select(cols: string) { chain._cols = cols.split(",").map((c) => c.trim()); return chain; },
            // deno-lint-ignore require-await
            async maybeSingle() {
              const hit = rows.find((r) =>
                filters.every(([op, col, val]) =>
                  op === "gt" ? String(r[col]) > String(val) : (r[col] ?? null) === val
                )
              );
              if (!hit) return { data: null, error: null };
              Object.assign(hit, structuredClone(patch));
              const out: Row = {};
              for (const c of (chain._cols ?? [])) out[c] = hit[c] ?? null;
              return { data: out, error: null };
            },
          };
          return chain;
        },
      };
    },
  };
}

const TENANT = "tenant-a";
const ID = "11111111-2222-3333-4444-555555555555";
const STYLE = "gable-cabin";
const DIMS: KnownDims = { widthFt: 14, lengthFt: 40, wallHeightFt: 7.75 };
function spec(raw: unknown): D3Spec {
  const r = sanitizeD3Spec(raw);
  if (!r.ok) throw new Error(`the fixture is not a valid spec: ${r.error}`);
  return r.d3;
}
// The first draft: a gable whose overhang the close-ups measured at 17 in.
const MEASURED_FT = 17 / 12;
const DRAFTED = spec({
  roof: { type: "gable", front: "gable", pitch: 0.5, overhang: MEASURED_FT, eave: "fascia" },
  siding: "batten", colors: { body: "#7a1f1f", trim: "#f0f0f0", roof: "#2a2a2a" }, wallHeightFt: 7.75,
});
// draft_tokens as the draft writes it: the reads' samples (none measured a pitch here) and the close-up's record.
const read = (pitch: number, source: "points" | "model") =>
  ({ type: "gable", front: "gable", pitch, overhang: 0.5, eave: "fascia", pitchSource: source });
const zoomRecord = (after: number | null) => ({
  frame: 2, gableFt: 14, before: 0.5, tips: { left: [248, 226], right: [975, 268] },
  asks: [{ ft: 1.428, left: 1.517, right: 1.338 }, { ft: 1.421, left: 1.501, right: 1.341 }, { ft: 1.421, left: 1.505, right: 1.337 }],
  used: 3, usage: { input: 9900, output: 2700 }, after, ms: 14200,
});
const TOKENS = (after: number | null, samples = [read(0.5, "model"), read(0.52, "model"), read(0.48, "model")]) => ({
  model: "claude-opus-5-5", input: 3, output: 3, effort: "high", streamed: true, samples, overhangZoom: zoomRecord(after),
});

function freshRow(over: Row = {}): Row {
  return {
    id: ID, client_id: TENANT, style_key: STYLE,
    called_at: new Date(Date.now() - 60 * 1000).toISOString(),
    self_check_at: null, self_check_round: 0, self_check_verdict: null,
    self_check_after: null, self_check_changed: null, self_check_rounds: null,
    drafted: DRAFTED, dims: DIMS, draft_tokens: null,
    ...over,
  };
}

// The check's answer: pull the overhang back to 6 in by eye, and open the eave. Two fields, both on
// every allow-list, so only the lock can tell them apart.
const REPLY = {
  verdict: "corrections",
  corrections: { roof: { overhang: 0.5, eave: "open" } },
  changed: [
    { field: "roof.overhang", from: 1.42, to: 0.5, why: "the roof stands out about a sixteenth of the wall" },
    { field: "roof.eave", from: "fascia", to: "open", why: "rafter tails show under the eave in the close-up" },
  ],
  checked: { massing: "ok", overhang: "changed", porch: "ok", roofProfile: "ok", eave: "changed" },
  note: "",
};
const PAIRS: SelfCheckPair[] = [{ viewpoint: "front", frameUrl: "https://example.test/f1.jpg", base64: "AAAA" }];

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PARAMS = [
  "SELF_CHECK_CLAIM_WINDOW_MS", "admin", "checkId", "clientId", "styleValue", "round", "logEdgeError", "req", "json",
  "skipped", "roundsBefore", "parseKnownDims", "sanitizeD3Spec", "appendRound", "recordSelfCheck", "v2Check",
  "measuredPitchLock", "selfCheckRequest", "checkMode", "pairs", "selfCheckChangedFields", "AbortSignal", "fetch",
  "apiKey", "failedCheck", "t0", "modelReplyText", "parseSelfCheck", "applySelfCheck", "selfCheckTotalChanges",
  "selfCheckReverted", "SELF_CHECK_MAX_ROUNDS", "measuredOverhangLock",
  // 2026-10-07: the measured porch depth's lock, which none of these rows has.
  "measuredPorchLock", "porchPointsApply",
];
const RUN = new AsyncFunction(...PARAMS, `${BLOCK}\n  return { fellThrough: true };`);

async function runCheck(opts: { row: Row; round?: number; mode?: "v2" | "legacy"; reply?: Row }) {
  const mode = opts.mode ?? "v2";
  const sent: Row[] = [];
  const logged: Row[] = [];
  const recorded: Row[] = [];
  const fetch = (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    const body = { content: [{ type: "text", text: JSON.stringify(opts.reply ?? REPLY) }], usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: "end_turn" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  const out = await RUN(
    SELF_CHECK_CLAIM_WINDOW_MS, fakeAdmin([opts.row]), ID, TENANT, STYLE, opts.round ?? 0,
    // deno-lint-ignore require-await
    async (e: Row) => { logged.push(e); },
    null,
    (body: Row, status = 200) => ({ body, status }),
    (reason: string) => ({ skipped: reason }),
    null, parseKnownDims, sanitizeD3Spec,
    async () => {},
    // deno-lint-ignore require-await
    async (_id: string, patch: Row) => { recorded.push(patch); },
    mode === "v2", measuredPitchLock, selfCheckRequest, mode, PAIRS, selfCheckChangedFields,
    { timeout: () => new AbortController().signal }, fetch, "test-key",
    // deno-lint-ignore require-await
    async (code: string) => ({ failed: code }),
    Date.now(), modelReplyText, parseSelfCheck, applySelfCheck, selfCheckTotalChanges, selfCheckReverted,
    SELF_CHECK_MAX_ROUNDS, measuredOverhangLock, measuredPorchLock, porchPointsApply,
  );
  assert(out && out.body && out.status === 200, `the check answered: ${JSON.stringify(out)}`);
  assertEquals(sent.length, 1, "one model call");
  const prompt = String(sent[0].messages[0].content[0].text).replace(/\r\n/g, "\n");
  return { reply: out.body as Row, prompt, logged, recorded };
}

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const dropped = (logged: Row[]) => logged.find((e) => e.code === "ai_selfcheck_field_dropped");
const MEASURED_WORDS = "IT WAS MEASURED: it was worked out\n   from enlarged close-ups of the roof's two eave corners";

Deno.test("⚠️ a row whose close-ups MEASURED the overhang keeps it: the overhang correction is dropped, the eave's lands", async () => {
  const tokens = TOKENS(MEASURED_FT);
  assert(measuredOverhangLock(tokens, DRAFTED) && !measuredPitchLock(tokens, DRAFTED), "the fixture locks the overhang and not the pitch");
  const { reply, prompt, logged, recorded } = await runCheck({ row: freshRow({ draft_tokens: tokens }) });
  assertEquals(reply.verdict, "corrections");
  assertEquals(reply.d3.roof.overhang, MEASURED_FT, "the measured overhang stands");
  assertEquals(reply.d3.roof.eave, "open", "and the other correction on the same answer lands");
  assertEquals(reply.changed.map((c: Row) => c.field), ["roof.eave"], "only the eave is reported as changed");
  assertEquals(dropped(logged)?.context.dropped, ["roof.overhang"], "the overhang correction is recorded as not applied");
  assertEquals(dropped(logged)?.context.overhangLocked, true, "and the row says why");
  assert(!("pitchLocked" in dropped(logged)?.context), "and only that reason");
  assertEquals(recorded[0].self_check_after.roof.overhang, MEASURED_FT, "the ledger's result keeps the measured overhang");
  assert(prompt.includes(`2. THE EAVE OVERHANG (roof.overhang, currently 1.42 ft). ${MEASURED_WORDS}`), "step 2 says it was measured");
  assert(prompt.includes("Never return wallHeightFt, sizeFt, colors or siding or roof.overhang."), "and the rules list it");
  assertEquals(prompt, lf(selfCheckPrompt({ dims: DIMS, draft: DRAFTED, viewpoints: ["front"], round: 0, earlier: [], overhangLocked: true })));
});

Deno.test("a row whose close-up gave nothing, or whose overhang is not the close-up's, lets the correction through with today's prompt", async () => {
  const other = spec({ ...DRAFTED, roof: { ...DRAFTED.roof, overhang: 0.5 } });
  for (const [name, row, draft] of [
    ["no draft_tokens", freshRow(), DRAFTED],
    ["no close-up on the row", freshRow({ draft_tokens: { ...TOKENS(null), overhangZoom: undefined } }), DRAFTED],
    ["a close-up that measured nothing", freshRow({ draft_tokens: TOKENS(null) }), DRAFTED],
    ["an overhang from elsewhere", freshRow({ drafted: other, draft_tokens: TOKENS(MEASURED_FT) }), other],
  ] as const) {
    const { reply, prompt, logged } = await runCheck({ row: row as Row, reply: { ...REPLY, corrections: { roof: { overhang: 0.75, eave: "open" } } } });
    assertEquals(reply.d3.roof.overhang, 0.75, `${name}: the check's overhang lands`);
    assertEquals(reply.changed.map((c: Row) => c.field), ["roof.overhang", "roof.eave"], `${name}: both reported`);
    assertEquals(dropped(logged), undefined, `${name}: nothing dropped`);
    assert(!prompt.includes("IT WAS MEASURED"), `${name}: nothing said about a measured overhang`);
    assertEquals(prompt, lf(selfCheckPrompt({ dims: DIMS, draft: draft as D3Spec, viewpoints: ["front"], round: 0, earlier: [] })), name);
  }
});

Deno.test("⚠️ a builder-measured eave keeps exactly its own path", async () => {
  // The close-up never runs for a builder who typed the overhang, so their row has no record, and the
  // check is what it always was for them: their words, and roof.overhang off the list.
  const typed = { ...DIMS, overhangIn: 16 };
  const drafted = spec({ ...DRAFTED, roof: { ...DRAFTED.roof, overhang: 16 / 12 } });
  const { reply, prompt, logged } = await runCheck({ row: freshRow({ dims: typed, drafted, draft_tokens: TOKENS(null) }) });
  assertEquals(reply.d3.roof.overhang, 16 / 12, "the builder's 16 in stands");
  assertEquals(dropped(logged)?.context.dropped, ["roof.overhang"]);
  assert(!("overhangLocked" in dropped(logged)?.context), "dropped for the builder's reason, not the close-up's");
  assert(prompt.includes("THE BUILDER MEASURED THIS ONE TOO") && !prompt.includes("IT WAS MEASURED"), "the builder's words");
  assertEquals(prompt, lf(selfCheckPrompt({ dims: typed, draft: drafted, viewpoints: ["front"], round: 0, earlier: [] })));
});

Deno.test("⚠️ the lock holds on a LATER round, and sits beside a measured pitch's", async () => {
  // Round 0 opened the eave; round 1 judges that result and tries the overhang (and the pitch) again.
  const tokens = TOKENS(MEASURED_FT, [read(0.5, "points"), read(0.49, "points"), read(0.6, "model")]);
  assert(measuredPitchLock(tokens, DRAFTED), "the pitch is measured too");
  const after = spec({ ...DRAFTED, roof: { ...DRAFTED.roof, eave: "open" } });
  const row = freshRow({
    draft_tokens: tokens, self_check_at: new Date().toISOString(), self_check_round: 1,
    self_check_verdict: "corrections", self_check_after: after,
    self_check_changed: [{ field: "roof.eave", from: "fascia", to: "open", why: "tails" }],
  });
  const both = {
    ...REPLY,
    corrections: { roof: { overhang: 0.5, pitch: 0.7 } },
    changed: [
      { field: "roof.overhang", from: 1.42, to: 0.5, why: "by eye" },
      { field: "roof.pitch", from: 0.5, to: 0.7, why: "by eye" },
    ],
  };
  const { reply, prompt, logged } = await runCheck({ row, round: 1, reply: both });
  assertEquals([reply.d3.roof.overhang, reply.d3.roof.pitch], [MEASURED_FT, 0.5], "round 1 can move neither");
  assertEquals(dropped(logged)?.context.dropped, ["roof.overhang", "roof.pitch"]);
  assertEquals([dropped(logged)?.context.pitchLocked, dropped(logged)?.context.overhangLocked], [true, true]);
  assert(prompt.includes("THIS IS CHECK ROUND 2 OF") && prompt.includes(MEASURED_WORDS) && prompt.includes("WAS MEASURED: it was worked out from points"), "told of both");
  assert(prompt.includes("Never return wallHeightFt, sizeFt, colors or siding or roof.overhang or roof.pitch."), "and both are listed");
});

Deno.test("⛔ a legacy check is untouched: d3ab404's prompt, and its rules let the overhang through", async () => {
  const { reply, prompt } = await runCheck({ row: freshRow({ draft_tokens: TOKENS(MEASURED_FT) }), mode: "legacy" });
  assertEquals(reply.d3.roof.overhang, 0.5, "the legacy allow-list is d3ab404's");
  assertEquals(prompt, lf(legacySelfCheckPrompt({ dims: DIMS, draft: DRAFTED, viewpoints: ["front"] })), "and so is its prompt");
  assert(!prompt.includes("IT WAS MEASURED"), "which says nothing about a measured overhang");
});
