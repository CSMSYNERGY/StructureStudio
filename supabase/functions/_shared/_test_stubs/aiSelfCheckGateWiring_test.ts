// THE CHECK'S ROLLOUT GATE (fix, 2026-09-24), read off the SHIPPED portal-settings source and the
// SHIPPED portal shell.
//
// WHY IT EXISTS. The v2 generation prompt has been gated since it shipped (aiDraftFrameGateWiring_
// test): only a request that says `frame: "front"` gets it. The free self-check was not gated, so
// production's older designer -- which sends neither `frame` nor `round` -- was handed the v2 check:
// its new-frame ruler, its massing step and a 30-path allow-list that could save roof.front,
// highSide and the wing keys into styles its renderer cannot draw. Both reviews called it HIGH.
// Now the check is gated on the same key, and a request without it is d3ab404's check verbatim.
// styleD3.test.ts pins the legacy PROMPT and the whole legacy REQUEST BODY by hash; this file pins
// that the handler actually asks for them:
//
//   1. the mode is `selfCheckMode(payload.frame)` -- RUN, not regex-read -- and is decided before
//      the round, which a legacy request can only ever ask for as 0;
//   2. every gate is handed the mode: the render caps, the reply reader, the merge, and the one
//      request builder, whose body and abort are what the fetch sends -- no second prompt call and
//      no stray max_tokens literal left in the action;
//   3. a legacy answer is d3ab404's, key for key (skipped, failed and the verdict itself) -- RUN;
//   4. the new portal shell really sends `frame: "front"` on every check -- RUN against a
//      stand-in supabase client.
//
// HOW: the aiDraftFrameGateWiring_test idiom -- lift the shipped text between stable anchors.

import { assert, assertEquals } from "jsr:@std/assert";
import { parseSelfCheckRound, selfCheckMode, SELF_CHECK_MAX_ROUNDS } from "../styleD3.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const PORTAL = await read("../../portal-settings/index.ts");
const SHELL = await read("../../../../portal/12-shell.jsx");

