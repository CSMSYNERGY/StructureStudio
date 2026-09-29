// THE CLAIM, RUN. One paid generation buys at most SELF_CHECK_MAX_ROUNDS free self-check rounds,
// one at a time, and this is the single statement that makes that true.
//
// WHY THIS EXISTS. The self-check is FREE by design: the $20 was held and captured by the first
// call and nothing in the check's own handler touches money. What stops it being an unlimited
// free vision call against our own API key is not a rate limit — it is one conditional UPDATE
// with `returning`. Until v2 it set `self_check_at` only while it was null (single-use). Since
// migration 252 it is a COMPARE-AND-SWAP ON THE ROUND (rewritten deliberately, 2026-09-24):
//
//   .eq("id")                    the row named, and it is a uuid, so it is unguessable
//   .eq("client_id")             and it is this tenant's
//   .eq("style_key")             and it belongs to the style whose frames are about to be shown
//   .eq("self_check_round", round)   and exactly this round is next — THE COUNTER; the patch
//                                    moves it to round + 1, so no round runs twice
//   .gt("called_at", since)      and it is younger than the window
//   round 0:  .is("self_check_at", null)             247's single-use guard, verbatim — which is
//                                                    what keeps an OLDER BROWSER (no `round` =
//                                                    round 0) on exactly one check, and keeps a
//                                                    row checked before 252 from a second one
//   round k>0: .eq("self_check_verdict", "corrections")   only after a round that finished AND
//                                                    changed something; the patch clears the
//                                                    verdict, so two rounds never run at once
//
// Delete any one of those lines and nothing throws, nothing logs, no test that reads the verdict
// notices, and the feature quietly becomes what it was designed not to be. So the statement is
// lifted out of the shipped source and RUN, rather than described.
//
// HOW: the slice-and-run idiom aiLedgerDimsWiring_test, crmRecordGate_test and wallSlab_test use.
// The block is taken between stable anchors and executed against a hand-rolled client that
// applies those filters the way PostgREST does, so nothing is copied out and nothing can drift.
// The per-round history write (appendRound) is lifted and run the same way.
//
// ⚠️ WHAT THIS DOES NOT PROVE. That PostgREST and Postgres really evaluate the filters this way —
// that is an assumption ENCODED in the fake, not verified by it, because the suite runs with no
// network. What it proves is that the handler still ASKS for all of them, and that its own
// reaction to each answer is the one the design calls for.

import { assert, assertEquals } from "jsr:@std/assert";
import { parseSelfCheckRound, SELF_CHECK_CLAIM_WINDOW_MS, SELF_CHECK_MAX_ROUNDS } from "../styleD3.ts";

const SRC = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url)))
  .replace(/\r\n/g, "\n");

