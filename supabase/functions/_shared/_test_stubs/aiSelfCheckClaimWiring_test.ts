// THE CLAIM, RUN. One paid generation buys exactly one free self-check, and this is the single
// statement that makes that true.
//
// WHY THIS EXISTS. The second pass is FREE by design: the $20 was held and captured by the
// first call and nothing in the check's own handler touches money. What stops it being an
// unlimited free vision call against our own API key is not a rate limit and not a counter — it
// is one conditional UPDATE that sets `self_check_at` only while it is still null and returns
// the row it touched. Every refusal the design promises is a filter on that statement:
//
//   .eq("id")               the row named, and it is a uuid, so it is unguessable
//   .eq("client_id")        and it is this tenant's
//   .eq("style_key")        and it belongs to the style whose frames are about to be shown
//   .is("self_check_at", null)   and no check has run on it — THE SINGLE-USE GUARD
//   .gt("called_at", since)      and it is younger than the window
//
// Delete any one of those five lines and nothing throws, nothing logs, no test that reads the
// verdict notices, and the feature quietly becomes what it was designed not to be. Losing
// `.is(...)` alone turns one paid row into an unlimited supply of free model calls. So the
// statement is lifted out of the shipped source and RUN, rather than described.
//
// HOW: the slice-and-run idiom aiLedgerDimsWiring_test, crmRecordGate_test and wallSlab_test
// use. The block is taken between stable anchors and executed against a hand-rolled client that
// applies those filters the way PostgREST does, so nothing is copied out and nothing can drift.
//
// ⚠️ WHAT THIS DOES NOT PROVE. That PostgREST and Postgres really evaluate the filters this way
// — that is an assumption ENCODED in the fake, not verified by it, because the suite runs with
// no network. What it proves is that the handler still ASKS for all five, and that its own
// reaction to each answer is the one the design calls for.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url)))
  .replace(/\r\n/g, "\n");

const START = "    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();";
const END = "    // ── THE RULER ──";
const i = SRC.indexOf(START);
const j = i < 0 ? -1 : SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    "aiSelfCheckClaimWiring_test: could not find the calibrate_style_check claim in " +
      `portal-settings/index.ts (start=${i}, end=${j}). The anchors moved — re-point them ` +
      "rather than deleting this test.",
  );
}
if (SRC.indexOf(START, i + 1) >= 0) {
  throw new Error("aiSelfCheckClaimWiring_test: the start anchor is no longer unique — re-point it.");
}
const BLOCK = SRC.slice(i, j);

// ── THE FIVE FILTERS, AS TEXT ─────────────────────────────────────────────────────────────
// Asserted separately from the executed cases below because a filter can be lost in two ways:
// removed (the cases catch it) or replaced by one that happens to pass the fixtures. Naming
// each one here means a diff that drops it fails with the name of what it dropped.
for (const filter of [
  `.eq("id", checkId)`,
  `.eq("client_id", clientId)`,
  `.eq("style_key", styleValue)`,
  `.is("self_check_at", null)`,
  `.gt("called_at", since)`,
]) {
  assert(BLOCK.includes(filter), `the claim lost ${filter} — that is a refusal the design promises`);
}
// `returning`, not read-then-write. Two presses landing together would BOTH pass a read.
assert(BLOCK.includes(".update("), "the claim must WRITE, not read");
assert(
  BLOCK.indexOf(".update(") < BLOCK.indexOf(".select("),
  "the select rides on the update's RETURNING — a select before it would be a read-then-write race",
);
assertEquals(BLOCK.split(".update(").length - 1, 1, "exactly one write: a second would be a second claim");
assert(BLOCK.includes("409"), "no row back is a refusal, not a silent skip");

