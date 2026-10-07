// A RECESSED PORCH'S DEPTH THE READS' POINTS MEASURED IS LOCKED IN THE SELF-CHECK (2026-10-07), RUN
// through the shipped handler.
//
// WHY THIS EXISTS. The v2 draft now works a recessed porch's depth out from five points each read marks
// on one side frame (porchDepthFromMeasure), where by eye the reads gave 8 ft for a 6 ft porch, and
// draft_tokens.samples records which reads' depth came from their points. Step 3 of the v2 self-check
// would judge "how big" again by eye. So a measured depth is locked the way a measured pitch is
// (aiSelfCheckPitchLockWiring_test): measuredPorchLock (porchDepthPoints.test.ts pins its rules)
// decides it off the ROW, the v2 prompt says so, and applySelfCheck drops a correction to
// roof.porchDepthFt. What only the handler can get wrong:
//
//   1. the lock is worked out once, from the claimed row's draft_tokens and the spec the round judges
//      (the last round's answer, or the first draft), never from the request: only while that spec
//      still has the porch the points measure, at a depth within half a foot of a measured one;
//   2. a locked row's depth correction is dropped (and logged, with the reason) while another field's
//      correction on the same answer lands, and the prompt sent says the depth was measured;
//   3. a row with too few measured reads, or a consensus on a judged number, lets it through with the
//      prompt every check sent before this;
//   4. the lock holds on a later round, lets go on a round judging a porch an earlier round made
//      projecting, and stays off on the round after that if it put the recess back at a depth judged
//      by eye; a legacy check is untouched;
//   5. the designer's merge of the answer (calDraftRoof, lifted from both twins) keeps the measured
//      depth: the browser applies the server's spec and re-applies no check depth of its own.
//
// HOW: aiSelfCheckPitchLockWiring_test's harness. Everything from the claim to the action's last
// `return` is lifted out of the shipped source and run as an async function against a stand-in
// ledger, fetch, logger and history writers, with the real styleD3 functions.

import {
  applySelfCheck, measuredOverhangLock, measuredPitchLock, measuredPorchLock, modelReplyText, parseKnownDims, parseSelfCheck,
  sanitizeD3Spec, selfCheckChangedFields, selfCheckPrompt, selfCheckReverted, selfCheckRequest,
  selfCheckTotalChanges, legacySelfCheckPrompt, SELF_CHECK_CLAIM_WINDOW_MS, SELF_CHECK_MAX_ROUNDS,
} from "../styleD3.ts";
import type { D3Spec, KnownDims, SelfCheckPair } from "../styleD3.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const SRC = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url)))
  .replace(/\r\n/g, "\n");

function lift(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiSelfCheckPorchLockWiring_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  if (src.indexOf(start, i + 1) >= 0) {
    throw new Error(`aiSelfCheckPorchLockWiring_test: the start anchor for ${what} is no longer unique — re-point it.`);
  }
  return src.slice(i, j);
}

