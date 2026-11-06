// Unit tests for the unattended wallet recharge (migration 164's rule, shared since 259).
//
// runAutoTopup is the only code that charges a card with nobody present, and since 259 it has
// three triggers instead of one — a 3D hold, the usage cron and every refused text or call — so
// two of them landing in the same second is ordinary. The properties pinned here are the ones
// that keep that from costing a builder twice: the cooldown stamp is a CLAIM the database
// arbitrates, a stamp that may not have landed means no charge, a decline switches the feature
// off, and another top-up in flight does NOT.
//
// The card never moves: chargeTopup is injected (the `deps` seam), the database is a recording
// fake, and the logger is a recording fake. walletAutoTopup.ts statically imports logError.ts
// (and so supabase-js), exactly like emailSend.test.ts's subject does; nothing here calls it.
// Runs with --allow-read for one check against walletTopup.ts's shipped source.
//
// 317 (stored credentials) added three more properties, pinned at the bottom: it charges as a
// merchant-initiated unscheduled charge naming the card's unscheduled initial, it charges only
// when the builder's first top-up AND their recorded agreement exist (otherwise it switches
// itself off, uncharged), and every charge sends the owners a receipt. Plus the daily cap.

import { autoTopupCallerAllowed, runAutoTopup, type AutoTopupDeps } from "./walletAutoTopup.ts";
import { AUTO_TOPUP_COOLDOWN_MS, type TopupResult } from "./walletTopup.ts";
import { AUTO_TOPUP_DAILY_MAX } from "./cofConsent.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// A tenant set to keep $100, topping up $250, with $30 available and a card on file.
const DUE = {
  balance_cents: 3000,
  held_cents: 0,
  auto_topup_enabled: true,
  auto_topup_threshold_cents: 10000,
  auto_topup_amount_cents: 25000,
  auto_topup_last_at: null as string | null,
  auto_topup_consent_id: 77 as number | null,
};

type Op = [string, ...unknown[]];
type World = {
  acct?: Record<string, unknown> | null;
  vault?: string | null;
  /** Rows the conditional stamp matches. Default: the one row (the claim is won). */
  claimRows?: unknown[];
  claimError?: { message: string } | null;
  /** Make the very first read throw, to drive the crash path. */
  explode?: boolean;
  /** billing_customers.unscheduled_initial_txn. Default "init-1"; null = none. */
  initial?: string | null;
  /** MIT attempts in the last 24 h, as rows. Default none. */
  recent?: unknown[];
  /** The daily-count read fails. */
  recentError?: { message: string } | null;
};

