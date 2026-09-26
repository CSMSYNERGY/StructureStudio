// A MEASURED GABLE PITCH IS LOCKED IN THE SELF-CHECK (2026-09-26), RUN through the shipped handler.
//
// WHY THIS EXISTS. The v2 draft now works a gable's pitch out from pixel points in each read, and
// records per read in draft_tokens.samples where the pitch came from. Live, a draft whose reads
// measured a 0.41 gable came out at 0.415, and round 0 of the self-check then "corrected" it to 0.7
// by eye. So a pitch at least two reads measured is now locked the way a builder-measured eave is:
// measuredPitchLock (styleD3.test.ts pins its rules) decides it off the ROW, the v2 prompt says so,
// and applySelfCheck drops a correction to roof.pitch. What only the handler can get wrong:
//
//   1. the claim hands back draft_tokens, and the lock is worked out from IT and the first draft,
//      never from anything the request carries;
//   2. a locked row's pitch correction is dropped (and logged as dropped) while another field's
//      correction on the same answer lands, and the prompt the model was sent says the pitch was
//      measured;
//   3. a row without two measured reads lets the pitch correction through, with the prompt every
//      check sent before this;
//   4. the lock holds on a later round too, because it is a property of the drafted row;
//   5. a legacy check (production's older designer) is untouched: d3ab404's prompt and rules.
//
// HOW: aiSelfCheckClaimWiring_test's idiom. Everything from the claim to the action's last
// `return` is lifted out of the shipped source and run as an async function against a stand-in
// ledger, fetch, logger and history writers, with the real styleD3 functions. The only edits to
// the lifted text strip its two TypeScript annotations, and each is asserted to exist first.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  applySelfCheck, measuredPitchLock, modelReplyText, parseKnownDims, parseSelfCheck, sanitizeD3Spec,
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
      `aiSelfCheckPitchLockWiring_test: could not find ${what} in portal-settings/index.ts ` +
        `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
    );
  }
  if (SRC.indexOf(start, i + 1) >= 0) {
    throw new Error(`aiSelfCheckPitchLockWiring_test: the start anchor for ${what} is no longer unique — re-point it.`);
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
// The wiring this file is about, named so a diff that drops one fails with its name.
for (const must of [
  '.select("drafted, dims, self_check_after, self_check_changed, self_check_rounds, draft_tokens")',
  'const pitchLocked = v2Check && draftRead.d3.roof?.type === "gable" && measuredPitchLock(claimed.draft_tokens, claimed.drafted);',
  "round, earlier: selfCheckChangedFields(claimed.self_check_changed), pitchLocked,",
  "const applied = applySelfCheck(draftRead.d3, read, dims, checkMode, pitchLocked);",
]) {
  assert(BLOCK.includes(must), `the check lost ${must}`);
}
assertEquals(BLOCK.split("measuredPitchLock(").length - 1, 1, "the lock is worked out once");

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** `ai_style_calls` under PostgREST, as aiSelfCheckClaimWiring_test's stand-in: the claim's
 *  filters accumulate, and `maybeSingle()` applies the patch to the first row that matches. */
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
const DIMS: KnownDims = { widthFt: 16, lengthFt: 24, wallHeightFt: 9 };
function spec(raw: unknown): D3Spec {
  const r = sanitizeD3Spec(raw);
  if (!r.ok) throw new Error(`the fixture is not a valid spec: ${r.error}`);
  return r.d3;
}
// The first draft: a gable at the median of its reads, with a fascia eave.
const DRAFTED = spec({
  roof: { type: "gable", front: "gable", pitch: 0.415, overhang: 1, eave: "fascia" },
  siding: "lap", colors: { body: "#8b6f4e", trim: "#e8e0d0", roof: "#2a2a2a" }, wallHeightFt: 9,
});
// Each read's roof as draftReadSample records it: the roof, then where its pitch came from.
const read = (pitch: number, source: "points" | "model", extra: Row = {}) =>
  ({ type: "gable", front: "gable", pitch, overhang: 1, eave: "fascia", pitchSource: source, ...extra });
const TWO_MEASURED = {
  model: "claude-opus-5", input: 3, output: 3, effort: "medium", streamed: true,
  samples: [read(0.41, "points", { modelPitch: 0.62 }), read(0.4, "points", { modelPitch: 0.55 }), read(0.45, "model", { pitchRejected: true })],
};
const ONE_MEASURED = { ...TWO_MEASURED, samples: [read(0.41, "points", { modelPitch: 0.62 }), read(0.45, "model"), read(0.5, "model")] };

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

// The check's answer: steepen the pitch by eye, and open the eave. Two fields, both on every
// allow-list, so only the lock can tell them apart.
const REPLY = {
  verdict: "corrections",
  corrections: { roof: { pitch: 0.7, eave: "open" } },
  changed: [
    { field: "roof.pitch", from: 0.415, to: 0.7, why: "the peak rises nearly as much as its half-span" },
    { field: "roof.eave", from: "fascia", to: "open", why: "rafter tails show under the eave in the close-up" },
  ],
  checked: { massing: "ok", overhang: "ok", porch: "ok", roofProfile: "changed", eave: "changed" },
  note: "",
};
const PAIRS: SelfCheckPair[] = [{ viewpoint: "front", frameUrl: "https://example.test/f1.jpg", base64: "AAAA" }];

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PARAMS = [
  "SELF_CHECK_CLAIM_WINDOW_MS", "admin", "checkId", "clientId", "styleValue", "round", "logEdgeError", "req", "json",
  "skipped", "roundsBefore", "parseKnownDims", "sanitizeD3Spec", "appendRound", "recordSelfCheck", "v2Check",
  "measuredPitchLock", "selfCheckRequest", "checkMode", "pairs", "selfCheckChangedFields", "AbortSignal", "fetch",
  "apiKey", "failedCheck", "t0", "modelReplyText", "parseSelfCheck", "applySelfCheck", "selfCheckTotalChanges",
  "selfCheckReverted", "SELF_CHECK_MAX_ROUNDS",
];
const RUN = new AsyncFunction(...PARAMS, `${BLOCK}\n  return { fellThrough: true };`);

async function runCheck(opts: { row: Row; round?: number; mode?: "v2" | "legacy" }) {
  const mode = opts.mode ?? "v2";
  const sent: Row[] = [];
  const logged: Row[] = [];
  const recorded: Row[] = [];
  const fetch = (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    const body = { content: [{ type: "text", text: JSON.stringify(REPLY) }], usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: "end_turn" };
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
    // deno-lint-ignore require-await
    async () => {},
    // deno-lint-ignore require-await
    async (_id: string, patch: Row) => { recorded.push(patch); },
    mode === "v2", measuredPitchLock, selfCheckRequest, mode, PAIRS, selfCheckChangedFields,
    { timeout: () => new AbortController().signal }, fetch, "test-key",
    // deno-lint-ignore require-await
    async (code: string) => ({ failed: code }),
    Date.now(), modelReplyText, parseSelfCheck, applySelfCheck, selfCheckTotalChanges, selfCheckReverted,
    SELF_CHECK_MAX_ROUNDS,
  );
  assert(out && out.body && out.status === 200, `the check answered: ${JSON.stringify(out)}`);
  assertEquals(sent.length, 1, "one model call");
  const prompt = String(sent[0].messages[0].content[0].text).replace(/\r\n/g, "\n");
  return { reply: out.body as Row, prompt, logged, recorded };
}

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const dropped = (logged: Row[]) => logged.find((e) => e.code === "ai_selfcheck_field_dropped");

Deno.test("⚠️ a row whose reads MEASURED the pitch keeps it: the pitch correction is dropped, the eave's lands", async () => {
  const row = freshRow({ draft_tokens: TWO_MEASURED });
  assert(measuredPitchLock(TWO_MEASURED, DRAFTED), "the fixture is a locked row");
  const { reply, prompt, logged, recorded } = await runCheck({ row });
  assertEquals(reply.verdict, "corrections");
  assertEquals(reply.d3.roof.pitch, 0.415, "the measured pitch stands");
  assertEquals(reply.d3.roof.eave, "open", "and the other correction on the same answer lands");
  assertEquals(reply.changed.map((c: Row) => c.field), ["roof.eave"], "only the eave is reported as changed");
  assertEquals(dropped(logged)?.context.dropped, ["roof.pitch"], "the pitch correction is recorded as not applied");
  assertEquals(dropped(logged)?.context.pitchLocked, true, "and the row says why");
  assertEquals(recorded[0].self_check_after.roof.pitch, 0.415, "the ledger's result keeps the measured pitch");
  // The model was told, in the words the prompt builder uses for a locked row.
  assert(prompt.includes("THE PITCH (roof.pitch, currently 0.415)\n   WAS MEASURED"), "step 5 says the pitch was measured");
  assert(prompt.includes("a correction to roof.pitch will be thrown away"), "and that a correction is thrown away");
  assert(prompt.includes("Never return wallHeightFt, sizeFt, colors or siding or roof.pitch."), "and the rules list it");
  assertEquals(prompt, lf(selfCheckPrompt({ dims: DIMS, draft: DRAFTED, viewpoints: ["front"], round: 0, earlier: [], pitchLocked: true })));
});

Deno.test("a row without two measured reads lets the pitch correction through, with today's prompt", async () => {
  for (const [name, tokens] of [["no draft_tokens", null], ["one measured read", ONE_MEASURED], ["junk", { samples: "three" }]] as const) {
    const { reply, prompt, logged } = await runCheck({ row: freshRow({ draft_tokens: tokens }) });
    assertEquals(reply.d3.roof.pitch, 0.7, `${name}: the check's pitch lands`);
    assertEquals(reply.d3.roof.eave, "open", `${name}: and so does the eave`);
    assertEquals(reply.changed.map((c: Row) => c.field), ["roof.pitch", "roof.eave"], `${name}: both reported`);
    assertEquals(dropped(logged), undefined, `${name}: nothing dropped`);
    assert(!prompt.includes("WAS MEASURED"), `${name}: nothing said about a measured pitch`);
    // Byte for byte what the builder sends without the lock, which styleD3.test.ts pins to HEAD's.
    assertEquals(prompt, lf(selfCheckPrompt({ dims: DIMS, draft: DRAFTED, viewpoints: ["front"], round: 0, earlier: [] })), name);
  }
});