// From the claim to the end of the action (its closing brace left out).
let BLOCK = lift(
  SRC,
  "    const since = new Date(Date.now() - SELF_CHECK_CLAIM_WINDOW_MS).toISOString();",
  "\n  }\n\n  // Reorder this tenant's building styles.",
  "the check from the claim to its answer in portal-settings/index.ts",
);
for (const [ts, js] of [["let checkRes: Response;", "let checkRes;"], ["let checkData: any = null;", "let checkData = null;"]]) {
  assertEquals(BLOCK.split(ts).length - 1, 1, `the lifted block has "${ts}" exactly once — re-point the edit`);
  BLOCK = BLOCK.replace(ts, js);
}
for (const must of [
  '.select("drafted, dims, self_check_after, self_check_changed, self_check_rounds, draft_tokens")',
  "const porchLocked = v2Check && measuredPorchLock(claimed.draft_tokens, draftRead.d3);",
  "round, earlier: selfCheckChangedFields(claimed.self_check_changed), pitchLocked, overhangLocked, porchLocked,",
  "const applied = applySelfCheck(draftRead.d3, read, dims, checkMode, pitchLocked, overhangLocked, porchLocked);",
  "...(porchLocked ? { porchLocked } : {})",
]) {
  assert(BLOCK.includes(must), `the check lost ${must}`);
}
assertEquals(BLOCK.split("measuredPorchLock(").length - 1, 1, "the lock is worked out once");

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
const STYLE = "porch-cabin";
const DIMS: KnownDims = { widthFt: 14, lengthFt: 40, wallHeightFt: 7.75 };
function spec(raw: unknown): D3Spec {
  const r = sanitizeD3Spec(raw);
  if (!r.ok) throw new Error(`the fixture is not a valid spec: ${r.error}`);
  return r.d3;
}
// The first draft: a gable-front cabin whose recessed porch the reads measured at 6 ft.
const ROOF = { type: "gable", front: "gable", pitch: 0.42, overhang: 1, eave: "fascia", porchDepthFt: 6, porchEnd: "front", porchTruss: true };
const DRAFTED = spec({ roof: ROOF, siding: "batten", colors: { body: "#7a1f1f", trim: "#f0f0f0", roof: "#2a2a2a" }, wallHeightFt: 7.75 });
// Each read as draftReadSample records it: the roof, then where its numbers came from.
const read = (depth: number, source: "points" | "model") =>
  ({ ...ROOF, porchDepthFt: depth, pitchSource: "model", porchSource: source, ...(source === "points" ? { modelPorchDepth: 8 } : {}) });
const TOKENS = (...samples: Row[]) => ({ model: "claude-opus-5-5", input: 3, output: 3, effort: "high", streamed: true, samples });
const MEASURED = TOKENS(read(6, "points"), read(8, "model"), read(6, "points"), read(6.5, "points"), read(8, "model"));

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

// The check's answer: deepen the porch to 8 ft by eye, and open the eave. Two fields, both on every
// allow-list, so only the lock can tell them apart.
const REPLY = {
  verdict: "corrections",
  corrections: { roof: { porchDepthFt: 8, eave: "open" } },
  changed: [
    { field: "roof.porchDepthFt", from: 6, to: 8, why: "the porch takes about a fifth of the side" },
    { field: "roof.eave", from: "fascia", to: "open", why: "rafter tails show under the eave in the close-up" },
  ],
  checked: { massing: "ok", overhang: "ok", porch: "changed", roofProfile: "ok", eave: "changed" },
  note: "",
};
const PAIRS: SelfCheckPair[] = [{ viewpoint: "front", frameUrl: "https://example.test/f1.jpg", base64: "AAAA" }];

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PARAMS = [
  "SELF_CHECK_CLAIM_WINDOW_MS", "admin", "checkId", "clientId", "styleValue", "round", "logEdgeError", "req", "json",
  "skipped", "roundsBefore", "parseKnownDims", "sanitizeD3Spec", "appendRound", "recordSelfCheck", "v2Check",
  "measuredPitchLock", "selfCheckRequest", "checkMode", "pairs", "selfCheckChangedFields", "AbortSignal", "fetch",
  "apiKey", "failedCheck", "t0", "modelReplyText", "parseSelfCheck", "applySelfCheck", "selfCheckTotalChanges",
  "selfCheckReverted", "SELF_CHECK_MAX_ROUNDS", "measuredOverhangLock", "measuredPorchLock",
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
    SELF_CHECK_MAX_ROUNDS, measuredOverhangLock, measuredPorchLock,
  );
  assert(out && out.body && out.status === 200, `the check answered: ${JSON.stringify(out)}`);
  assertEquals(sent.length, 1, "one model call");
  const prompt = String(sent[0].messages[0].content[0].text).replace(/\r\n/g, "\n");
  return { reply: out.body as Row, prompt, logged, recorded };
}

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const dropped = (logged: Row[]) => logged.find((e) => e.code === "ai_selfcheck_field_dropped");
const MEASURED_WORDS = "THE PORCH'S DEPTH (roof.porchDepthFt, currently 6 ft) WAS MEASURED: it was worked\n   out from points marked on the builder's own frames";