function fakeAdmin(world: World) {
  const writes: { table: string; ops: Op[] }[] = [];
  const admin = {
    from(table: string) {
      if (world.explode) throw new Error("the client is broken");
      const ops: Op[] = [];
      const q: Record<string, unknown> = {};
      const step = (name: string) => (...a: unknown[]) => { ops.push([name, ...a]); return q; };
      for (const m of ["select", "update", "eq", "or", "is", "lt", "gte", "limit"]) q[m] = step(m);
      const isUpdate = () => ops.some((o) => o[0] === "update");
      q.maybeSingle = () => {
        if (table === "wallet_accounts") return Promise.resolve({ data: world.acct === undefined ? DUE : world.acct, error: null });
        if (table === "billing_customers") {
          return Promise.resolve({
            data: world.vault === null ? null : {
              vault_id: world.vault ?? "vault-1",
              unscheduled_initial_txn: world.initial === undefined ? "init-1" : world.initial,
              card_last4: "4242",
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      };
      // Awaiting an update chain: the claim (it ends in .select) or a plain write.
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
        if (isUpdate()) writes.push({ table, ops });
        const isClaim = isUpdate() && ops.some((o) => o[0] === "or");
        const res = isClaim
          ? (world.claimError ? { data: null, error: world.claimError } : { data: world.claimRows ?? [{ client_id: "tenant-a" }], error: null })
          : !isUpdate() && table === "billing_charge_attempts"
          ? (world.recentError ? { data: null, error: world.recentError } : { data: world.recent ?? [], error: null })
          : { data: null, error: null };
        return Promise.resolve(res).then(ok, bad);
      };
      return q;
    },
  };
  return { admin, writes };
}

const CHARGED: TopupResult = { ok: true, balanceCents: 28000, saleTxn: "txn-1", alreadyCredited: false, attemptId: 41, vaultId: "vault-1", cofSupported: "stored" };

function harness(world: World, charge: TopupResult | (() => never) = CHARGED, deps: AutoTopupDeps = {}) {
  const { admin, writes } = fakeAdmin(world);
  const charges: Record<string, unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const receipts: unknown[][] = [];
  const full: AutoTopupDeps = {
    sendReceipt: ((...a: unknown[]) => { receipts.push(a); return Promise.resolve({ sent: 1, error: null }); }) as unknown as AutoTopupDeps["sendReceipt"],
    now: () => NOW,
    chargeTopup: ((_a: unknown, opts: Record<string, unknown>) => {
      charges.push(opts);
      return typeof charge === "function" ? charge() : Promise.resolve(charge);
    }) as unknown as AutoTopupDeps["chargeTopup"],
    logError: ((input: Record<string, unknown>) => { logs.push(input); return Promise.resolve(); }) as unknown as AutoTopupDeps["logError"],
    ...deps,
  };
  return { run: () => runAutoTopup(admin, "tenant-a", null, full), writes, charges, logs, receipts };
}

const updatesOf = (writes: { table: string; ops: Op[] }[]) =>
  writes.map((w) => (w.ops.find((o) => o[0] === "update") ?? [])[1] as Record<string, unknown>);

// ── Not due: nothing is written and nothing is charged ───────────────────────────────

Deno.test("not enabled, no card, above threshold: no claim, no charge, the decision's reason", async () => {
  for (const [world, reason] of [
    [{ acct: { ...DUE, auto_topup_enabled: false } }, "not enabled"],
    [{ vault: null }, "no card on file"],
    [{ acct: { ...DUE, balance_cents: 50000 } }, "above threshold"],
    [{ acct: null }, "no wallet account"],
    [{ acct: { ...DUE, auto_topup_last_at: iso(NOW - 60_000) } }, "cooling down"],
  ] as const) {
    const h = harness(world as World);
    const out = await h.run();
    assertEquals(out, { fired: false, ok: true, reason }, reason);
    assertEquals(h.writes.length, 0, `${reason}: no write`);
    assertEquals(h.charges.length, 0, `${reason}: no charge`);
  }
});

// ── Due: claim, then charge ──────────────────────────────────────────────────────────

Deno.test("due: the cooldown is CLAIMED (stamp + still-outside-cooldown condition) BEFORE the charge", async () => {
  const h = harness({});
  const out = await h.run();
  assertEquals(out, { fired: true, ok: true, reason: "charged" });

  assertEquals(h.writes.length, 1, "exactly one write: the claim");
  const ops = h.writes[0].ops;
  assertEquals(h.writes[0].table, "wallet_accounts");
  assertEquals(ops.find((o) => o[0] === "update"), ["update", { auto_topup_last_at: iso(NOW) }]);
  assertEquals(ops.find((o) => o[0] === "eq"), ["eq", "client_id", "tenant-a"]);
  // The database re-checks the cooldown at write time: never stamped, or stamped over an hour ago.
  assertEquals(ops.find((o) => o[0] === "or"),
    ["or", `auto_topup_last_at.is.null,auto_topup_last_at.lte.${iso(NOW - AUTO_TOPUP_COOLDOWN_MS)}`]);
  assert(ops.some((o) => o[0] === "select"), "the claim reads back which rows it matched");

  assertEquals(h.charges, [{ clientId: "tenant-a", vaultId: "vault-1", amountCents: 25000, actorUserId: null, auto: true, cof: "mit_unscheduled", initialTxn: "init-1" }]);
  assertEquals(h.logs.length, 0, "a clean charge logs nothing");
});

Deno.test("LOST CLAIM: another request stamped this hour first — stand down, charge nothing", async () => {
  // The race this exists for: two refused texts a second apart both read "not cooling down".
  const h = harness({ claimRows: [] });
  assertEquals(await h.run(), { fired: false, ok: true, reason: "claimed_elsewhere" });
  assertEquals(h.charges.length, 0);
});

Deno.test("a claim that ERRORED may or may not have landed — no charge, and it is logged", async () => {
  const h = harness({ claimError: { message: "connection reset" } });
  assertEquals(await h.run(), { fired: false, ok: false, reason: "stamp_failed" });
  assertEquals(h.charges.length, 0, "an unrecorded cooldown is how one empty wallet becomes several sales");
  assertEquals(h.logs.map((l) => l.code), ["auto_topup_stamp_failed"]);
});

// ── After the charge ─────────────────────────────────────────────────────────────────

Deno.test("a DECLINE switches auto top-up off, records the reason, and logs it", async () => {
  const long = "Card declined: " + "x".repeat(400);
  const h = harness({}, { ok: false, error: long, blocking: false });
  assertEquals(await h.run(), { fired: true, ok: false, reason: "declined" });
  const ups = updatesOf(h.writes);
  assertEquals(ups.length, 2, "the claim, then the switch-off");
  assertEquals(ups[1], {
    auto_topup_enabled: false, auto_topup_consent_id: null,
    auto_topup_disabled_reason: `The card was declined (${long.slice(0, 200)}). Replace the card, then switch them back on.`,
  });
  assertEquals(h.receipts.length, 0, "no charge, no receipt");
  assertEquals(h.logs.map((l) => [l.code, l.fn]), [["auto_topup_declined", "wallet-autotopup"]]);
});

Deno.test("BLOCKING (gateway unknown / charged-not-credited) leaves it ENABLED and asks for a human", async () => {
  const h = harness({}, { ok: false, error: "We could not confirm whether your card was charged.", blocking: true });
  assertEquals(await h.run(), { fired: true, ok: false, reason: "needs_review" });
  assertEquals(updatesOf(h.writes).length, 1, "only the claim — nothing switches it off");
  assertEquals(h.logs.map((l) => l.code), ["auto_topup_unresolved"]);
});

Deno.test("ANOTHER TOP-UP IN PROGRESS is not a decline: auto top-up stays on, logged as info", async () => {
  // A builder pressing Add funds while a refused text asked for a top-up. Before 259 this
  // switched auto top-up off with "Another top-up is already in progress" as the reason.
  const h = harness({}, { ok: false, error: "Another top-up is already in progress. Give it a moment, then refresh.", blocking: false });
  assertEquals(await h.run(), { fired: true, ok: false, reason: "in_progress" });
  assertEquals(updatesOf(h.writes).length, 1, "only the claim — auto top-up is NOT switched off");
  assertEquals(h.logs.map((l) => [l.code, l.severity]), [["auto_topup_in_progress", "info"]]);
});

Deno.test("the in-progress match tracks chargeTopup's real wording (both of its refusals)", async () => {
  // The carve-out above matches on text. If walletTopup.ts rewords it, the carve-out silently
  // reverts to "switch off on a busy slot" — so the shipped source is read and pinned here.
  const src = await Deno.readTextFile(new URL("./walletTopup.ts", import.meta.url));
  const hits = src.match(/Another top-up is already in progress/g) ?? [];
  assertEquals(hits.length, 2, "chargeTopup's two in-progress refusals");
});

Deno.test("the outcome never carries the gateway's text — only fixed reasons", async () => {
  // wallet-autotopup returns this object verbatim; a decline message must stay in app_errors.
  const h = harness({}, { ok: false, error: "DECLINE card ending 0000 name TEST", blocking: false });
  const out = await h.run();
  assert(!JSON.stringify(out).includes("0000") && !JSON.stringify(out).includes("DECLINE"), JSON.stringify(out));
});

Deno.test("NEVER THROWS: a crash anywhere resolves as crashed and is logged under the caller's name", async () => {
  const broken = harness({ explode: true }, undefined, { fn: "portal-settings" });
  assertEquals(await broken.run(), { fired: false, ok: false, reason: "crashed" });
  assertEquals(broken.logs.map((l) => [l.code, l.fn]), [["auto_topup_crashed", "portal-settings"]]);

  const throwingCharge = harness({}, () => { throw new Error("nmi exploded"); });
  assertEquals(await throwingCharge.run(), { fired: false, ok: false, reason: "crashed" });

  // Even a logger that rejects on the crash path does not escape.
  const h = harness({ explode: true }, undefined, { logError: () => Promise.reject(new Error("log down")) });
  assertEquals(await h.run(), { fired: false, ok: false, reason: "crashed" });
});

Deno.test("portal-settings keeps its own name on the rows it causes", async () => {
  const h = harness({}, { ok: false, error: "Do not honor", blocking: false }, { fn: "portal-settings" });
  await h.run();
  assertEquals(h.logs.map((l) => l.fn), ["portal-settings"]);
});

// ── Who may call wallet-autotopup ────────────────────────────────────────────────────

const fakeJwt = (payload: Record<string, unknown>) =>
  `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify(payload)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.sig`;

Deno.test("the caller check: a gateway-verified service_role JWT, and nothing else by claim", () => {
  const keys = { serviceKey: "runtime-key", secret: "" };
  assert(autoTopupCallerAllowed(`Bearer ${fakeJwt({ role: "service_role" })}`, { ...keys, gatewayVerified: true }), "service_role claim, gateway verified");
  assert(!autoTopupCallerAllowed(`Bearer ${fakeJwt({ role: "service_role" })}`, keys), "the claim alone is not proof without the gateway");
  assert(!autoTopupCallerAllowed(`Bearer ${fakeJwt({ role: "authenticated" })}`, { ...keys, gatewayVerified: true }), "a signed-in user's token");
  assert(!autoTopupCallerAllowed(`Bearer ${fakeJwt({ role: "anon" })}`, { ...keys, gatewayVerified: true }), "the anon key");
  assert(!autoTopupCallerAllowed("Bearer not.a-jwt", { ...keys, gatewayVerified: true }), "garbage");
  assert(!autoTopupCallerAllowed("Bearer sb_secret_abc", { ...keys, gatewayVerified: true }), "a non-JWT key that is not configured");
});

Deno.test("wallet-autotopup keeps verify_jwt = true, which is what makes the role claim proof", async () => {
  const toml = (await Deno.readTextFile(new URL("../../config.toml", import.meta.url))).replace(/\r\n/g, "\n");
  const block = /\[functions\.wallet-autotopup\]\n([\s\S]*?)(?=\n\[|$)/.exec(toml);
  assert(block, "config.toml has no [functions.wallet-autotopup] block");
  const lines = (block?.[1] ?? "").split("\n").filter((l) => !/^\s*#/.test(l));
  assert(lines.some((l) => /^\s*verify_jwt\s*=\s*true\s*$/.test(l)), "verify_jwt must stay true for wallet-autotopup");
  const fn = await Deno.readTextFile(new URL("../wallet-autotopup/index.ts", import.meta.url));
  assert(fn.includes("gatewayVerified: true"), "the function no longer trusts the gateway; drop this test only with that");
});

Deno.test("the caller check: either key, constant-time, and an empty key never matches", () => {
  const keys = { serviceKey: "runtime-key", secret: "worker-key" };
  assert(autoTopupCallerAllowed("Bearer runtime-key", keys), "the runtime's own key");
  assert(autoTopupCallerAllowed("Bearer worker-key", keys), "the configured secret");
  assert(autoTopupCallerAllowed("bearer  worker-key ", keys), "scheme is case-insensitive, whitespace trimmed");
  assert(!autoTopupCallerAllowed("Bearer someone-else", keys), "a wrong key");
  assert(!autoTopupCallerAllowed("runtime-key", keys), "no Bearer scheme");
  assert(!autoTopupCallerAllowed("Basic runtime-key", keys), "another scheme");
  assert(!autoTopupCallerAllowed(null, keys), "no header");
  assert(!autoTopupCallerAllowed("Bearer ", keys), "an empty bearer");
  // timingSafeEqual("", "") is TRUE — an unset secret must not turn into an open door.
  assert(!autoTopupCallerAllowed("Bearer ", { serviceKey: "", secret: "" }), "nothing configured, nothing presented");
  assert(!autoTopupCallerAllowed("Bearer x", { serviceKey: "", secret: "" }), "nothing configured");
  assert(autoTopupCallerAllowed("Bearer runtime-key", { serviceKey: "runtime-key", secret: "" }), "secret unset: the runtime key alone");
});

// ── Stored credentials (317) ─────────────────────────────────────────────────────────

Deno.test("317: the charge goes out merchant-initiated, naming the card's UNSCHEDULED initial", async () => {
  const h = harness({ initial: "init-topup-9" });
  assertEquals(await h.run(), { fired: true, ok: true, reason: "charged" });
  assertEquals(h.charges.length, 1);
  assertEquals(h.charges[0].cof, "mit_unscheduled");
  assertEquals(h.charges[0].initialTxn, "init-topup-9");
});

Deno.test("317: no unscheduled initial (a card saved only by a subscription) -> switched OFF, never charged", async () => {
  // The live case on 2026-10-20: auto top-up on, card vaulted by a subscribe sale, never topped up.
  const h = harness({ initial: null });
  assertEquals(await h.run(), { fired: false, ok: true, reason: "needs_agreement" });
  assertEquals(h.charges.length, 0, "a card is never touched");
  const ups = updatesOf(h.writes);
  assertEquals(ups.length, 1, "no cooldown claim, only the switch-off");
  assertEquals(ups[0].auto_topup_enabled, false);
  assertEquals(ups[0].auto_topup_consent_id, null);
  assert(String(ups[0].auto_topup_disabled_reason).includes("Add funds once"), String(ups[0].auto_topup_disabled_reason));
  assertEquals(h.logs.map((l) => [l.code, l.severity]), [["auto_topup_needs_agreement", "info"]]);
});

Deno.test("317: no recorded agreement (switched on before 317) -> switched OFF, never charged", async () => {
  const h = harness({ acct: { ...DUE, auto_topup_consent_id: null } });
  assertEquals(await h.run(), { fired: false, ok: true, reason: "needs_agreement" });
  assertEquals(h.charges.length, 0);
});

Deno.test("317: the agreement is only checked once it would really fire (above threshold stays untouched)", async () => {
  const h = harness({ initial: null, acct: { ...DUE, auto_topup_consent_id: null, balance_cents: 50000 } });
  assertEquals(await h.run(), { fired: false, ok: true, reason: "above threshold" });
  assertEquals(h.writes.length, 0, "a tenant above threshold is not switched off over it");
});

Deno.test("317: the daily cap stops the charge once the agreed number is reached in 24 hours", async () => {
  const atCap = harness({ recent: Array.from({ length: AUTO_TOPUP_DAILY_MAX }, (_, i) => ({ id: i })) });
  assertEquals(await atCap.run(), { fired: false, ok: true, reason: "daily limit reached" });
  assertEquals(atCap.charges.length, 0);
  assertEquals(atCap.writes.length, 0, "no claim either");
  const under = harness({ recent: Array.from({ length: AUTO_TOPUP_DAILY_MAX - 1 }, (_, i) => ({ id: i })) });
  assertEquals(await under.run(), { fired: true, ok: true, reason: "charged" });
});

Deno.test("317: every charge sends the owners a receipt, with the amount, card and attempt it belongs to", async () => {
  const h = harness({});
  await h.run();
  assertEquals(h.receipts.length, 1);
  const [_admin, clientId, attemptId, input] = h.receipts[0] as [unknown, string, number, Record<string, unknown>];
  assertEquals(clientId, "tenant-a");
  assertEquals(attemptId, 41);
  assertEquals(input.amountCents, 25000);
  assertEquals(input.last4, "4242");
  assertEquals(input.trigger, "auto");
  assertEquals(input.thresholdCents, 10000);
  assertEquals(input.saleTxn, "txn-1");
});

Deno.test("317: a receipt that fails does not turn a good charge into a failure", async () => {
  const h = harness({}, CHARGED, { sendReceipt: () => Promise.reject(new Error("resend down")) });
  assertEquals(await h.run(), { fired: true, ok: true, reason: "charged" });
});

Deno.test("317: a daily count that cannot be read charges nothing, and is logged", async () => {
  const h = harness({ recentError: { message: "timeout" } });
  assertEquals(await h.run(), { fired: false, ok: false, reason: "cap_unreadable" });
  assertEquals(h.charges.length, 0);
  assertEquals(h.writes.length, 0, "no claim");
  assertEquals(h.logs.map((l) => l.code), ["auto_topup_cap_unreadable"]);
});

Deno.test("317: the daily count is read only once a charge is otherwise due", async () => {
  // runAutoTopup runs on every 3D hold, usage charge and refused text; the cap read must not.
  const reads: string[] = [];
  const { admin } = fakeAdmin({ acct: { ...DUE, balance_cents: 50000 } });
  const spy = { from: (t: string) => { reads.push(t); return admin.from(t); } };
  await runAutoTopup(spy, "tenant-a", null, { now: () => NOW, logError: () => Promise.resolve() });
  assert(!reads.includes("billing_charge_attempts"), reads.join(","));
});

Deno.test("317: the daily cap counts THIS tenant's merchant-initiated attempts in the last 24 hours", async () => {
  // The fake answers any read with the rows it is given, so the filters themselves are pinned here.
  const seen: Op[][] = [];
  const { admin } = fakeAdmin({});
  const spy = {
    from: (t: string) => {
      const q = admin.from(t) as Record<string, (...a: unknown[]) => unknown>;
      if (t !== "billing_charge_attempts") return q;
      const ops: Op[] = [];
      seen.push(ops);
      const wrap = (o: Record<string, unknown>): Record<string, unknown> => new Proxy(o, {
        get(target, k) {
          const v = target[k as string];
          if (typeof v !== "function" || k === "then") return v;
          return (...a: unknown[]) => { ops.push([String(k), ...a]); return wrap(v(...a) as Record<string, unknown>); };
        },
      });
      return wrap(q as unknown as Record<string, unknown>);
    },
  };
  await runAutoTopup(spy, "tenant-a", null, { now: () => NOW, logError: () => Promise.resolve(), chargeTopup: (() => Promise.resolve(CHARGED)) as unknown as AutoTopupDeps["chargeTopup"], sendReceipt: (() => Promise.resolve({ sent: 1, error: null })) as unknown as AutoTopupDeps["sendReceipt"] });
  const read = seen.find((ops) => ops.some((o) => o[0] === "select")) ?? [];
  assert(read.some((o) => o[0] === "eq" && o[1] === "client_id" && o[2] === "tenant-a"), JSON.stringify(read));
  assert(read.some((o) => o[0] === "eq" && o[1] === "cof" && o[2] === "mit_unscheduled"), JSON.stringify(read));
  assert(read.some((o) => o[0] === "gte" && o[1] === "created_at" && o[2] === iso(NOW - 24 * 60 * 60 * 1000)), JSON.stringify(read));
  assert(read.some((o) => o[0] === "limit" && o[1] === AUTO_TOPUP_DAILY_MAX + 1), JSON.stringify(read));
});

Deno.test("317: charged but NOT credited still sends the receipt, marked as pending credit", async () => {
  const h = harness({}, { ok: false, error: "Your card was charged but the balance did not update.", blocking: true, chargedTxn: "txn-9", attemptId: 44 });
  assertEquals(await h.run(), { fired: true, ok: false, reason: "needs_review" });
  assertEquals(h.receipts.length, 1);
  const [, , attemptId, input] = h.receipts[0] as [unknown, string, number, Record<string, unknown>];
  assertEquals([attemptId, input.saleTxn, input.pendingCredit, input.balanceCents], [44, "txn-9", true, null]);
});
