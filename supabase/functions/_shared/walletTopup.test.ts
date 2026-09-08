// Unit tests for the pure parts of wallet top-ups (migration 164).
//
// WHY THESE EXIST. autoTopupDecision is the only thing in this codebase that decides, with no
// human present, to charge a card. Its failure modes are asymmetric and both are expensive:
// firing when it shouldn't takes money nobody asked for, and firing repeatedly takes it over
// and over within seconds. So the properties pinned here are the guards, not the happy path —
// the cooldown, the available-vs-balance distinction, and every reason to refuse.
//
// chargeTopup itself moves real money, but the BOOKKEEPING half of it is testable without a
// gateway or a database: a recording fake for `admin` and a stubbed `fetch` pin the one thing
// support depends on when a top-up ends unverifiable — that the order id stored on the attempt
// row is the order id the sale was actually sent with.
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
import {
  autoTopupDecision, AUTO_TOPUP_COOLDOWN_MS, chargeTopup,
  MIN_TOPUP_CENTS, MAX_TOPUP_CENTS, TOPUP_PLAN_ID,
} from "./walletTopup.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; throw new Error(`${name}${detail ? `: ${detail}` : ""}`); }
}
const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// A tenant configured to hold $100, topping up $250, with $50 available.
const READY = {
  auto_topup_enabled: true,
  auto_topup_threshold_cents: 10000,
  auto_topup_amount_cents: 25000,
  auto_topup_last_at: null as string | null,
  balance_cents: 5000,
  held_cents: 0,
};
const decide = (over: Partial<typeof READY>, hasVault = true, now = NOW) =>
  autoTopupDecision({ ...READY, ...over }, hasVault, now);

Deno.test("fires when available balance is under the threshold", () => {
  const d = decide({});
  check("fires", d.fire === true, JSON.stringify(d));
  check("for the configured amount", d.fire === true && d.amountCents === 25000);
});

Deno.test("does not fire when the tenant is above the threshold", () => {
  const d = decide({ balance_cents: 20000 });
  check("held", d.fire === false && d.reason === "above threshold", JSON.stringify(d));
});

Deno.test("HELD money counts as spent — available, not balance, drives the trigger", () => {
  // $150 balance with $120 held for an in-flight generation is $30 available: under the $100
  // threshold. Reading balance alone would leave a tenant at near-zero available while the
  // trigger insisted they were fine, and the next generation would be refused.
  const d = decide({ balance_cents: 15000, held_cents: 12000 });
  check("fires on available", d.fire === true, JSON.stringify(d));
});

Deno.test("the cooldown stops a burst of generations charging the card repeatedly", () => {
  // The single most expensive failure this function can have.
  check("just charged → held", decide({ auto_topup_last_at: ago(60 * 1000) }).fire === false);
  check("59 min → still held", decide({ auto_topup_last_at: ago(AUTO_TOPUP_COOLDOWN_MS - 60000) }).fire === false);
  check("61 min → allowed", decide({ auto_topup_last_at: ago(AUTO_TOPUP_COOLDOWN_MS + 60000) }).fire === true);
  const cooling = decide({ auto_topup_last_at: ago(60 * 1000) });
  check("and says why", cooling.fire === false && cooling.reason === "cooling down");
});

Deno.test("never fires without a card, however well configured", () => {
  const d = decide({}, false);
  check("refused", d.fire === false && d.reason === "no card on file", JSON.stringify(d));
});

Deno.test("never fires when switched off, or on a missing account", () => {
  check("disabled", decide({ auto_topup_enabled: false }).fire === false);
  check("null account", autoTopupDecision(null, true, NOW).fire === false);
  check("undefined account", autoTopupDecision(undefined, true, NOW).fire === false);
});

Deno.test("refuses a half-configured or out-of-bounds setup rather than guessing", () => {
  // Enabled with nulls should be impossible (the DB constraint and the edge function both
  // forbid it), so if it is ever seen the answer is "do nothing", never a default amount.
  check("no threshold", decide({ auto_topup_threshold_cents: null as never }).fire === false);
  check("no amount", decide({ auto_topup_amount_cents: null as never }).fire === false);
  check("amount below floor", decide({ auto_topup_amount_cents: MIN_TOPUP_CENTS - 1 }).fire === false);
  check("amount above cap", decide({ auto_topup_amount_cents: MAX_TOPUP_CENTS + 1 }).fire === false);
  check("threshold below floor", decide({ auto_topup_threshold_cents: 1 }).fire === false);
});