function lift(start: string, end: string, what: string): { at: number; block: string } {
  const i = SRC.indexOf(start);
  const j = i < 0 ? -1 : SRC.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `aiSelfCheckClaimWiring_test: could not find ${what} in portal-settings/index.ts ` +
        `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
    );
  }
  if (SRC.indexOf(start, i + 1) >= 0) {
    throw new Error(`aiSelfCheckClaimWiring_test: the start anchor for ${what} is no longer unique — re-point it.`);
  }
  return { at: i, block: SRC.slice(i, j) };
}

const CLAIM = lift(
  "    const since = new Date(Date.now() - SELF_CHECK_CLAIM_WINDOW_MS).toISOString();",
  "    // ── THE RULER ──",
  "the calibrate_style_check claim",
);
const BLOCK = CLAIM.block;
const i = CLAIM.at;
// appendRound's signature is its only typed line and is the anchor, so the body is plain JS.
const APPEND_SIG = "    const appendRound = async (entry: Record<string, any>) => {";
const APPEND = lift(APPEND_SIG, "\n    };\n\n    // THE CHECK FAILED AND THE GENERATION DID NOT.", "appendRound").block
  .slice(APPEND_SIG.length);
// The whole action, for the ROW-not-caller pin below.
const ACTION = lift('  if (action === "calibrate_style_check") {', "  // Reorder this tenant's building styles.", "the action").block;

// ── THE FILTERS, AS TEXT ──────────────────────────────────────────────────────────────────
// Asserted separately from the executed cases below because a filter can be lost in two ways:
// removed (the cases catch it) or replaced by one that happens to pass the fixtures. Naming
// each one here means a diff that drops it fails with the name of what it dropped.
for (const filter of [
  `.eq("id", checkId)`,
  `.eq("client_id", clientId)`,
  `.eq("style_key", styleValue)`,
  `.eq("self_check_round", round)`,
  `.gt("called_at", since)`,
  `.is("self_check_at", null)`,
  `.eq("self_check_verdict", "corrections")`,
]) {
  assert(BLOCK.includes(filter), `the claim lost ${filter} — that is a refusal the design promises`);
}
// The swap half of the compare-and-swap: both patches move the counter on by exactly one.
assert(BLOCK.includes("self_check_round: 1"), "round 0's claim moves the counter to 1");
assert(BLOCK.includes("self_check_round: round + 1"), "a later round's claim moves it to round + 1");
assert(BLOCK.includes("self_check_verdict: null"), "and clears the verdict while that round runs");
// `returning`, not read-then-write. Two presses landing together would BOTH pass a read.
assert(BLOCK.includes(".update("), "the claim must WRITE, not read");
assert(
  BLOCK.indexOf(".update(") < BLOCK.indexOf(".select("),
  "the select rides on the update's RETURNING — a select before it would be a read-then-write race",
);
assertEquals(BLOCK.split(".update(").length - 1, 1, "exactly one write: a second would be a second claim");
assert(BLOCK.includes("409"), "no row back is a refusal, not a silent skip");

// ── AND WHICH ROW A DEPLOY BEFORE A MIGRATION ACTUALLY PRODUCES ──────────────────────────
// Migration 247 adds `client_settings.ai_style_self_check` in the same file as the eight
// ai_style_calls columns, and the kill-switch read is the FIRST statement in this action to
// reach the database — so with 247 unapplied PostgREST refuses THERE and the claim is never
// issued. 252 is the other way round: nothing before the claim names a 252 column, and the
// claim names `self_check_round`, so with 252 unapplied it is the CLAIM that is refused, on
// every check. Each row has to name the migration it is actually the tell for.
const SWITCH = '.select("ai_style_self_check")';
assert(SRC.includes(SWITCH), "the kill switch is still read from client_settings");
assertEquals(SRC.split(SWITCH).length - 1, 1, "and there is exactly one such read to reason about");
assert(SRC.indexOf(SWITCH) < i, "it is read BEFORE the claim, which is what makes it the 247 tell");
const near = (code: string) => {
  const at = SRC.indexOf(`code: "${code}"`);
  assert(at > 0, `${code} is still logged somewhere`);
  return SRC.slice(at, at + 400);
};
assert(
  near("ai_selfcheck_switch_unreadable").includes("migration 247 may not be applied"),
  "so the switch-unreadable row has to name migration 247 -- it is the one an operator will see",
);
assert(
  !near("ai_selfcheck_claim_failed").includes("migration 247"),
  "and the claim's row must NOT name 247: the switch read above answers for that one",
);
assert(
  near("ai_selfcheck_claim_failed").includes("migration 252 may not be applied"),
  "but it MUST name 252: the claim is the first statement to touch self_check_round",
);
// Nothing that RUNS before the claim names a 252 column: comments aside, the only mention is
// appendRound's guard, and appendRound is only ever called once a round has been claimed.
const preClaimCode = SRC.slice(SRC.indexOf('if (action === "calibrate_style_check")'), i)
  .replace(APPEND, "")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
assert(!preClaimCode.includes("self_check_round"),
  "and nothing before the claim names a 252 column, which is what makes the claim the 252 tell");

// ── THE ROW, NEVER THE CALLER, IN EVERY ROUND ─────────────────────────────────────────────
// The only things the request may carry are the style, the generation id, the round, the image
// positions and the render bytes. A `payload.draft` or `payload.d3` here would be the free,
// caller-controlled vision call the whole design exists to prevent — and a later round is the
// obvious place for one to creep in ("the browser already has the corrected spec").
// `frame` (fix, 2026-09-24) is the check's rollout gate -- it picks WHICH check runs (the v2 one or
// d3ab404's, see aiSelfCheckGateWiring_test) and reaches the model as nothing at all.
const readsOffPayload = [...new Set([...ACTION.matchAll(/payload\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort();
assertEquals(readsOffPayload, ["checkId", "frame", "photoUrls", "renders", "round", "styleValue"],
  "the check reads nothing else off the request");
assert(ACTION.includes("sanitizeD3Spec(claimed.self_check_after ?? claimed.drafted)"),
  "a round judges the spec the ROW holds: the previous round's result, else the draft");
assert(ACTION.includes("parseKnownDims(claimed.dims)"), "and the ruler comes off the row too");
// History first, then the verdict: the verdict write is what unlocks the next round.
const ok = ACTION.lastIndexOf("await appendRound({ verdict: applied.verdict");
const rec = ACTION.lastIndexOf("await recordSelfCheck(checkId, {\n      self_check_verdict: applied.verdict");
assert(ok > 0 && rec > ok, "the round's history is written BEFORE the verdict that unlocks the next round");

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** A stand-in for `ai_style_calls` under PostgREST: filters accumulate; `maybeSingle()` (or a
 *  bare await) applies the update to the rows that match and returns the selected columns. */
function fakeAdmin(rows: Row[], opts: { fail?: string } = {}) {
  const calls: { filters: [string, string, unknown][]; patch: Row }[] = [];
  return {
    rows,
    calls,
    from(table: string) {
      assertEquals(table, "ai_style_calls", "the claim is on the generation ledger");
      return {
        update(patch: Row) {
          const filters: [string, string, unknown][] = [];
          const call = { filters, patch };
          calls.push(call);
          const run = () => {
            if (opts.fail) return { hit: null, error: { message: opts.fail } };
            const hit = rows.filter((r) =>
              filters.every(([op, col, val]) =>
                op === "eq" ? (r[col] ?? null) === val
                  : op === "is" ? (r[col] ?? null) === val
                    : String(r[col]) > String(val)
              )
            );
            if (!hit.length) return { hit: null, error: null };
            Object.assign(hit[0], structuredClone(patch));
            return { hit: hit[0], error: null };
          };
          const chain: Row = {
            eq(col: string, val: unknown) { filters.push(["eq", col, val]); return chain; },
            is(col: string, val: unknown) { filters.push(["is", col, val]); return chain; },
            gt(col: string, val: unknown) { filters.push(["gt", col, val]); return chain; },
            select(cols: string) { chain._cols = cols.split(",").map((c) => c.trim()); return chain; },
            // deno-lint-ignore require-await
            async maybeSingle() {
              const { hit, error } = run();
              if (error || !hit) return { data: null, error };
              const out: Row = {};
              for (const c of (chain._cols ?? [])) out[c] = hit[c] ?? null;
              return { data: out, error: null };
            },
            // A bare `await admin.from(...).update(...).eq(...)` — how appendRound writes.
            then(resolve: (v: unknown) => void) { const { error } = run(); resolve({ error }); },
          };
          return chain;
        },
      };
    },
  };
}

const TENANT = "tenant-a";
const OTHER = "tenant-b";
const ID = "11111111-2222-3333-4444-555555555555";
const STYLE = "lofted-barn";
const D3 = { roof: { type: "gambrel", overhang: 1 }, siding: "lap", colors: {}, wallHeightFt: 9 };
const AFTER = { roof: { type: "gambrel", overhang: 0.2 }, siding: "lap", colors: {}, wallHeightFt: 9 };
const DIMS = { widthFt: 16, lengthFt: 24, wallHeightFt: 9 };

/** A row exactly as the draft call leaves it once 252 is applied: round 0, never checked. */
function freshRow(over: Row = {}): Row {
  return {
    id: ID,
    client_id: TENANT,
    style_key: STYLE,
    called_at: new Date(Date.now() - 60 * 1000).toISOString(),  // a minute ago
    self_check_at: null,
    self_check_round: 0,
    self_check_verdict: null,
    self_check_after: null,
    self_check_changed: null,
    self_check_rounds: null,
    drafted: D3,
    dims: DIMS,
    ...over,
  };
}

/** What recordSelfCheck leaves behind when a round finishes — outside the lifted block, so the
 *  cases below write it the way the handler does: a verdict, and the result when it moved. */
function finishRound(row: Row, verdict: string, after: unknown = null) {
  row.self_check_verdict = verdict;
  if (verdict === "corrections") row.self_check_after = after;
}

type Outcome = {
  fellThrough: boolean;
  claimed: Row | null;
  status: number | null;
  body: Row | null;
  skipped: string | null;
  logged: string[];
};

/** Run the SHIPPED claim with the free variables the handler gives it. */
async function runClaim(opts: {
  rows: Row[];
  round?: number;
  clientId?: string;
  styleValue?: string;
  checkId?: string;
  fail?: string;
}): Promise<Outcome> {
  const admin = fakeAdmin(opts.rows, { fail: opts.fail });
  const logged: string[] = [];
  let status: number | null = null;
  let body: Row | null = null;
  let skippedReason: string | null = null;
  const factory = new Function(
    "admin", "checkId", "clientId", "styleValue", "round", "logEdgeError", "req", "json", "skipped", "SELF_CHECK_CLAIM_WINDOW_MS",
    `return (async () => { ${BLOCK} return { fellThrough: true, claimed }; })();`,
  );
  const res = await factory(
    admin,
    opts.checkId ?? ID,
    opts.clientId ?? TENANT,
    opts.styleValue ?? STYLE,
    opts.round ?? 0,
    // deno-lint-ignore require-await
    async (e: { code: string }) => { logged.push(e.code); },
    null,
    (b: Row, s = 200) => { body = b; status = s; return { refused: true }; },
    (reason: string) => { skippedReason = reason; return { refused: true }; },
    SELF_CHECK_CLAIM_WINDOW_MS,
  );
  return {
    fellThrough: !!res?.fellThrough,
    claimed: res?.claimed ?? null,
    status,
    body,
    skipped: skippedReason,
    logged,
  };
}

// ── ROUND 0: TODAY'S CHECK, UNCHANGED ─────────────────────────────────────────────────────

Deno.test("a fresh row is claimed once, and hands back the draft, the ruler and the history", async () => {
  const rows = [freshRow()];
  const r = await runClaim({ rows });
  assert(r.fellThrough, "the claim passed and the check may run");
  // draft_tokens (2026-09-26) carries the reads' samples, which say whether the pitch was measured
  // (measuredPitchLock); this fixture row has none.
  assertEquals(r.claimed, {
    drafted: D3, dims: DIMS, self_check_after: null, self_check_changed: null, self_check_rounds: null,
    draft_tokens: null,
  }, "and it returned exactly what the check needs, all of it off the row");
  assert(rows[0].self_check_at, "the row is marked used BEFORE any model call");
  assertEquals(rows[0].self_check_round, 1, "and round 0 has been counted");
  assertEquals(r.logged, [], "a healthy claim is silent");
});

Deno.test("⚠️ THE SINGLE-USE GUARD, for an older browser: a second round-0 request gets no row, and a 409", async () => {
  // Production's older bundle sends no `round`, which is round 0. Without this, one $20
  // generation from that browser would still be an unlimited supply of free vision calls.
  const rows = [freshRow()];
  const first = await runClaim({ rows });
  assert(first.fellThrough, "the first one runs");
  finishRound(rows[0], "corrections", AFTER);
  const second = await runClaim({ rows });
  assert(!second.fellThrough, "the second one does not — however the first one ended");
  assertEquals(second.status, 409);
  assertEquals(second.body?.code, "check_unavailable");
  assertEquals(second.logged, [], "a refusal is not a fault");
  assertEquals(parseSelfCheckRound(undefined), { ok: true, round: 0 }, "and no `round` really is round 0");
});

Deno.test("⚠️ a row checked BEFORE 252 can neither be checked again nor continued", async () => {
  // 252 adds self_check_round with DEFAULT 0, so a row the old code already checked reads round 0
  // with self_check_at set. Round 0's `self_check_at is null` is what keeps it from a second
  // check; round 1's `self_check_round = 1` is what keeps it from being continued.
  const old = () => [freshRow({ self_check_at: new Date().toISOString(), self_check_verdict: "corrections", self_check_after: AFTER })];
  assertEquals((await runClaim({ rows: old() })).status, 409, "no second round 0");
  assertEquals((await runClaim({ rows: old(), round: 1 })).status, 409, "and no round 1 either");
});

Deno.test("a stale generation refuses: the window is fifteen minutes, for every round", async () => {
  // One constant, shared with calibrate_style_ai_recover (a draft picked up past it has no map).
  assertEquals(SELF_CHECK_CLAIM_WINDOW_MS, 15 * 60 * 1000);
  const stale = [freshRow({ called_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() })];
  assertEquals((await runClaim({ rows: stale })).status, 409, "sixteen minutes is too old");
  const inside = [freshRow({ called_at: new Date(Date.now() - 14 * 60 * 1000).toISOString() })];
  assert((await runClaim({ rows: inside })).fellThrough, "fourteen is not");
  const staleLater = [freshRow({
    called_at: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    self_check_at: new Date().toISOString(), self_check_round: 1, self_check_verdict: "corrections",
  })];
  assertEquals((await runClaim({ rows: staleLater, round: 1 })).status, 409, "a later round keeps the same window");
});

Deno.test("⚠️ another tenant's generation refuses, and so does another style's, in every round", async () => {
  // clientId is JWT-resolved and never read off the body, so this is what stops a crafted
  // checkId reaching into someone else's ledger. The style scope is narrower and its own point:
  // it stops one generation's draft being compared against a DIFFERENT style's stored frames —
  // both the caller's own, so not a breach, but two buildings presented as one.
  for (const [round, over] of [[0, {}], [1, { self_check_at: "x", self_check_round: 1, self_check_verdict: "corrections" }]] as const) {
    assertEquals((await runClaim({ rows: [freshRow(over)], round, clientId: OTHER })).status, 409, `round ${round}: not your row`);
    assertEquals((await runClaim({ rows: [freshRow(over)], round, styleValue: "other-style" })).status, 409, `round ${round}: not that style`);
    assertEquals((await runClaim({ rows: [freshRow(over)], round, checkId: "22222222-2222-2222-2222-222222222222" })).status, 409, `round ${round}: no such row`);
  }
  // And none of them left a mark on the row they were aimed at.
  const rows = [freshRow()];
  await runClaim({ rows, clientId: OTHER });
  assertEquals(rows[0].self_check_at, null, "a refused claim does not spend the check");
  assertEquals(rows[0].self_check_round, 0, "or count a round");
});

Deno.test("⚠️ a claim that ERRORS skips the check rather than running it unclaimed", async () => {
  // A database fault — a dropped connection, a statement timeout — or 252 not applied yet (the
  // claim is the first statement to name self_check_round). What matters is that the handler
  // STOPS here rather than carrying on to the model call with the row unclaimed, which would be
  // a free vision call on a ledger row nobody spent.
  for (const round of [0, 1]) {
    const r = await runClaim({
      rows: [freshRow()], round,
      fail: 'column ai_style_calls.self_check_round does not exist',
    });
    assert(!r.fellThrough, `round ${round}: it does not reach the model`);
    assertEquals(r.skipped, "unavailable", "and it answers as a skipped check, not a failed generation");
    assertEquals(r.logged, ["ai_selfcheck_claim_failed"], "with one coded row");
    assertEquals(r.status, null, "no 409: nothing was refused, something was broken");
  }
});

// ── LATER ROUNDS: A COMPARE-AND-SWAP, AND ONLY AFTER CORRECTIONS ──────────────────────────

Deno.test("round 1 follows a round 0 that applied corrections, and hands back that round's result", async () => {
  const rows = [freshRow()];
  assert((await runClaim({ rows })).fellThrough, "round 0");
  finishRound(rows[0], "corrections", AFTER);
  const r1 = await runClaim({ rows, round: 1 });
  assert(r1.fellThrough, "round 1 runs");
  assertEquals(r1.claimed?.self_check_after, AFTER, "and it gets round 0's result, off the ROW, to judge");
  assertEquals(r1.claimed?.drafted, D3, "with the first draft beside it, untouched");
  assertEquals(rows[0].self_check_round, 2, "the counter moved on by one");
  assertEquals(rows[0].self_check_verdict, null, "and the verdict is cleared while round 1 runs");
  assert(rows[0].self_check_at, "self_check_at still says when the check was first claimed");
});

Deno.test("⚠️ THE SERVER STOPS ON ANYTHING BUT CORRECTIONS, whatever the browser asks", async () => {
  // matches, failed, skipped and rejected_too_many all end the rounds. A browser that keeps
  // asking gets a 409, and spends nothing.
  for (const verdict of ["matches", "failed", "skipped", "rejected_too_many"]) {
    const rows = [freshRow()];
    await runClaim({ rows });
    finishRound(rows[0], verdict);
    const r = await runClaim({ rows, round: 1 });
    assertEquals(r.status, 409, `after ${verdict}, round 1 is refused`);
    assertEquals(rows[0].self_check_round, 1, `and after ${verdict} nothing was counted`);
  }
});

Deno.test("⚠️ two rounds are never in flight at once", async () => {
  // Round 0 is claimed and its model call is still running (no verdict yet). A round-1 request
  // landing now would judge the same draft again, concurrently — the counter alone would let it
  // (the row already reads round 1), so the verdict filter is what refuses it.
  const rows = [freshRow()];
  await runClaim({ rows });
  assertEquals((await runClaim({ rows, round: 1 })).status, 409, "round 0 has not finished");
  // And the same one level up: round 1 claimed, still running, and round 2 asked for.
  finishRound(rows[0], "corrections", AFTER);
  assert((await runClaim({ rows, round: 1 })).fellThrough, "round 1 runs");
  assertEquals((await runClaim({ rows, round: 2 })).status, 409, "round 2 waits for round 1's verdict");
  assertEquals((await runClaim({ rows, round: 1 })).status, 409, "and round 1 cannot run twice");
});

Deno.test("⚠️ a round cannot be skipped, repeated or run out of order", async () => {
  const rows = [freshRow()];
  assertEquals((await runClaim({ rows, round: 1 })).status, 409, "no round 1 before round 0");
  assertEquals((await runClaim({ rows, round: 2 })).status, 409, "no round 2 before round 0");
  await runClaim({ rows });
  finishRound(rows[0], "corrections", AFTER);
  assertEquals((await runClaim({ rows, round: 2 })).status, 409, "no round 2 straight after round 0");
  assertEquals((await runClaim({ rows, round: 0 })).status, 409, "and round 0 is spent");
  assertEquals(rows[0].self_check_round, 1, "none of those moved the counter");
});

Deno.test("⚠️ THREE ROUNDS AND NO MORE: the whole ladder, end to end", async () => {
  const rows = [freshRow()];
  for (let round = 0; round < SELF_CHECK_MAX_ROUNDS; round++) {
    const read = parseSelfCheckRound(round);
    assert(read.ok, `round ${round} is a round`);
    const r = await runClaim({ rows, round });
    assert(r.fellThrough, `round ${round} runs`);
    finishRound(rows[0], "corrections", AFTER);
  }
  assertEquals(rows[0].self_check_round, SELF_CHECK_MAX_ROUNDS, "three claimed");
  // The fourth is refused BEFORE the database: parseSelfCheckRound answers 409 on its own ...
  const fourth = parseSelfCheckRound(SELF_CHECK_MAX_ROUNDS);
  assert(!fourth.ok && fourth.status === 409 && fourth.code === "check_unavailable", "round 3 is refused up front");
  // ... and even a request that got past that could not claim anything: every round the parse
  // allows is below the counter now.
  for (let round = 0; round < SELF_CHECK_MAX_ROUNDS; round++) {
    assertEquals((await runClaim({ rows, round })).status, 409, `round ${round} again`);
  }
});

// ── THE HISTORY WRITE ─────────────────────────────────────────────────────────────────────

async function runAppend(opts: { rows: Row[]; round: number; roundsBefore: unknown; fail?: string }) {
  const admin = fakeAdmin(opts.rows, { fail: opts.fail });
  const logged: string[] = [];
  const factory = new Function(
    "admin", "checkId", "clientId", "round", "logEdgeError", "req", "SELF_CHECK_MAX_ROUNDS", "roundsBefore",
    `return async (entry) => {${APPEND}\n};`,
  );
  const append = factory(
    admin, ID, TENANT, opts.round,
    // deno-lint-ignore require-await
    async (e: { code: string }) => { logged.push(e.code); },
    null, SELF_CHECK_MAX_ROUNDS, opts.roundsBefore,
  );
  return { append, logged, admin };
}

Deno.test("each round APPENDS its own entry, guarded on the round it claimed", async () => {
  const rows = [freshRow({ self_check_round: 2, self_check_rounds: [{ round: 0, verdict: "corrections" }] })];
  const { append, logged, admin } = await runAppend({ rows, round: 1, roundsBefore: rows[0].self_check_rounds });
  await append({ verdict: "matches", changed: [], ms: 1234, tokens: { input: 1, output: 2 }, renders: 6 });
  assertEquals(rows[0].self_check_rounds, [
    { round: 0, verdict: "corrections" },
    { round: 1, verdict: "matches", changed: [], ms: 1234, tokens: { input: 1, output: 2 }, renders: 6 },
  ], "round 0's line kept, round 1's added after it");
  assertEquals(logged, [], "a healthy write is silent");
  // It wrote ONLY the history — never a verdict, never a spec — and only on this row, at this round.
  assertEquals(Object.keys(admin.calls[0].patch), ["self_check_rounds"]);
  assertEquals(admin.calls[0].filters.map((f) => f[1]).sort(), ["client_id", "id", "self_check_round"]);
});

Deno.test("⚠️ a LATE history write cannot overwrite a later round's", async () => {
  // Round 1's write arriving after round 2 was claimed (the counter reads 3) lands nowhere.
  const later = [{ round: 0 }, { round: 1 }, { round: 2 }];
  const rows = [freshRow({ self_check_round: 3, self_check_rounds: later })];
  const { append } = await runAppend({ rows, round: 1, roundsBefore: [{ round: 0 }] });
  await append({ verdict: "corrections", changed: [], ms: 1, tokens: null, renders: 4 });
  assertEquals(rows[0].self_check_rounds, later, "the later history stands");
});

Deno.test("a history write that fails is one coded row, never a thrown check", async () => {
  const rows = [freshRow({ self_check_round: 1 })];
  const { append, logged } = await runAppend({ rows, round: 0, roundsBefore: null, fail: "statement timeout" });
  await append({ verdict: "matches", changed: [], ms: 1, tokens: null, renders: 4 });
  assertEquals(logged, ["ai_selfcheck_rounds_log_failed"]);
});

Deno.test("junk in the column is not carried forward as history", async () => {
  const rows = [freshRow({ self_check_round: 1, self_check_rounds: "not an array" })];
  const { append } = await runAppend({ rows, round: 0, roundsBefore: "not an array" });
  await append({ verdict: "matches", changed: [], ms: 1, tokens: null, renders: 4 });
  assertEquals(rows[0].self_check_rounds, [{ round: 0, verdict: "matches", changed: [], ms: 1, tokens: null, renders: 4 }]);
});
