// The stored-card agreement sentences (317), the COF field builder, and the receipt.
//
// WHY THESE EXIST.
//   1. What a builder is shown beside the box and what portal-billing stores as their agreement
//      must be the SAME sentence. The templates have one home (cofConsent.ts) and travel to the
//      browser in `status`, but the {placeholders} are filled twice: by the Billing tab
//      (portal/03-catalog.jsx) and by the server from its own numbers. This lifts the browser's
//      block out of the shipped JSX and runs both over the same inputs.
//   2. cofFields is the whole stored-credential rule set in one switch; a wrong value there is a
//      wrong flag on every charge of that kind. nmiPostCof's one retry must only ever fire for a
//      refused billing_method on a recurring initial, never for a card decline.
//   3. The receipt is what the auto top-up agreement promises; it must name the amount and card,
//      and never throw into the money path.
//
// Dependency-free like the other _shared tests (no jsr:/npm: imports). Runs with --allow-read for
// the JSX, and with no network: every gateway and mail provider here is a stand-in.

import {
  AUTO_TOPUP_DAILY_MAX, cardFromPayload, COF_CONSENT_TEMPLATES, COF_CONSENT_VERSION, cofCardPhrase, cofMoney,
  cofRecurringPhrase, cofTodayPhrase, consentCoversOperatorTopups, consentProblem, recordConsent, renderCofConsent,
} from "./cofConsent.ts";
import { cofFields, isFieldRefusal, NmiDeclined, nmiPostCof } from "./nmi.ts";
import { sendTopupReceipt, topupReceiptEmail } from "./walletReceipt.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

// ── 1. The browser's copy, lifted from the shipped file ──────────────────────────────────────
const JSX = (await Deno.readTextFile(new URL("../../../portal/03-catalog.jsx", import.meta.url))).replace(/\r\n/g, "\n");
const START = "// ── COF CONSENT (mirrors _shared/cofConsent.ts)";
const END = "// ── /COF CONSENT";
const i = JSX.indexOf(START), j = JSX.indexOf(END);
if (i < 0 || j < i) throw new Error("cofConsent.test: the COF CONSENT block in portal/03-catalog.jsx moved. Re-point the anchors rather than deleting this test.");
type BrowserFns = {
  cofMoney: (c: number) => string;
  cofCardPhrase: (n: boolean, l: string | null) => string;
  cofTodayPhrase: (c: number) => string;
  cofRecurringPhrase: (y: number, m: number) => string;
  renderCofConsent: (t: string, v: Record<string, string>) => string;
};
const browser = new Function(`${JSX.slice(i, j)}\nreturn { cofMoney, cofCardPhrase, cofTodayPhrase, cofRecurringPhrase, renderCofConsent };`)() as BrowserFns;

const CENTS = [0, 1, 99, 100, 2000, 2050, 25000, 100000, 123456, 350000, 500000, 1200000];

Deno.test("browser and server format money identically (the Billing tab's fmt$ rule)", () => {
  for (const c of CENTS) assertEquals(browser.cofMoney(c), cofMoney(c), `cents ${c}`);
  assertEquals(cofMoney(350000), "$3,500");
  assertEquals(cofMoney(2050), "$20.50");
});

Deno.test("browser and server build every phrase identically", () => {
  for (const isNew of [true, false]) {
    for (const last4 of ["4242", null, "12", "abcd"]) {
      assertEquals(browser.cofCardPhrase(isNew, last4), cofCardPhrase(isNew, last4), `card ${isNew} ${last4}`);
    }
  }
  for (const c of CENTS) assertEquals(browser.cofTodayPhrase(c), cofTodayPhrase(c), `today ${c}`);
  for (const [y, m] of [[0, 0], [350000, 0], [0, 50000], [350000, 50000]]) {
    assertEquals(browser.cofRecurringPhrase(y, m), cofRecurringPhrase(y, m), `recurring ${y}/${m}`);
  }
});

Deno.test("every template renders the same sentence on both sides, with nothing left unfilled", () => {
  const vars = {
    card: cofCardPhrase(false, "4242"), today: cofTodayPhrase(350000), recurring: cofRecurringPhrase(350000, 0),
    amount: cofMoney(25000), threshold: cofMoney(10000), dailyMax: String(AUTO_TOPUP_DAILY_MAX),
  };
  for (const [kind, tpl] of Object.entries(COF_CONSENT_TEMPLATES)) {
    const server = renderCofConsent(tpl, vars);
    assertEquals(browser.renderCofConsent(tpl, vars), server, kind);
    assert(!/\{\w+\}/.test(server), `${kind} left a placeholder: ${server}`);
  }
});

