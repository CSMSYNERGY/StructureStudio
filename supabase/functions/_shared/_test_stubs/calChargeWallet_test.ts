// The video meter's money line, end to end (2026-10-05): what the server says about the wallet,
// what the shell hands the designer, and which sentence the builder reads.
//
// WHY THIS EXISTS. The 3D panel told every builder "you are charged $20 once" from a hard-coded
// string while usage_prices.video_3d_generation was switched off, so the copy and the meter
// disagreed. And an exempt tenant (wallet_accounts.metered_exempt, which wallet_hold holds at 0)
// would have been told the same $20 with the meter on. The fix has three parts, each held here:
//
//   1. portal-settings `catalog` returns wallet.exempt from metered_exempt (the select must ask for
//      the column, so the fake below only answers the columns it is asked for), and a wallet or
//      price read that FAILED, or a price row that is missing, is wallet = null rather than "meter
//      off". The panel now says "free" on meter off, so a failed read reading as off would have
//      told a builder on an armed meter that generating was free. A failure still never fails the
//      catalog. And the wallet carries no balance: the catalog's gate lets in staff that
//      portal-billing keeps the balance from, and the money line never needed it.
//   2. The shell's onLoadStyle3D passes `wallet` through untouched, and its dropped-connection
//      sentence makes no money claim.
//   3. calChargeOf, lifted from BOTH hand-mirrored twins and run here, turns the server's answer
//      into { cents, said } (priced), { free: true }, or null (unknown: no money claim). The two
//      "charged once, as usual" sentences only ever render behind a priced charge. A wallet with no
//      boolean `exempt` is an older function's, whose "off" may be a failed read, so it is null.
//   4. calGenerate reads the wallet AGAIN at the press, so a meter armed or disarmed while the
//      editor sat open is not said from the open-time read.
//
// HOW. verifyTaxWalletWiring_test's idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, and the import map swaps supabase-js for supabase_stub.ts, whose stubDb hook routes
// every table read into the fake below. `catalog` is a read: nothing is written, and fetch is
// stubbed to throw with no --allow-net, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check portal-settings against the stub's partial client type.
//
// The tenant and its numbers are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const JSX = await read("../../../../StructureStudio.jsx");
const CMP = await read("../../../../structure-studio.component.js");
const SHELL = await read("../../../../portal/12-shell.jsx");

