// ONE PRESS IS ONE CHARGE — and a press that took no money must not block the next one.
//
// WHY THIS EXISTS. `calGenerate` mints one idempotency key per press and keeps it until a draft
// lands, which is what makes a retry of a failed press reuse its key instead of taking a second
// $20 hold. The database half of that bargain was broken: `wallet_tx_idem` was unique on
// (client_id, idempotency_key) with NO state predicate, so a row kept its key after
// `releaseHold("model timeout")` gave the money back. The next press reused the key, the insert
// raised unique_violation, and `wallet_hold`'s blanket handler — which could not tell WHICH
// index had fired — answered 'hold_in_flight'. portal-settings turned that into
//
//     409 "A 3D generation is already running for this account - wait for it to finish."
//
// for a generation that had finished minutes earlier, on every subsequent press for that style,
// until the tab was reloaded. And when the server had SUCCEEDED and only the reply was lost, the
// same 409 stood in front of a draft the builder had already paid $20 for.
//
// Migration 248 fixes both halves and this pins them together, because they only work as a
// pair: the index has to stop counting released rows, AND wallet_hold has to look the key up so
// 'posted' can be told apart from 'held'. Losing either one silently restores the trap.
//
// ⚠️ WHAT THIS DOES NOT PROVE. That Postgres evaluates the partial index this way — the suite
// has no database. What it proves is that 248 still declares both halves, that every error code
// the function can return is one portal-settings knows about, and that the reply the builder
// reads for a paid-and-lost press is a true sentence rather than the concurrency one.
//
// ⚠️ 248 IS WRITTEN, NOT APPLIED. Until an operator applies it by hand, wallet_hold never
// returns 'hold_replayed' and the branch below is unreachable — which is safe, because the
// meter is disarmed and no wallet_transactions row for this meter exists at all.

import { assert, assertEquals } from "jsr:@std/assert";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");

const MIG = await read("../../../migrations/248_wallet_released_key_reusable.sql");
const SRC = await read("../../portal-settings/index.ts");

// ── HALF ONE: the index stops counting rows that took no money ───────────────────────────
Deno.test("248 makes wallet_tx_idem partial, so a RELEASED key is free to be used again", () => {
  assert(MIG.includes("drop index if exists public.wallet_tx_idem"), "the old index is replaced, not added beside");
  const i = MIG.indexOf("create unique index if not exists wallet_tx_idem");
  assert(i > 0, "and recreated");
  const decl = MIG.slice(i, MIG.indexOf(";", i));
  assert(decl.includes("(client_id, idempotency_key)"), "on the same columns");
  assert(decl.includes("idempotency_key is not null"), "keeping the original predicate");
  assert(
    decl.includes("state <> 'released'"),
    "AND excluding released rows — without this the whole migration is a no-op",
  );
  // 'posted' must still collide, or the paid-and-lost case becomes a second $20.
  assert(!decl.includes("posted"), "a POSTED row still blocks: that is the charge being idempotent");
});

// ── HALF TWO: the handler stops guessing which index fired ───────────────────────────────
Deno.test("248's unique_violation handler reads the row instead of assuming a concurrent press", () => {
  const i = MIG.indexOf("when unique_violation then");
  assert(i > 0, "the handler is still there");
  const block = MIG.slice(i);
  assert(block.includes("select t.id, t.state into v_prev_id, v_prev_state"), "it looks the key up");
  assert(block.includes("t.idempotency_key = p_idem"), "by the key that collided");
  assert(block.includes("t.client_id = p_client_id"), "scoped to the tenant, like the index");
  assert(block.includes("if v_prev_state = 'posted' then"), "and branches on what it found");
  assert(block.includes("'hold_replayed'"), "posted gets its own code");
  // Two ways to reach 'hold_in_flight' and both must survive: no key at all (so the collision
  // was the one-hold index), and a row that really is still held.
  assertEquals(block.split("'hold_in_flight'; return;").length - 1, 2, "both concurrency paths still answer hold_in_flight");
  assert(block.includes("if p_idem is null or p_idem = '' then"), "a keyless caller is the one-hold index by construction");
  // hold_id must stay null for a replay: a caller handed the posted row as a live hold would
  // capture it a second time.
  const replay = block.slice(block.indexOf("if v_prev_state = 'posted' then"));
  assert(
    replay.slice(0, replay.indexOf("'hold_replayed'")).includes("null::bigint"),
    "and it hands back NO hold id — there is no live hold to capture",
  );
});