Deno.test("the sentences say what the framework asks: how the card is used, the amounts, and how to stop", () => {
  const t = COF_CONSENT_TEMPLATES;
  assert(t.subscription.includes("{today}") && t.subscription.includes("{recurring}") && /until I cancel/.test(t.subscription), "subscription");
  assert(t.topup.includes("{amount}") && /only when I add funds/.test(t.topup), "topup");
  assert(["{card}", "{amount}", "{threshold}", "{dailyMax}"].every((p) => t.autoTopup.includes(p)) && /receipt/.test(t.autoTopup) && /once an hour/.test(t.autoTopup), "autoTopup");
  assert(/in place of my current one/.test(t.cardUpdate), "cardUpdate");
  for (const [k, s] of Object.entries(t)) assert(/(cancel|turn).* in Billing/.test(s), `${k} says how to stop`);
});

Deno.test("a stored agreement needs a version; this one is dated", () => {
  assert(/^\d{4}-\d{2}-\d{2}\.\d+$/.test(COF_CONSENT_VERSION), COF_CONSENT_VERSION);
});

Deno.test("consentProblem: ticked + current version only", () => {
  assertEquals(consentProblem({ consent: { version: COF_CONSENT_VERSION, accepted: true } }), null);
  assert(consentProblem({}) !== null, "missing");
  assert(consentProblem({ consent: { version: COF_CONSENT_VERSION, accepted: "yes" } }) !== null, "a truthy string is not a tick");
  assert(/changed/.test(String(consentProblem({ consent: { version: "old", accepted: true } }))), "stale");
  assert(consentProblem(null) !== null, "null payload");
});

Deno.test("cardFromPayload keeps a well-formed last 4 and a plain brand, nothing else", () => {
  assertEquals(cardFromPayload({ card: { last4: "4242", brand: "Visa" } }), { last4: "4242", brand: "visa" });
  assertEquals(cardFromPayload({ card: { last4: "4111111111111111", brand: "<b>" } }), { last4: null, brand: null });
  assertEquals(cardFromPayload({}), { last4: null, brand: null });
});

Deno.test("recordConsent writes the row and THROWS when it cannot (so the caller does not charge)", async () => {
  const rows: Record<string, unknown>[] = [];
  const ok = {
    from: (t: string) => ({
      insert: (row: Record<string, unknown>) => {
        rows.push({ t, ...row });
        return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 42 }, error: null }) }) };
      },
    }),
  };
  const req = new Request("https://x.test", { headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1", "user-agent": "ua/1" } });
  const id = await recordConsent(ok, { clientId: "c1", kind: "autoTopup", wording: "w", terms: { a: 1 }, userId: null, userEmail: "o@example.test", cardLast4: "4242", req });
  assertEquals(id, 42);
  assertEquals([rows[0].t, rows[0].kind, rows[0].wording_version, rows[0].ip, rows[0].user_agent], ["billing_consents", "auto_topup", COF_CONSENT_VERSION, "198.51.100.7", "ua/1"]);
  const broken = { from: () => ({ insert: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "down" } }) }) }) }) };
  let threw = false;
  try { await recordConsent(broken, { clientId: "c1", kind: "topup", wording: "w", terms: {}, userId: null, userEmail: null, cardLast4: null, req: null }); } catch { threw = true; }
  assert(threw, "an unrecorded agreement must stop the charge");
});

// ── 2. The COF fields ────────────────────────────────────────────────────────────────────────

Deno.test("cofFields: the four framings, exactly as NMI's Credential on File section lists them", () => {
  assertEquals(cofFields("cit_initial_recurring"), { initiated_by: "customer", stored_credential_indicator: "stored", billing_method: "initial_recurring" });
  assertEquals(cofFields("cit_initial_recurring", { billingMethod: "recurring" }).billing_method, "recurring");
  assertEquals(cofFields("cit_initial_unscheduled"), { initiated_by: "customer", stored_credential_indicator: "stored" });
  assertEquals(cofFields("cit_used"), { initiated_by: "customer", stored_credential_indicator: "used" });
  assertEquals(cofFields("cit_used", { initialTxn: "I1" }), { initiated_by: "customer", stored_credential_indicator: "used", initial_transaction_id: "I1" });
  assertEquals(cofFields("mit_unscheduled", { initialTxn: "I1" }), { initiated_by: "merchant", stored_credential_indicator: "used", initial_transaction_id: "I1" });
  let threw = false;
  try { cofFields("mit_unscheduled", { initialTxn: " " }); } catch { threw = true; }
  assert(threw, "an MIT without its initial cannot be built");
});

Deno.test("NMI_INITIAL_RECURRING_METHOD=recurring skips the newer value outright", () => {
  Deno.env.set("NMI_INITIAL_RECURRING_METHOD", "recurring");
  try {
    assertEquals(cofFields("cit_initial_recurring").billing_method, "recurring");
  } finally {
    Deno.env.delete("NMI_INITIAL_RECURRING_METHOD");
  }
});