function between(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`calChargeWallet_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  return src.slice(i, j);
}
/** Same, with whole-line comments dropped, so a comment naming a token cannot satisfy a check. */
const codeOf = (block: string) => block.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

// ─── calChargeOf, from the shipped twins ───────────────────────────────────────────────────────
const LIFT: [string, string] = ["function calChargeOf(", "// Upload a list with BOUNDED CONCURRENCY"];
const CHARGE_CMP = between(CMP, "structure-studio.component.js", ...LIFT);
const CHARGE_JSX = between(JSX, "StructureStudio.jsx", ...LIFT);
const calChargeOf = new Function(`${CHARGE_CMP}; return calChargeOf;`)() as (w: unknown) => any;

Deno.test("calChargeOf is byte-identical in the two twins", () => {
  assertEquals(CHARGE_JSX, CHARGE_CMP);
});

Deno.test("calChargeOf: the meter off is free, whatever else the wallet says", () => {
  assertEquals(calChargeOf({ meterActive: false, exempt: false, priceCents: 2000 }), { free: true });
  assertEquals(calChargeOf({ meterActive: false, exempt: true, priceCents: null }), { free: true });
});

Deno.test("calChargeOf: armed, not exempt, priced is the price, in dollars a builder reads", () => {
  assertEquals(calChargeOf({ meterActive: true, exempt: false, priceCents: 2000, balanceCents: 0, heldCents: 0 }), { cents: 2000, said: "$20" });
  assertEquals(calChargeOf({ meterActive: true, exempt: false, priceCents: 1550 }).said, "$15.50");
  assertEquals(calChargeOf({ meterActive: true, exempt: false, priceCents: 5 }).said, "$0.05");
  assertEquals(calChargeOf({ meterActive: true, exempt: false, priceCents: 250000 }).said, "$2,500");
});

Deno.test("calChargeOf: exempt, or a price of 0, is free", () => {
  assertEquals(calChargeOf({ meterActive: true, exempt: true, priceCents: 2000 }), { free: true });
  assertEquals(calChargeOf({ meterActive: true, exempt: true, priceCents: null }), { free: true }, "exempt holds at 0 whatever the price");
  assertEquals(calChargeOf({ meterActive: true, exempt: false, priceCents: 0 }), { free: true });
});

Deno.test("calChargeOf: anything it cannot be sure of is null, never a guessed price", () => {
  for (const w of [
    null, undefined, "wallet", 2000,
    {},
    { meterActive: "yes", exempt: false, priceCents: 2000 },
    // An older function that never sent `exempt`, with the meter on: it might be exempt.
    { meterActive: true, priceCents: 2000 },
    // ⚠️ And with the meter "off": that function turned a FAILED price read into meterActive false,
    // so its "off" can be an armed meter. Saying "free" there is a promise the hold then breaks.
    { meterActive: false, priceCents: null },
    { balanceCents: 18000, heldCents: 0, priceCents: null, meterActive: false },
    { meterActive: false, exempt: "no", priceCents: 2000 },
    // A price the server redacted (visible false).
    { meterActive: true, exempt: false, priceCents: null },
    { meterActive: true, exempt: false, priceCents: Number.NaN },
    { meterActive: true, exempt: false, priceCents: -5 },
    { meterActive: true, exempt: false, priceCents: "2000" },
  ]) {
    assertEquals(calChargeOf(w), null, JSON.stringify(w));
  }
});

// ─── The designer stores it and the sentences follow it ────────────────────────────────────────
Deno.test("both twins store calChargeOf(meta.wallet) on the scan when the editor's read lands", () => {
  for (const [file, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]]) {
    const open = codeOf(between(src, file, "const openCalEditor = (s) => {", "const calSet = (patch) =>"));
    assert(open.includes("charge: calChargeOf(meta.wallet)"), `${file}: openCalEditor's read stores the charge`);
    assert(open.includes('aiReady: null, charge: null })'), `${file}: and resets it with the scan, so another tenant's answer cannot linger`);
  }
});

Deno.test("⚠️ both twins read the wallet AGAIN at the press, and the late-draft line uses that answer", () => {
  for (const [file, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]]) {
    const press = codeOf(between(src, file, "const calGenerate = async () => {", "// A DRAFT LANDED, so this intent is finished"));
    assert(press.includes("setScan((p) => ({ ...p, charge: null }));"), `${file}: the press drops the open-time answer until its own lands`);
    assert(press.includes("setup3d.onLoadStyle3D(adminCal.styleValue)"), `${file}: the press reads the catalog's wallet itself`);
    assert(press.includes(".then((meta) => calChargeOf(meta && meta.wallet), () => null)"), `${file}: through calChargeOf, and a failed read is no claim`);
    assert(press.includes("if (mine()) setScan((p) => ({ ...p, charge: c }))"), `${file}: and only while this press is the one on screen`);
    // Read before the generation is sent, so the card describes THIS press.
    assert(press.indexOf("setup3d.onLoadStyle3D(") < press.indexOf("setup3d.onDraftFromCombined("), `${file}: read before the draft goes out`);
    const late = codeOf(between(src, file, "// A DRAFT LANDED, so this intent is finished", "That generation finished after you opened another style"));
    assert(late.includes("const charged = await chargeNow;"), `${file}: the late-draft sentence reads this press's answer`);
    assert(!late.includes("scan.charge"), `${file}: not the pressing render's closure`);
  }
});