// ── AND WHICH ROW A DEPLOY-BEFORE-247 ACTUALLY PRODUCES ───────────────────────────────────
// Migration 247 adds `client_settings.ai_style_self_check` in the same file as the eight
// ai_style_calls columns, and the kill-switch read is the FIRST statement in this action to
// reach the database. So with 247 unapplied PostgREST refuses THERE, this claim is never
// issued, and `ai_selfcheck_claim_failed` cannot be the signal however plausible it reads --
// which is what the code comment, this test's own next case and the handover all used to say.
// Both halves are pinned: the ordering, and that the row which DOES fire names the migration.
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
  "and the claim's row must NOT name it: that row can only ever be a transient database fault",
);

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** A stand-in for `ai_style_calls` under PostgREST: filters accumulate, and `maybeSingle()`
 *  applies the update to the rows that match and returns the selected columns of the first. */
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
          const chain: Row = {
            eq(col: string, val: unknown) { filters.push(["eq", col, val]); return chain; },
            is(col: string, val: unknown) { filters.push(["is", col, val]); return chain; },
            gt(col: string, val: unknown) { filters.push(["gt", col, val]); return chain; },
            select(cols: string) { chain._cols = cols.split(",").map((c) => c.trim()); return chain; },
            // deno-lint-ignore require-await
            async maybeSingle() {
              if (opts.fail) return { data: null, error: { message: opts.fail } };
              const hit = rows.filter((r) =>
                filters.every(([op, col, val]) =>
                  op === "eq" ? r[col] === val
                    : op === "is" ? (r[col] ?? null) === val
                      : String(r[col]) > String(val)
                )
              );
              if (!hit.length) return { data: null, error: null };
              Object.assign(hit[0], patch);
              const out: Row = {};
              for (const c of (chain._cols ?? [])) out[c] = hit[0][c];
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
const OTHER = "tenant-b";
const ID = "11111111-2222-3333-4444-555555555555";
const STYLE = "lofted-barn";
const D3 = { roof: { type: "gambrel", overhang: 1 }, siding: "lap", colors: {}, wallHeightFt: 9 };
const DIMS = { widthFt: 16, lengthFt: 24, wallHeightFt: 9 };

function freshRow(over: Row = {}): Row {
  return {
    id: ID,
    client_id: TENANT,
    style_key: STYLE,
    called_at: new Date(Date.now() - 60 * 1000).toISOString(),  // a minute ago
    self_check_at: null,
    drafted: D3,
    dims: DIMS,
    ...over,
  };
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
async function runClaim(opts: { rows: Row[]; clientId?: string; styleValue?: string; checkId?: string; fail?: string }): Promise<Outcome> {
  const admin = fakeAdmin(opts.rows, { fail: opts.fail });
  const logged: string[] = [];
  let status: number | null = null;
  let body: Row | null = null;
  let skippedReason: string | null = null;
  const factory = new Function(
    "admin", "checkId", "clientId", "styleValue", "logEdgeError", "req", "json", "skipped",
    `return (async () => { ${BLOCK} return { fellThrough: true, claimed }; })();`,
  );
  const res = await factory(
    admin,
    opts.checkId ?? ID,
    opts.clientId ?? TENANT,
    opts.styleValue ?? STYLE,
    // deno-lint-ignore require-await
    async (e: { code: string }) => { logged.push(e.code); },
    null,
    (b: Row, s = 200) => { body = b; status = s; return { refused: true }; },
    (reason: string) => { skippedReason = reason; return { refused: true }; },
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

Deno.test("a fresh row is claimed once, and hands back the draft and the ruler", async () => {
  const rows = [freshRow()];
  const r = await runClaim({ rows });
  assert(r.fellThrough, "the claim passed and the check may run");
  assertEquals(r.claimed, { drafted: D3, dims: DIMS }, "and it returned exactly what the check needs");
  assert(rows[0].self_check_at, "the row is marked used BEFORE any model call");
  assertEquals(r.logged, [], "a healthy claim is silent");
});

Deno.test("⚠️ THE SINGLE-USE GUARD: the second request for the same row gets no row, and a 409", async () => {
  // Without this, one $20 generation is an unlimited supply of free vision calls.
  const rows = [freshRow()];
  const first = await runClaim({ rows });
  assert(first.fellThrough, "the first one runs");
  const second = await runClaim({ rows });
  assert(!second.fellThrough, "the second one does not");
  assertEquals(second.status, 409);
  assertEquals(second.body?.code, "check_unavailable");
  assertEquals(second.logged, [], "a refusal is not a fault");
});

Deno.test("a stale generation refuses: the window is fifteen minutes", async () => {
  const stale = [freshRow({ called_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() })];
  assertEquals((await runClaim({ rows: stale })).status, 409, "sixteen minutes is too old");
  const inside = [freshRow({ called_at: new Date(Date.now() - 14 * 60 * 1000).toISOString() })];
  assert((await runClaim({ rows: inside })).fellThrough, "fourteen is not");
});

Deno.test("⚠️ another tenant's generation refuses, and so does another style's", async () => {
  // clientId is JWT-resolved and never read off the body, so this is what stops a crafted
  // checkId reaching into someone else's ledger. The style scope is narrower and its own point:
  // it stops one generation's draft being compared against a DIFFERENT style's stored frames —
  // both the caller's own, so not a breach, but two buildings presented as one.
  assertEquals((await runClaim({ rows: [freshRow()], clientId: OTHER })).status, 409, "not your row");
  assertEquals((await runClaim({ rows: [freshRow()], styleValue: "other-style" })).status, 409, "not that style");
  assertEquals((await runClaim({ rows: [freshRow()], checkId: "22222222-2222-2222-2222-222222222222" })).status, 409, "no such row");
  // And none of the three left a mark on the row they were aimed at.
  const rows = [freshRow()];
  await runClaim({ rows, clientId: OTHER });
  assertEquals(rows[0].self_check_at, null, "a refused claim does not spend the check");
});

Deno.test("⚠️ a claim that ERRORS skips the check rather than running it unclaimed", async () => {
  // A transient database fault — a dropped connection, a statement timeout, a permission
  // change. What matters is that the handler STOPS here rather than carrying on to the model
  // call with the row unclaimed, which would be a second free vision call on one ledger row.
  //
  // NOT an unapplied migration 247, which this case used to claim and used to seed itself
  // with. The kill-switch read above the claim names `client_settings.ai_style_self_check`,
  // which 247 adds in the same file, and it is the first statement in the action to reach the
  // database — so a missing 247 is refused there and never reaches this statement at all. The
  // injected failure below is a plain connection fault for that reason.
  const r = await runClaim({
    rows: [freshRow()],
    fail: "canceling statement due to statement timeout",
  });
  assert(!r.fellThrough, "it does not reach the model");
  assertEquals(r.skipped, "unavailable", "and it answers as a skipped check, not a failed generation");
  assertEquals(r.logged, ["ai_selfcheck_claim_failed"], "with one coded row");
  assertEquals(r.status, null, "no 409: nothing was refused, something was broken");
});