Deno.test("a zero or negative available balance still fires (it is the point)", () => {
  check("at zero", decide({ balance_cents: 0 }).fire === true);
  // Over-held shouldn't happen, but if it does the tenant is worse off, not better.
  check("over-held", decide({ balance_cents: 1000, held_cents: 5000 }).fire === true);
});

Deno.test("every refusal names a reason", () => {
  // At debit time this runs inside a swallow-everything block, so the reason string is the
  // only way anyone answers "why didn't my wallet recharge?".
  for (const [label, d] of [
    ["disabled", decide({ auto_topup_enabled: false })],
    ["no vault", decide({}, false)],
    ["above", decide({ balance_cents: 99999 })],
    ["cooling", decide({ auto_topup_last_at: ago(1000) })],
    ["unconfigured", decide({ auto_topup_amount_cents: 0 })],
  ] as const) {
    check(`${label} has a reason`, d.fire === false && typeof d.reason === "string" && d.reason.length > 0);
  }
});

Deno.test("the bounds and the attempt-ledger key are what the rest of the system assumes", () => {
  // MIN is one 3D generation ($20) — a smaller top-up would buy nothing and still cost a
  // gateway transaction. MAX matches admin-catalog's per-entry cap on operator grants.
  check("floor is $20", MIN_TOPUP_CENTS === 2000, String(MIN_TOPUP_CENTS));
  check("cap is $5,000", MAX_TOPUP_CENTS === 500000, String(MAX_TOPUP_CENTS));
  // Changing this string orphans every in-flight attempt row: the closed_unknown block and
  // the one-open concurrency index both look it up by exactly this value.
  check("ledger key is stable", TOPUP_PLAN_ID === "wallet_topup", TOPUP_PLAN_ID);
});

// ── chargeTopup: the row's order id must be the gateway's order id ───────────────────────
//
// The attempt row is the ONLY handle support has on a top-up whose outcome the gateway never
// told us. "Did this card get charged?" is answered by looking the sale up at the gateway by
// the order id on that row — so a row carrying a different string than the sale was sent with
// makes the very state the blocking semantics exist to preserve unresolvable, and the tenant
// stays blocked while nobody can prove either way.
//
// The insert has to mint SOMETHING before the row has an id, so the real order id (which is
// built from that id) is written back straight after. These tests pin the write-back, and that
// it can never take the sale down with it.

type Row = Record<string, unknown>;
type AdminCfg = {
  attemptId?: string;
  balanceCents?: number;
  failUpdates?: boolean;
  gateway?: "approve" | "unknown";
};

function fakeAdmin(cfg: AdminCfg) {
  const attemptId = cfg.attemptId ?? "att-7";
  const inserts: { table: string; row: Row }[] = [];
  const updates: { table: string; patch: Row; filters: Row }[] = [];
  const rpcs: { fn: string; args: Row }[] = [];

  // No prior closed_unknown and no stale open: the clean path into the sale.
  const selectResult = (table: string) =>
    table === "wallet_accounts"
      ? { data: { balance_cents: cfg.balanceCents ?? 0 }, error: null }
      : { data: [] as Row[], error: null };

  const admin = {
    from(table: string) {
      return {
        select(_cols?: string) {
          // deno-lint-ignore no-explicit-any
          const b: any = {
            eq: (_c: string, _v: unknown) => b,
            limit: (_n: number) => b,
            maybeSingle: () => Promise.resolve(selectResult(table)),
            // deno-lint-ignore no-explicit-any
            then: (ok: any, no: any) => Promise.resolve(selectResult(table)).then(ok, no),
          };
          return b;
        },
        insert(row: Row) {
          inserts.push({ table, row });
          const result = table === "billing_charge_attempts"
            ? { data: { id: attemptId }, error: null }
            : { data: null, error: null };
          // deno-lint-ignore no-explicit-any
          const b: any = {
            select: (_c?: string) => b,
            maybeSingle: () => Promise.resolve(result),
            // deno-lint-ignore no-explicit-any
            then: (ok: any, no: any) => Promise.resolve(result).then(ok, no),
          };
          return b;
        },
        update(patch: Row) {
          const filters: Row = {};
          // deno-lint-ignore no-explicit-any
          const b: any = {
            eq: (c: string, v: unknown) => { filters[c] = v; return b; },
            // deno-lint-ignore no-explicit-any
            then: (ok: any, no: any) => {
              updates.push({ table, patch, filters });
              // A write that fails must never be the reason a sale is abandoned.
              return (cfg.failUpdates
                ? Promise.reject(new Error("update refused"))
                : Promise.resolve({ data: null, error: null })).then(ok, no);
            },
          };
          return b;
        },
      };
    },
    rpc(fn: string, args: Row) {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: cfg.balanceCents ?? 30000, error: null });
    },
  };
  return { admin, inserts, updates, rpcs, attemptId };
}