// The designer's merge of the check's answer onto the spec from before the generation (calDraftRoof,
// lifted from both twins the way calDraftRoof_test does, with the two constants it reads).
const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));
const REGIONS: Array<[string, string]> = [
  ["const CAL_WING_KEYS = ", ";\n"],
  ["const D3_PORCH_STEP_FRONT = ", ";\n"],
  ["const calDraftRoof = (stored, drafted) => {", "\n    return roof;\n  };"],
];
const merge = (src: string, file: string) => REGIONS.map(([a, b]) => {
  const at = lf(src);
  return lift(at, a, b, `${a} in ${file}`) + b;
}).join("\n");
assertEquals(merge(JSX, "StructureStudio.jsx"), merge(CMP, "structure-studio.component.js"), "the twins' merges are byte-identical");
// deno-lint-ignore no-explicit-any
const calDraftRoof = new Function(`${merge(CMP, "structure-studio.component.js")}; return calDraftRoof;`)() as (stored: any, drafted: any) => Row;

Deno.test("⚠️ a row whose reads MEASURED the porch's depth keeps it: the depth correction is dropped, the eave's lands", async () => {
  assert(measuredPorchLock(MEASURED, DRAFTED) && !measuredPitchLock(MEASURED, DRAFTED), "the fixture locks the porch and not the pitch");
  const { reply, prompt, logged, recorded } = await runCheck({ row: freshRow({ draft_tokens: MEASURED }) });
  assertEquals(reply.verdict, "corrections");
  assertEquals([reply.d3.roof.porchDepthFt, reply.d3.roof.eave], [6, "open"], "the measured 6 stands, and the eave opens");
  assertEquals(reply.changed.map((c: Row) => c.field), ["roof.eave"], "only the eave is reported as changed");
  assertEquals(dropped(logged)?.context.dropped, ["roof.porchDepthFt"], "the depth correction is recorded as not applied");
  assertEquals(dropped(logged)?.context.porchLocked, true, "and the row says why");
  assert(!("pitchLocked" in dropped(logged)?.context) && !("overhangLocked" in dropped(logged)?.context), "and only that reason");
  assertEquals(recorded[0].self_check_after.roof.porchDepthFt, 6, "the ledger's result keeps the measured depth");
  assert(prompt.includes(MEASURED_WORDS), "step 3 says it was measured");
  assert(prompt.includes("Never return wallHeightFt, sizeFt, colors or siding or roof.porchDepthFt."), "and the rules list it");
  assertEquals(prompt, lf(selfCheckPrompt({ dims: DIMS, draft: DRAFTED, viewpoints: ["front"], round: 0, earlier: [], porchLocked: true })));
  // The designer merges the answer onto the spec from before the generation (a 9 ft porch, say) and
  // draws the server's depth: there is no check depth of its own to put back.
  const merged = calDraftRoof({ ...ROOF, porchDepthFt: 9, plateBand: true }, reply.d3.roof);
  assertEquals([merged.porchDepthFt, merged.eave, merged.plateBand], [6, "open", true], "the designer keeps the measured 6");
});

Deno.test("a row without two measured reads near its depth lets the correction through with today's prompt", async () => {
  for (const [name, tokens] of [
    ["no draft_tokens", null],
    ["one measured read", TOKENS(read(6, "points"), read(8, "model"), read(8, "model"))],
    ["a consensus on the judged 8", TOKENS(read(6, "points"), read(8, "model"), read(6, "points"), read(8, "model"), read(8, "model"))],
  ] as const) {
    const drafted = name === "a consensus on the judged 8" ? spec({ ...DRAFTED, roof: { ...DRAFTED.roof, porchDepthFt: 8 } }) : DRAFTED;
    const reply0 = { ...REPLY, corrections: { roof: { porchDepthFt: 7, eave: "open" } } };
    const { reply, prompt, logged } = await runCheck({ row: freshRow({ drafted, draft_tokens: tokens }), reply: reply0 });
    assertEquals(reply.d3.roof.porchDepthFt, 7, `${name}: the check's depth lands`);
    assertEquals(reply.changed.map((c: Row) => c.field), ["roof.porchDepthFt", "roof.eave"], `${name}: both reported`);
    assertEquals(dropped(logged), undefined, `${name}: nothing dropped`);
    assert(!prompt.includes("WAS MEASURED"), `${name}: nothing said about a measured depth`);
    assertEquals(prompt, lf(selfCheckPrompt({ dims: DIMS, draft: drafted, viewpoints: ["front"], round: 0, earlier: [] })), name);
  }
});