Deno.test("no fixed price is left in the panel's sentences, and 'charged once' only renders when priced", () => {
  for (const [file, src] of [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]]) {
    for (const gone of ["you are charged $20 once", "another $20."]) {
      assert(!src.includes(gone), `${file}: still says "${gone}"`);
    }
    const lines = src.split("\n").filter((l) => /charged (for it )?once, as usual/.test(l));
    assertEquals(lines.length, 2, `${file}: the two "charged once" sentences`);
    // The panel's sentence follows scan.charge; the late-draft one follows its own press's read.
    for (const l of lines) {
      assert(l.includes("scan.charge && scan.charge.cents") || l.includes("charged && charged.cents"), `${file}: unguarded: ${l.trim().slice(0, 120)}`);
    }
    assert(src.includes("data-ssc-charge="), `${file}: the money line names which sentence it is showing`);
  }
});

Deno.test("the shell passes the wallet through, and its dropped-connection line claims no money", () => {
  const load = codeOf(between(SHELL, "portal/12-shell.jsx", "onLoadStyle3D: async (styleValue) => {", "onDraftFromPhotos:"));
  assert(load.includes("wallet: data.wallet ?? null"), "onLoadStyle3D hands the designer the catalog's wallet");
  const dropped = SHELL.split("\n").find((l) => l.includes("Your connection dropped before the draft arrived")) ?? "";
  assert(dropped.includes("it counted as one generation"), dropped.trim());
  assert(!/charged/.test(dropped), `the shell cannot see the wallet, so it says no money: ${dropped.trim()}`);
});

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

const T = "acme-sheds";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = {
  SUPABASE_URL: PROJECT,
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};
const OFF = { price_cents: 2000, active: false, visible: true };  // usage_prices(video_3d_generation) on 2026-10-05
const ARMED = { price_cents: 2000, active: true, visible: true };
const DOWN = { message: "connection reset", code: "08006" };

type World = {
  price?: Record<string, unknown> | null;      // the usage_prices row; undefined = the live row, null = none
  priceError?: boolean;
  wallet?: Record<string, unknown> | null;     // the wallet_accounts row; null = none
  walletError?: boolean;
  walletThrows?: boolean;
  selects?: string[];                          // filled in: every "table: columns" the handler asked for
};

/** Only the columns the select named: a select that forgot metered_exempt must read as not exempt. */
function project(row: Record<string, unknown> | null, cols: string): Record<string, unknown> | null {
  if (!row) return row;
  const want = cols.split(",").map((c) => c.trim()).filter(Boolean);
  return Object.fromEntries(want.filter((c) => c in row).map((c) => [c, row[c]]));
}

function answer(world: World, table: string, ops: any[][]): { data: unknown; error: unknown } {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const cols = String((ops.find((o) => o[0] === "select") ?? [])[1] ?? "");
  world.selects?.push(`${table}: ${cols}`);
  if (table === "client_users") return { data: [{ client_id: T, role: "owner", title: null, access: null, user_id: "u1", prefs: null }], error: null };
  if (table === "usage_prices") {
    if (world.priceError) return { data: null, error: DOWN };
    return { data: project(world.price === undefined ? OFF : world.price, cols), error: null };
  }
  if (table === "wallet_accounts") {
    if (world.walletError) return { data: null, error: DOWN };
    return { data: project(world.wallet === undefined ? null : world.wallet, cols), error: null };
  }
  return { data: has("maybeSingle") || has("single") ? null : [], error: null };
}

function chain(world: World, writes: string[], table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, writes, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const verb = ops.find((o) => ["select", "insert", "update", "delete", "upsert"].includes(o[0]))?.[0] ?? "?";
    if (verb !== "select") writes.push(`${table}:${verb}`);
    if (table === "wallet_accounts" && world.walletThrows) return Promise.reject(new Error("socket hang up")).then(ok, bad);
    return Promise.resolve().then(() => answer(world, table, ops)).then(ok, bad);
  };
  return q;
}