Deno.test("248 refuses to report success if either half did not land", () => {
  const i = MIG.indexOf("do $$");
  assert(i > 0, "there is a verification block, the way 226 and 247 have one");
  const block = MIG.slice(i);
  assert(block.includes("pg_get_expr(i.indpred"), "it reads the index predicate back");
  assert(block.includes("released"), "and checks the predicate for the state it exists to exclude");
  assert(block.includes("hold_replayed"), "and reads the function body back for the new code");
  assertEquals(block.split("raise exception").length - 1, 3, "three separate ways to fail loudly");
});

// ── THE SENTENCE THE BUILDER READS ───────────────────────────────────────────────────────
Deno.test("⚠️ a paid-and-lost press is told the truth, not that something is still running", () => {
  const i = SRC.indexOf(`if (err === "hold_replayed")`);
  assert(i > 0, "portal-settings handles the new code");
  const branch = SRC.slice(i, SRC.indexOf("\n      }", i));
  assert(branch.includes("We already charged you for this generation"), "it says the money was taken");
  assert(branch.includes("NOT been charged twice"), "and that this press took none");
  // ⚠️ IT MUST NOT PROMISE THE DRAFT BACK. It is on the ledger row, but openCalEditor seeds
  // from building_styles.d3, which is only written on Save -- so nothing reads it back and a
  // message saying "reopen the Designer to pick it up" would be false.
  assert(branch.includes("the draft is gone"), "and does not pretend the draft can be recovered");
  assert(branch.includes("Reload this page"), "and names what actually clears the stuck key");
  assert(branch.includes("the next press will be a new charge"), "and what that costs, before they press it");
  assert(!/already running/.test(branch), "and never the concurrency sentence, which is the defect");
  assert(branch.includes(", 409)"), "still a refusal");
  assert(branch.includes(`code: "already_charged"`), "with a code a browser can branch on");
  assert(branch.includes('.from("ai_style_calls").delete()'), "the ledger row it just wrote is cleaned up");
  assert(!branch.includes("wallet_capture"), "⚠️ and nothing is captured: there is no live hold here");
  assert(!branch.includes("releaseHold"), "⚠️ and nothing is released either");
  // Ordered after hold_in_flight so the common concurrency case keeps its own sentence.
  assert(SRC.indexOf(`if (err === "hold_in_flight")`) < i, "the concurrency branch still comes first");
});

Deno.test("⚠️ every code wallet_hold can return is one portal-settings knows about", () => {
  // The drift this catches: adding a return code to the function and leaving the caller to fall
  // through it. `if (!err) holdId = ...` means an unhandled code runs the generation FREE, with
  // no hold, no record and no refusal — which is the failure direction the wallet was
  // deliberately built to avoid.
  const fn = MIG.slice(MIG.indexOf("create or replace function public.wallet_hold"));
  const codes = [...fn.matchAll(/,\s*'([a-z_]+)';\s*return;/g)].map((m) => m[1]);
  assert(codes.length >= 5, `found ${codes.length} codes, expected the full ladder: ${codes.join(", ")}`);
  for (const c of new Set(codes)) {
    assert(SRC.includes(c), `wallet_hold can answer '${c}' and portal-settings never mentions it`);
  }
  // Named individually as well, so a diff that drops one fails with its name rather than with a
  // count.
  for (const c of ["meter_unknown", "meter_inactive", "insufficient_funds", "hold_in_flight", "hold_replayed"]) {
    assert(new Set(codes).has(c), `248 no longer returns '${c}'`);
  }
});