const CLIENT = "pw-demo-barns";

async function runTopup(cfg: AdminCfg = {}) {
  const fake = fakeAdmin(cfg);
  const sent: Record<string, string>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: { body?: unknown }) => {
    sent.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))));
    if (cfg.gateway === "unknown") return Promise.reject(new Error("connection reset"));
    return Promise.resolve(
      new Response("response=1&responsetext=SUCCESS&transactionid=TXN9911", { status: 200 }),
    );
  }) as unknown as typeof fetch;
  try {
    const res = await chargeTopup(fake.admin, {
      clientId: CLIENT, vaultId: "vault-1", amountCents: 25000, auto: false,
    });
    return { ...fake, res, sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// What the row ends up carrying: the insert's placeholder unless a later write replaces it.
function storedOrderId(
  inserts: { table: string; row: Row }[],
  updates: { table: string; patch: Row; filters: Row }[],
): string {
  let id = String(inserts.find((i) => i.table === "billing_charge_attempts")?.row.orderid ?? "");
  for (const u of updates) {
    if (u.table === "billing_charge_attempts" && typeof u.patch.orderid === "string") id = u.patch.orderid;
  }
  return id;
}

Deno.test("the attempt row ends up holding the order id the gateway was actually given", async () => {
  const { res, sent, inserts, updates, attemptId } = await runTopup();
  check("the sale went out", sent.length === 1, JSON.stringify(sent));
  const atGateway = sent[0].orderid;
  check("gateway order id is built from the attempt row id", atGateway === `ss_topup_${CLIENT}_${attemptId}`, atGateway);
  // The bug this pins: the insert minted a timestamp-based id and nothing ever reconciled it,
  // so the stored key found nothing at the gateway.
  check("row matches gateway", storedOrderId(inserts, updates) === atGateway,
    `${storedOrderId(inserts, updates)} != ${atGateway}`);
  check("and the wallet was credited", res.ok === true, JSON.stringify(res));
});

Deno.test("the insert still carries an order id, and stays the concurrency guard", async () => {
  const { inserts } = await runTopup();
  const row = inserts.find((i) => i.table === "billing_charge_attempts")?.row ?? {};
  // Filed under the shared plan slot (that is what makes the partial unique index refuse a
  // second simultaneous top-up), and never inserted without an order id.
  check("plan slot", row.plan_id === TOPUP_PLAN_ID, String(row.plan_id));
  check("insert has an order id", typeof row.orderid === "string" && (row.orderid as string).length > 0);
});

Deno.test("a failed order-id write-back must not abort the sale", async () => {
  // Every write to the attempt row is bookkeeping. If one fails the money path carries on:
  // throwing here would abandon an 'open' row and block every later top-up for that tenant.
  const { res, sent } = await runTopup({ failUpdates: true });
  check("the sale still ran", sent.length === 1);
  check("and still succeeded", res.ok === true, JSON.stringify(res));
});

Deno.test("an unverifiable top-up names the order id an operator has to look up", async () => {
  const { res, inserts, sent, attemptId } = await runTopup({ gateway: "unknown" });
  check("blocking", res.ok === false && res.blocking === true, JSON.stringify(res));
  const fault = inserts.find((i) => i.table === "app_errors")?.row ?? {};
  const message = String(fault.message ?? "");
  check("a fault row was filed", message.length > 0);
  check("naming the gateway order id", message.includes(sent[0].orderid), message);
  check("and the attempt row", message.includes(attemptId), message);
});

if (failures) throw new Error(`${failures} failed`);