Deno.test("the draft's measured reads are what count: a consensus far from them is not locked", async () => {
  // Two reads measured 0.41 and 0.40, but the drafted pitch is 0.5: it came from somewhere else.
  const judged = spec({ ...DRAFTED, roof: { ...DRAFTED.roof, pitch: 0.5 } });
  const { reply } = await runCheck({ row: freshRow({ drafted: judged, draft_tokens: TWO_MEASURED }) });
  assertEquals(reply.d3.roof.pitch, 0.7, "the check may move it");
});

Deno.test("⚠️ the lock holds on a LATER round: it is a property of the drafted row", async () => {
  // Round 0 opened the eave; round 1 judges that result and tries the pitch again.
  const after = spec({ ...DRAFTED, roof: { ...DRAFTED.roof, eave: "open" } });
  const row = freshRow({
    draft_tokens: TWO_MEASURED, self_check_at: new Date().toISOString(), self_check_round: 1,
    self_check_verdict: "corrections", self_check_after: after,
    self_check_changed: [{ field: "roof.eave", from: "fascia", to: "open", why: "tails" }],
  });
  const { reply, prompt, logged } = await runCheck({ row, round: 1 });
  assertEquals(reply.d3.roof.pitch, 0.415, "round 1 cannot move the measured pitch either");
  assertEquals(dropped(logged)?.context.dropped, ["roof.pitch", "roof.eave"], "the pitch refused, and the eave already open");
  assertEquals(dropped(logged)?.context.pitchLocked, true);
  assert(prompt.includes("THIS IS CHECK ROUND 2 OF"), "it really is round 1");
  assert(prompt.includes("WAS MEASURED"), "and it is told the pitch was measured");
});

Deno.test("⛔ a legacy check is untouched: d3ab404's prompt, and its rules let the pitch through", async () => {
  const { reply, prompt } = await runCheck({ row: freshRow({ draft_tokens: TWO_MEASURED }), mode: "legacy" });
  assertEquals(reply.d3.roof.pitch, 0.7, "the legacy allow-list is d3ab404's");
  assertEquals(prompt, lf(legacySelfCheckPrompt({ dims: DIMS, draft: DRAFTED, viewpoints: ["front"] })), "and so is its prompt");
  assert(!prompt.includes("WAS MEASURED"), "which says nothing about a measured pitch");
});
