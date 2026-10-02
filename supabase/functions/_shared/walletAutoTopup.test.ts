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

import { autoTopupCallerAllowed, runAutoTopup, type AutoTopupDeps } from "./walletAutoTopup.ts";
import { AUTO_TOPUP_COOLDOWN_MS, type TopupResult } from "./walletTopup.ts";

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
};

function fakeAdmin(world: World) {
  const writes: { table: string; ops: Op[] }[] = [];
  const admin = {
    from(table: string) {
      if (world.explode) throw new Error("the client is broken");
      const ops: Op[] = [];
      const q: Record<string, unknown> = {};
      const step = (name: string) => (...a: unknown[]) => { ops.push([name, ...a]); return q; };
      for (const m of ["select", "update", "eq", "or", "is", "lt"]) q[m] = step(m);
      const isUpdate = () => ops.some((o) => o[0] === "update");
      q.maybeSingle = () => {
        if (table === "wallet_accounts") return Promise.resolve({ data: world.acct === undefined ? DUE : world.acct, error: null });
        if (table === "billing_customers") {
          return Promise.resolve({ data: world.vault === null ? null : { vault_id: world.vault ?? "vault-1" }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      };
      // Awaiting an update chain: the claim (it ends in .select) or a plain write.
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
        if (isUpdate()) writes.push({ table, ops });
        const isClaim = isUpdate() && ops.some((o) => o[0] === "or");
        const res = isClaim
          ? (world.claimError ? { data: null, error: world.claimError } : { data: world.claimRows ?? [{ client_id: "tenant-a" }], error: null })
          : { data: null, error: null };
        return Promise.resolve(res).then(ok, bad);
      };
      return q;
    },
  };
  return { admin, writes };
}

function harness(world: World, charge: TopupResult | (() => never) = { ok: true, balanceCents: 28000, saleTxn: "txn-1", alreadyCredited: false }, deps: AutoTopupDeps = {}) {
  const { admin, writes } = fakeAdmin(world);
  const charges: Record<string, unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const full: AutoTopupDeps = {
    now: () => NOW,
    chargeTopup: ((_a: unknown, opts: Record<string, unknown>) => {
      charges.push(opts);
      return typeof charge === "function" ? charge() : Promise.resolve(charge);
    }) as unknown as AutoTopupDeps["chargeTopup"],
    logError: ((input: Record<string, unknown>) => { logs.push(input); return Promise.resolve(); }) as unknown as AutoTopupDeps["logError"],
    ...deps,
  };
  return { run: () => runAutoTopup(admin, "tenant-a", null, full), writes, charges, logs };
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

  assertEquals(h.charges, [{ clientId: "tenant-a", vaultId: "vault-1", amountCents: 25000, actorUserId: null, auto: true }]);
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
  assertEquals(ups[1], { auto_topup_enabled: false, auto_topup_disabled_reason: long.slice(0, 300) });
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