Deno.test("⚠️ the lock holds on a LATER round, and lets go on a round judging a porch an earlier round made projecting", async () => {
  // Round 0 opened the eave; round 1 judges that result and tries the depth again.
  const after = spec({ ...DRAFTED, roof: { ...DRAFTED.roof, eave: "open" } });
  const later = (selfCheckAfter: D3Spec, changed: Row[]) => freshRow({
    draft_tokens: MEASURED, self_check_at: new Date().toISOString(), self_check_round: 1,
    self_check_verdict: "corrections", self_check_after: selfCheckAfter, self_check_changed: changed,
  });
  const deeper = { ...REPLY, corrections: { roof: { porchDepthFt: 8 } }, changed: [REPLY.changed[0]] };
  const held = await runCheck({ row: later(after, [{ field: "roof.eave", from: "fascia", to: "open", why: "tails" }]), round: 1, reply: deeper });
  assertEquals(held.reply.d3.roof.porchDepthFt, 6, "round 1 cannot move it");
  assertEquals(dropped(held.logged)?.context.porchLocked, true);
  assert(held.prompt.includes("THIS IS CHECK ROUND 2 OF") && held.prompt.includes(MEASURED_WORDS), "and is told so");
  // Round 0 made the porch projecting: round 1 judges a projecting porch, and is not told of a measured depth.
  const projecting = spec({ ...DRAFTED, roof: { ...DRAFTED.roof, porchDepthFt: undefined, porchTruss: undefined, porchOutFt: 6 } });
  const back = { ...REPLY, corrections: { roof: { porchDepthFt: 8 } }, changed: [REPLY.changed[0]] };
  const swapped = await runCheck({ row: later(projecting, [{ field: "roof.porchOutFt", from: null, to: 6, why: "it stands out" }]), round: 1, reply: back });
  assertEquals([swapped.reply.d3.roof.porchDepthFt, swapped.reply.d3.roof.porchOutFt], [8, undefined], "the recess comes back as the check asked");
  assert(!swapped.prompt.includes("WAS MEASURED"), "nothing said about a measured depth");
  // Round 2 judges that recess at 8, judged by eye. Off the first draft (6) the row read as locked
  // again, said the 8 was MEASURED and dropped a correction back to 6 (review, 2026-10-07). Off the
  // spec it judges, it is not locked: no read measured 8.
  const recessed8 = spec({ ...DRAFTED, roof: { ...DRAFTED.roof, porchDepthFt: 8 } });
  assert(measuredPorchLock(MEASURED, DRAFTED) && !measuredPorchLock(MEASURED, recessed8), "the first draft locks, the judged spec does not");
  const round2 = freshRow({
    draft_tokens: MEASURED, self_check_at: new Date().toISOString(), self_check_round: 2,
    self_check_verdict: "corrections", self_check_after: recessed8,
    self_check_changed: [{ field: "roof.porchDepthFt", from: 6, to: 8, why: "by eye" }],
  });
  const six = { ...REPLY, corrections: { roof: { porchDepthFt: 6 } }, changed: [{ ...REPLY.changed[0], from: 8, to: 6 }] };
  const third = await runCheck({ row: round2, round: 2, reply: six });
  assertEquals(third.reply.d3.roof.porchDepthFt, 6, "the correction back to the measured 6 lands");
  assertEquals(dropped(third.logged), undefined, "nothing dropped");
  assert(third.prompt.includes("THIS IS CHECK ROUND 3 OF") && !third.prompt.includes("WAS MEASURED"), "and the 8 is not called measured");
});

Deno.test("⛔ a legacy check is untouched: d3ab404's prompt, and its rules let the depth through", async () => {
  const { reply, prompt } = await runCheck({ row: freshRow({ draft_tokens: MEASURED }), mode: "legacy" });
  assertEquals(reply.d3.roof.porchDepthFt, 8, "the legacy allow-list is d3ab404's");
  assertEquals(prompt, lf(legacySelfCheckPrompt({ dims: DIMS, draft: DRAFTED, viewpoints: ["front"] })), "and so is its prompt");
});