const declined = (response: string, text = "no") => new NmiDeclined({ response, responsetext: text, response_code: response === "3" ? "300" : "200" });

Deno.test("nmiPostCof retries ONCE, with 'recurring', only for a response-3 refusal of a recurring initial", async () => {
  const sent: Record<string, string>[] = [];
  const post = (p: Record<string, string>) => {
    sent.push(p);
    if (p.billing_method === "initial_recurring") return Promise.reject(declined("3", "Invalid billing method"));
    return Promise.resolve({ response: "1", transactionid: "T9", cof_supported: "stored" });
  };
  const out = await nmiPostCof({ type: "sale" }, "cit_initial_recurring", { post });
  assertEquals(sent.map((s) => s.billing_method), ["initial_recurring", "recurring"]);
  assertEquals([out.billingMethod, out.cofSupported, out.fellBack], ["recurring", "stored", true]);
  assert(String(out.refusedWith).includes("Invalid billing method"));
});

Deno.test("nmiPostCof never retries a card decline, a transport failure, or any other kind", async () => {
  for (const [kind, err] of [
    ["cit_initial_recurring", declined("2", "DECLINE")],
    ["cit_initial_recurring", new Error("GATEWAY_UNKNOWN: reset")],
    ["cit_initial_unscheduled", declined("3")],
    ["cit_used", declined("3")],
  ] as const) {
    let calls = 0;
    const post = () => { calls++; return Promise.reject(err); };
    let threw = false;
    try { await nmiPostCof({ type: "sale" }, kind, { post, initialTxn: "I1" }); } catch (e) { threw = e === err; }
    assert(threw, `${kind}: the original error comes back`);
    assertEquals(calls, 1, `${kind} retried`);
  }
});

Deno.test("NmiDeclined keeps the gateway's sentence as its message (every old caller reads .message)", () => {
  const e = declined("2", "Insufficient funds");
  assert(e instanceof Error && e.message === "Insufficient funds" && e.response === "2");
});

// ── 3. The receipt ──────────────────────────────────────────────────────────────────────────

Deno.test("the receipt names the amount, the card, why, the balance and the reference", () => {
  const m = topupReceiptEmail({ amountCents: 25000, balanceCents: 31000, last4: "4242", saleTxn: "T77", at: new Date("2026-10-20T15:00:00Z"), trigger: "auto", thresholdCents: 10000 });
  assertEquals(m.subject, "Receipt: $250 automatic wallet top-up");
  for (const s of ["your card ending 4242 $250", "fell below $100", "$310", "T77", "turn off automatic top-ups", "support@csmsynergy.com"]) {
    assert(m.text.includes(s), `missing ${s}: ${m.text}`);
  }
  const op = topupReceiptEmail({ amountCents: 5000, balanceCents: null, last4: null, saleTxn: null, at: new Date(), trigger: "operator" });
  assert(op.text.includes("your card on file $50") && op.text.includes("CSM Synergy added funds"), op.text);
  assert(!/<script/i.test(topupReceiptEmail({ amountCents: 5000, balanceCents: 0, last4: null, saleTxn: "<script>x</script>", at: new Date(), trigger: "auto" }).html), "escaped");
});

function receiptAdmin() {
  const updates: Record<string, unknown>[] = [];
  const admin = {
    from: (t: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.update = (patch: Record<string, unknown>) => { updates.push({ t, ...patch }); return q; };
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: t === "client_users" ? [{ user_id: "u1", role: "owner" }] : null, error: null }).then(ok);
      return q;
    },
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: { email: "Owner@Example.test" } } }) } },
  };
  return { admin, updates };
}
const INPUT = { amountCents: 25000, balanceCents: 1, last4: "4242", saleTxn: "T1", at: new Date(), trigger: "auto" as const, thresholdCents: 10000 };

Deno.test("sendTopupReceipt mails the owners and records it on the attempt", async () => {
  const { admin, updates } = receiptAdmin();
  const sent: Record<string, unknown>[] = [];
  const out = await sendTopupReceipt(admin, "c1", 41, INPUT, null, {
    configured: () => true, send: (m) => { sent.push(m as unknown as Record<string, unknown>); return Promise.resolve({ id: "e1" }); }, log: () => Promise.resolve(),
  });
  assertEquals(out, { sent: 1, error: null });
  assertEquals(sent.map((m) => m.to), ["owner@example.test"]);
  assert(updates.some((u) => u.t === "billing_charge_attempts" && typeof u.receipt_sent_at === "string"));
});