function lift(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiSelfCheckGateWiring_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const ACTION = lift(PORTAL, 'if (action === "calibrate_style_check") {', "  // Reorder this tenant's building styles.", "the check action");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const line = (needle: string) => ACTION.split("\n").find((l) => l.includes(needle)) ?? "";

Deno.test("the check decides its mode with selfCheckMode(payload.frame), before the round", () => {
  const decl = line("const checkMode =");
  assertEquals(decl.trim(), "const checkMode = selfCheckMode(payload.frame);");
  assertEquals(line("const v2Check =").trim(), 'const v2Check = checkMode === "v2";');
  const run = (payload: Record<string, unknown>) =>
    new Function("selfCheckMode", "payload", `${decl}; return checkMode;`)(selfCheckMode, payload) as string;
  assertEquals(run({ frame: "front" }), "v2", "the new designer");
  assertEquals(run({}), "legacy", "production's older designer: no frame");
  assertEquals(run({ frame: "FRONT" }), "legacy");
  assertEquals(run({ round: 1 }), "legacy", "a round is not a frame");
  // Decided FIRST: the round limit and the render caps below both read it.
  assert(ACTION.indexOf("const checkMode =") < ACTION.indexOf("const roundRead ="), "before the round");
  assert(ACTION.indexOf("const checkMode =") < ACTION.indexOf("parseSelfCheckRenders("), "before the renders");
});

Deno.test("⚠️ a legacy request has ONE round: d3ab404's single-use check", () => {
  const decl = line("const roundRead =");
  assertEquals(decl.trim(), "const roundRead = parseSelfCheckRound(payload.round, v2Check ? SELF_CHECK_MAX_ROUNDS : 1);");
  const run = (payload: Record<string, unknown>, v2Check: boolean) =>
    new Function("parseSelfCheckRound", "SELF_CHECK_MAX_ROUNDS", "payload", "v2Check", `${decl}; return roundRead;`)(
      parseSelfCheckRound, SELF_CHECK_MAX_ROUNDS, payload, v2Check,
    ) as { ok: boolean; round?: number; status?: number; code?: string };
  assertEquals(run({}, false), { ok: true, round: 0 }, "what an older designer sends");
  const one = run({ round: 1 }, false);
  assertEquals([one.ok, one.status, one.code], [false, 409, "check_unavailable"], "no later round without the frame");
  assertEquals(run({ round: 2 }, true), { ok: true, round: 2 }, "the v2 check keeps its three");
  // Refused before anything touches the database: the claim is below it.
  assert(ACTION.indexOf("const roundRead =") < ACTION.indexOf('admin.from("ai_style_calls")'), "before the claim");
});

Deno.test("every gate is handed the mode, and the fetch sends the one request builder's body", () => {
  const body = code(ACTION);
  assert(body.includes("parseSelfCheckRenders(payload.renders, sentUrls.length, checkMode)"), "the render caps");
  assert(body.includes("parseSelfCheck(checkReply.text, checkMode)"), "the reply reader's `checked` keys");
  assert(body.includes("applySelfCheck(draftRead.d3, read, dims, checkMode)"), "the allow-list and the cap");
  assert(body.includes("selfCheckRequest({\n      mode: checkMode, dims, draft: draftRead.d3, pairs,"), "the prompt, the labels and the budget");
  assert(body.includes("const checkSignal = AbortSignal.timeout(plan.abortMs);"), "the abort is the mode's");
  assert(body.includes("body: JSON.stringify(plan.body),"), "and the body is exactly what was built");
  // Nothing left inline that could send a different prompt, budget or label than the builder's.
  for (const stray of ["selfCheckPrompt(", "legacySelfCheckPrompt(", "selfCheckPairLabel(", "max_tokens:", "AbortSignal.timeout(45_000)", "AbortSignal.timeout(90_000)"]) {
    assert(!body.includes(stray), `no ${stray} in the check action`);
  }
  assertEquals(body.split("fetch(").length - 1, 1, "one model call");
  assert(body.includes("`The self-check did not answer within ${plan.abortMs / 1000} seconds.`"), "the timeout row names the mode's limit");
});

Deno.test("⚠️ a legacy answer is d3ab404's, key for key; a v2 answer adds the round fields", () => {
  // skipped(): d3ab404 answered {ok, verdict, reason, note, changed, checked, d3, renders}.
  const decl = lift(ACTION, "    const skipped = (reason: string, note: string) =>", ";\n", "skipped()").replace(/: string/g, "") + ";";
  const json = (b: Record<string, unknown>) => b;
  const skipped = (v2Check: boolean) =>
    new Function("json", "v2Check", "round", `${decl}; return skipped("off", "n");`)(json, v2Check, 0) as Record<string, unknown>;
  assertEquals(Object.keys(skipped(false)), ["ok", "verdict", "reason", "note", "changed", "checked", "d3", "renders"]);
  assertEquals(Object.keys(skipped(true)), ["ok", "verdict", "reason", "note", "changed", "checked", "d3", "renders", "round", "roundsLeft"]);
  // failedCheck(): the same spread, so a legacy failure is d3ab404's too.
  const failed = lift(ACTION, "      return json({\n        ok: true, verdict: \"failed\"", "      });", "failedCheck's reply");
  assert(failed.includes("...(v2Check ? { round, roundsLeft: 0 } : {}),"), "the round fields only on v2");
  // The verdict: RUN the legacy branch.
  const legacy = lift(ACTION, "    if (!v2Check) {\n      return json({", "\n    }\n", "the legacy reply") + "\n    }";
  const out = new Function("json", "v2Check", "applied", "read", "pairs", "elapsedMs", `${legacy}\n return "fell through";`)(
    json, false,
    { verdict: "corrections", d3: { roof: { type: "gable" } }, changed: [{ field: "roof.pitch" }] },
    { checked: { overhang: "ok" }, note: "n" }, [1, 2, 3, 4], 1234,
  ) as Record<string, unknown>;
  assertEquals(Object.keys(out), ["ok", "verdict", "d3", "changed", "checked", "note", "renders", "ms"], "d3ab404's keys, in its order");
  assertEquals(out.d3, { roof: { type: "gable" } }, "the corrected spec when something moved");
  const matches = new Function("json", "v2Check", "applied", "read", "pairs", "elapsedMs", `${legacy}\n return "fell through";`)(
    json, false, { verdict: "matches", d3: { roof: {} }, changed: [] }, { checked: {}, note: "" }, [], 1,
  ) as Record<string, unknown>;
  assertEquals(matches.d3, null, "and null when nothing did, exactly as before");
  const v2 = new Function("json", "v2Check", "applied", "read", "pairs", "elapsedMs", `${legacy}\n return "fell through";`)(
    json, true, { verdict: "matches", d3: {}, changed: [] }, { checked: {}, note: "" }, [], 1,
  );
  assertEquals(v2, "fell through", "a v2 check goes on to its own answer");
  // The legacy branch sits after both ledger writes, so a legacy check records exactly what it did.
  assert(ACTION.indexOf("    if (!v2Check) {\n      return json({") > ACTION.lastIndexOf("await recordSelfCheck(checkId, {"), "after the ledger writes");
});

Deno.test("the new portal shell sends frame \"front\" on every check, beside the round", async () => {
  const fn = lift(SHELL, "onSelfCheck: async (", "\n    // Frames the browser cut out of a walk-around video.", "onSelfCheck").trim().replace(/,$/, "");
  const src = fn.replace(/^onSelfCheck:\s*/, "");
  const sent: Record<string, unknown>[] = [];
  const sb = {
    functions: {
      invoke: (_name: string, opts: { body: Record<string, unknown> }) => {
        sent.push(opts.body);
        return Promise.resolve({ data: { ok: true, verdict: "matches", changed: [], d3: null }, error: null });
      },
    },
  };
  const check = new Function("sb", `return (${src});`)(sb) as (a: Record<string, unknown>) => Promise<unknown>;
  const base = { styleValue: "farm", checkId: "11111111-2222-3333-4444-555555555555", photoUrls: ["https://example.test/f1.jpg"], renders: [] };
  await check({ ...base, round: 0 });
  await check({ ...base, round: 2 });
  await check({ ...base });
  assertEquals(sent.length, 3);
  for (const b of sent) {
    assertEquals(b.action, "calibrate_style_check");
    assertEquals(b.frame, "front", "the check's gate key, on every round");
  }
  assertEquals(sent.map((b) => b.round), [0, 2, undefined], "and the round rides beside it as before");
});