async function catalog(world: World = {}) {
  const writes: string[] = [];
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, writes, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "catalog" }),
    }));
    const body = await res.json();
    assertEquals([res.status, body.ok], [200, true], `the catalog itself loads: ${JSON.stringify(body).slice(0, 200)}`);
    assertEquals(writes.filter((w) => !w.startsWith("app_errors")), [], "a catalog read writes nothing");
    return body;
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// ─── 1. the server's answer, and the line it becomes ───────────────────────────────────────────
Deno.test("the live state (meter off at 2000): the catalog says so, and the panel says free", async () => {
  const body = await catalog({ wallet: { balance_cents: 20000, held_cents: 0, metered_exempt: false } });
  assertEquals(body.wallet, { priceCents: 2000, meterActive: false, exempt: false });
  assertEquals(calChargeOf(body.wallet), { free: true });
});

Deno.test("⚠️ the catalog's wallet carries no balance, and never reads one", async () => {
  // The catalog's gate (Structures or Options at view) admits the default admin preset and support
  // operators without billing, from whom portal-billing withholds the balance. So it is not read.
  const world: World = { price: ARMED, wallet: { balance_cents: 20000, held_cents: 500, metered_exempt: false }, selects: [] };
  const body = await catalog(world);
  assert(!("balanceCents" in body.wallet) && !("heldCents" in body.wallet), JSON.stringify(body.wallet));
  assertEquals(world.selects!.filter((s) => s.startsWith("wallet_accounts:")), ["wallet_accounts: metered_exempt"]);
});

Deno.test("armed at 2000, not exempt: the catalog carries the price and the panel says $20", async () => {
  const body = await catalog({ price: ARMED, wallet: { balance_cents: 14000, held_cents: 0, metered_exempt: false } });
  assertEquals(body.wallet, { priceCents: 2000, meterActive: true, exempt: false });
  assertEquals(calChargeOf(body.wallet), { cents: 2000, said: "$20" });
  // No wallet row yet: a tenant never charged, $0, not exempt. Still priced: the hold is what refuses.
  const fresh = await catalog({ price: ARMED, wallet: null });
  assertEquals(fresh.wallet, { priceCents: 2000, meterActive: true, exempt: false });
  assertEquals(calChargeOf(fresh.wallet), { cents: 2000, said: "$20" });
});

Deno.test("⚠️ armed, and the tenant is exempt: the catalog READS metered_exempt, and the panel says free", async () => {
  const body = await catalog({ price: ARMED, wallet: { balance_cents: 0, held_cents: 0, metered_exempt: true } });
  assertEquals(body.wallet.exempt, true, "the select asked for metered_exempt (the fake answers only the columns named)");
  assertEquals(calChargeOf(body.wallet), { free: true });
});

Deno.test("armed with the price hidden (visible false): no amount to say, so no money claim", async () => {
  const body = await catalog({ price: { price_cents: 2000, active: true, visible: false }, wallet: { balance_cents: 500, held_cents: 0, metered_exempt: false } });
  assertEquals([body.wallet.priceCents, body.wallet.meterActive], [null, true]);
  assertEquals(calChargeOf(body.wallet), null);
});

// ─── 2. a failed read is unknown, never "off" ──────────────────────────────────────────────────
Deno.test("⚠️ a price or wallet read that fails, or a missing price row, is wallet null (never 'meter off', which would say free), and the catalog still loads", async () => {
  for (const [label, world] of [
    ["the price read errored, meter really armed", { priceError: true, wallet: { balance_cents: 900, held_cents: 0, metered_exempt: false } }],
    ["the wallet read errored", { price: ARMED, walletError: true }],
    ["the wallet read threw", { price: ARMED, walletThrows: true }],
    // No usage_prices row at all: wallet_hold answers meter_unknown and refuses the press (503),
    // so this is not "off" either.
    ["the price row is missing", { price: null, wallet: { balance_cents: 900, held_cents: 0, metered_exempt: false } }],
  ] as [string, World][]) {
    const body = await catalog(world);
    assertEquals(body.wallet, null, label);
    assertEquals(calChargeOf(body.wallet), null, `${label}: the line makes no money claim`);
  }
});