Deno.test("sendTopupReceipt never throws: unconfigured or failing mail is recorded and logged", async () => {
  const a = receiptAdmin();
  const logs: unknown[] = [];
  const off = await sendTopupReceipt(a.admin, "c1", 41, INPUT, null, { configured: () => false, log: (x) => { logs.push(x); return Promise.resolve(); } });
  assertEquals(off, { sent: 0, error: "platform email is not configured" });
  assert(a.updates.some((u) => u.receipt_error === "platform email is not configured"));
  assertEquals(logs.length, 1);
  const b = receiptAdmin();
  const down = await sendTopupReceipt(b.admin, "c1", 41, INPUT, null, { configured: () => true, send: () => Promise.reject(new Error("x")), log: () => Promise.resolve() });
  assertEquals(down.sent, 0);
  assert(String(down.error).includes("not sent"));
});

// ── After the review (2026-10-20) ────────────────────────────────────────────────────────────

Deno.test("a request carrying a one-use card token sends 'recurring' and is never retried", async () => {
  const sent: Record<string, string>[] = [];
  const post = (p: Record<string, string>) => { sent.push(p); return Promise.reject(declined("3", "Invalid billing method")); };
  let threw = false;
  try { await nmiPostCof({ type: "sale", payment_token: "tok" }, "cit_initial_recurring", { post }); } catch { threw = true; }
  assert(threw);
  assertEquals(sent.map((s) => s.billing_method), ["recurring"], "one call, and not the value a retry would need");
});

Deno.test("NMI_INITIAL_RECURRING_METHOD=initial_recurring opts the token path in once Deposyt confirms it", () => {
  Deno.env.set("NMI_INITIAL_RECURRING_METHOD", "initial_recurring");
  try {
    assertEquals(cofFields("cit_initial_recurring", { carriesToken: true }).billing_method, "initial_recurring");
  } finally {
    Deno.env.delete("NMI_INITIAL_RECURRING_METHOD");
  }
});

Deno.test("only a FIELD refusal is retried: an issuer communication error (response 3, code 420/421) or a processor error (400) is not", async () => {
  for (const code of ["400", "420", "421"]) {
    let calls = 0;
    const post = () => { calls++; return Promise.reject(new NmiDeclined({ response: "3", responsetext: "Communication error", response_code: code })); };
    try { await nmiPostCof({ type: "sale" }, "cit_initial_recurring", { post }); } catch { /* expected */ }
    assertEquals(calls, 1, `code ${code} was retried`);
  }
  assert(isFieldRefusal(new NmiDeclined({ response: "3", responsetext: "x", response_code: "441" })), "441 is a field refusal");
  assert(isFieldRefusal(new NmiDeclined({ response: "3", responsetext: "Invalid billing_method", response_code: "" })), "a sentence naming billing_method is one");
  assert(!isFieldRefusal(new NmiDeclined({ response: "2", responsetext: "Invalid billing_method", response_code: "300" })), "a decline never is");
});

Deno.test("a retry that fails too keeps the first refusal on the thrown error", async () => {
  const post = (p: Record<string, string>) => Promise.reject(p.billing_method === "initial_recurring" ? declined("3", "Invalid billing method") : declined("2", "DECLINE"));
  let caught: unknown = null;
  try { await nmiPostCof({ type: "sale", customer_vault_id: "v" }, "cit_initial_recurring", { post }); } catch (e) { caught = e; }
  assert(caught instanceof NmiDeclined && caught.response === "2", "the retry's own error comes back");
  assert(String((caught as { refusedWith?: string }).refusedWith).includes("Invalid billing method"), "with the first refusal on it");
});

Deno.test("the top-up and card-replacement sentences disclose top-ups CSM Synergy adds; the version check holds", () => {
  assert(/CSM Synergy adds funds to my wallet for me/.test(COF_CONSENT_TEMPLATES.topup), "topup");
  assert(/top-ups CSM Synergy adds to my wallet for me/.test(COF_CONSENT_TEMPLATES.cardUpdate), "cardUpdate");
  assert(consentCoversOperatorTopups(COF_CONSENT_VERSION), "the current version covers it");
  assert(consentCoversOperatorTopups("2027-01-01.1"), "a later version still covers it");
  assert(!consentCoversOperatorTopups("2026-01-01.1"), "an earlier one does not");
  for (const junk of [null, undefined, "", "v2", 5]) assert(!consentCoversOperatorTopups(junk), `junk ${String(junk)}`);
});

Deno.test("a receipt for a charge that is not credited yet says so, and shows no balance", () => {
  const m = topupReceiptEmail({ amountCents: 25000, balanceCents: 999, last4: "4242", saleTxn: "T1", at: new Date(), trigger: "operator", pendingCredit: true });
  assert(m.text.includes("has not shown up in your balance yet") && m.text.includes("do not add the same funds again"), m.text);
  assert(!m.text.includes("added it to your StructureStudio wallet") && !m.text.includes("Wallet balance now"), m.text);
});
