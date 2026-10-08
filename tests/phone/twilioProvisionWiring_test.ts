// Workstream 2, phase 3: where the builder's own Twilio sub-account is made, and who may START a
// texting registration while TWILIO_SUBACCOUNTS is off.
//
// ensureTwilioAccount itself is driven against fakes in supabase/functions/_shared/
// twilioProvision.test.ts. What is pinned here:
//   * the registration gate (portal-sms/registrationGate.ts), every case, run for real: a NEW
//     registration waits for the switch; one already at Twilio, a saved draft (save_intake only),
//     our internal account and a parent pin never do;
//   * portal-sms, read from the SHIPPED source: save_intake asks the gate before it writes; advance
//     asks it only with the switch off, then makes the account BEFORE the lock and before any stage,
//     and records the registration's account before anything is made there; buy_number makes sure
//     of the account before a number is bought, and the number row says which account;
//   * portal-settings phone_buy_number: the account is made after the rollout and billing checks and
//     BEFORE the wallet hold and the purchase; the number row says which account;
//   * the Phone tab's PHONE_SELF_SERVE opens only with TWILIO_SUBACCOUNTS on (phoneReview_test);
//   * the two copies of the Worker's default base agree.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { registrationAtTwilio, SMS_SIGNUP_CLOSED_SENTENCE, smsSignupRefusal } from "../../supabase/functions/portal-sms/registrationGate.ts";
import { DEFAULT_PHONE_API_BASE as SHARED_BASE } from "../../supabase/functions/_shared/twilioProvision.ts";
import { DEFAULT_PHONE_API_BASE as SETTINGS_BASE } from "../../supabase/functions/portal-settings/phoneNumber.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SMS = await read("../../supabase/functions/portal-sms/index.ts");
const SETTINGS = await read("../../supabase/functions/portal-settings/index.ts");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`twilioProvisionWiring_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};
const before = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b);
  assert(i >= 0 && j >= 0, `${what}: "${a}" / "${b}" not found`);
  assert(i < j, `${what}: "${a}" must come before "${b}"`);
};

// ── The gate, run for real ───────────────────────────────────────────────────────────────────
const never = () => { throw new Error("onParentByDecision should not have been asked"); };
const askedNo = () => Promise.resolve(false);
const askedYes = () => Promise.resolve(true);

Deno.test("gate: with the switch on, nothing is refused and nothing is asked", async () => {
  for (const action of ["save_intake", "advance"] as const) {
    assertEquals(await smsSignupRefusal({ action, subaccountsOn: true, reg: null, onParentByDecision: never }), null);
    assertEquals(await smsSignupRefusal({ action, subaccountsOn: true, reg: { status: "none" }, onParentByDecision: never }), null);
  }
});

Deno.test("gate: switch off, a NEW registration is refused with the builder's sentence", async () => {
  for (const action of ["save_intake", "advance"] as const) {
    for (const reg of [null, { status: "none" }]) {
      assertEquals(await smsSignupRefusal({ action, subaccountsOn: false, reg, onParentByDecision: askedNo }), SMS_SIGNUP_CLOSED_SENTENCE, `${action} ${JSON.stringify(reg)}`);
    }
  }
  assert(!/twilio|sub-?account|parent/i.test(SMS_SIGNUP_CLOSED_SENTENCE), "a builder-facing sentence, not our plumbing");
});

Deno.test("gate: switch off, a registration already at Twilio always continues (nobody mid-registration is stranded)", async () => {
  const atTwilio = [
    { status: "profile_pending" }, { status: "brand_pending" }, { status: "brand_failed", brand_sid: "BN" + "0".repeat(32) },
    { status: "campaign_pending" }, { status: "active" }, { status: "ready", customer_profile_sid: "BU" + "0".repeat(32) },
    { status: "none", messaging_service_sid: "MG" + "0".repeat(32) }, { status: "ready", twilio_account_sid: "AC" + "5".repeat(32) },
  ];
  for (const reg of atTwilio) {
    assert(registrationAtTwilio(reg), JSON.stringify(reg));
    for (const action of ["save_intake", "advance"] as const) {
      assertEquals(await smsSignupRefusal({ action, subaccountsOn: false, reg, onParentByDecision: never }), null, `${action} ${JSON.stringify(reg)}`);
    }
  }
});

Deno.test("gate: switch off, a saved draft may still be edited; its first SUBMIT is what waits", async () => {
  for (const status of ["intake", "aup_pending", "ready"]) {
    assert(!registrationAtTwilio({ status }), status);
    assertEquals(await smsSignupRefusal({ action: "save_intake", subaccountsOn: false, reg: { status }, onParentByDecision: never }), null, status);
    assertEquals(await smsSignupRefusal({ action: "advance", subaccountsOn: false, reg: { status }, onParentByDecision: askedNo }), SMS_SIGNUP_CLOSED_SENTENCE, status);
  }
});

Deno.test("gate: switch off, our internal account and a parent pin are never refused", async () => {
  for (const action of ["save_intake", "advance"] as const) {
    assertEquals(await smsSignupRefusal({ action, subaccountsOn: false, reg: { status: "none" }, onParentByDecision: askedYes }), null);
  }
});

// ── portal-sms, the shipped source ───────────────────────────────────────────────────────────
Deno.test("portal-sms: the gate's own reads are the internal flag and the parent pin, and a failed read refuses", () => {
  const fn = slice(SMS, "const onParentByDecision = async (): Promise<boolean> => {", "\n  };\n", "onParentByDecision");
  assert(fn.includes('admin.from("client_settings").select("internal_account").eq("client_id", clientId).maybeSingle()'));
  assert(fn.includes('admin.from("twilio_accounts").select("kind").eq("client_id", clientId).maybeSingle()'));
  assert(fn.includes('?.internal_account === true') && fn.includes('?.kind === "parent"'), "only a positive answer allows it");
  const refused = slice(SMS, "const signupRefused = async", "\n  };\n", "signupRefused");
  assert(refused.includes('json({ error: why, code: "sms_signup_closed" }, 403)'), "a 403 with the gate's own sentence");
});

Deno.test("portal-sms save_intake: the gate is asked after the row is loaded and before anything is written", () => {
  const c = slice(SMS, 'case "save_intake": {', 'case "compliance_check": {', "save_intake");
  before(c, "const reg = await load();", 'const closed = await signupRefused("save_intake", reg);', "save_intake");
  before(c, 'const closed = await signupRefused("save_intake", reg);', 'await admin.from("sms_registrations").update({', "save_intake");
  assert(c.includes("if (closed) return closed;"));
});

Deno.test("portal-sms advance: gate (switch off only) → account made → registration marked → lock → stages", () => {
  const c = slice(SMS, 'case "advance": {', 'case "search_numbers": {', "advance");
  const gate = slice(c, "if (!subaccountsSwitch()) {", "\n        }\n", "the gate block");
  assert(gate.includes('const closed = await signupRefused("advance", current);') && gate.includes("if (closed) return closed;"));
  assert(gate.includes("if (curErr) return json("), "a registration that cannot be read is not guessed at");
  // can_bill and configuration first, as before.
  before(c, "if (r.ctx.operator && !r.ctx.operator.canBill) {", "if (!subaccountsSwitch()) {", "billing before the gate");
  before(c, "if (!subaccountsSwitch()) {", "const notReady = await ensureAccount();", "the gate before the account");
  before(c, "const notReady = await ensureAccount();", "const creds = await tenantCreds();", "the account is made before it is resolved");
  before(c, "const creds = await tenantCreds();", '.update({ twilio_account_sid: creds.accountSid }).eq("client_id", clientId).is("twilio_account_sid", null);', "then the registration is marked");
  before(c, '.is("twilio_account_sid", null);', ".update({ advance_lock_until: lockUntil })", "all before the lock");
  before(c, ".update({ advance_lock_until: lockUntil })", "await advanceOne(admin, clientId, locked, p, primary, note, userId ?? null, creds);", "and before any stage");
  const mark = slice(c, 'if (creds?.source === "sub") {', "\n        }\n", "the mark");
  assert(mark.includes("if (markErr) {") && mark.includes("}, 502);"), "a mark that fails stops before anything is made at Twilio");
});

Deno.test("portal-sms buy_number: the account is sure before a number is found, adopted or bought; the row says which", () => {
  const c = slice(SMS, 'case "buy_number": {', 'case "opt_outs": {', "buy_number");
  before(c, "const notReady = await ensureAccount();", "const creds = await tenantCreds();", "ensure first");
  before(c, "const creds = await tenantCreds();", "const already = await findPurchasedNumbers(clientId, creds);", "then the purchase path");
  before(c, "const notReady = await ensureAccount();", "takeHold(admin, clientId, \"sms_number_monthly\"", "and before the wallet hold");
  assert(c.includes('...(creds?.source === "sub" ? { twilio_account_sid: creds.accountSid } : {}),'), "the number row records the sub; the parent's is unchanged");
});

Deno.test("portal-sms ensureAccount: refusals answer with ensureRefusalSentence; faults are logged once", () => {
  const fn = slice(SMS, "const ensureAccount = async (): Promise<Response | null> => {", "\n  };\n", "ensureAccount");
  assert(fn.includes("const prov = await ensureTwilioAccount(admin, clientId, { get: (k) => Deno.env.get(k) });"));
  assert(fn.includes('code: notConfigured ? "twilio_provision_not_configured" : "twilio_provision_failed"'));
  assert(fn.includes("filedAtReturnSite.add(res)"), "the fault is not filed twice by withErrorLog");
  assert(!/prov\.missing \?\? \[\]\)\.join[^;]*json\(/.test(fn), "the missing names go to the log, never to the browser");
});

// ── portal-settings phone_buy_number ─────────────────────────────────────────────────────────
Deno.test("portal-settings phone_buy_number: rollout → billing → the account → resolve → hold and buy, the row says which account", () => {
  const buy = slice(SETTINGS, 'if (action === "phone_buy_number") {', "// ── Migration 266: a calling-only number joins texting", "phone_buy_number");
  before(buy, "const refused = await phoneRolloutGate();", "if (!mayBuyPhoneNumber()) {", "rollout first");
  before(buy, "if (!mayBuyPhoneNumber()) {", "const prov = await ensureTwilioAccount(admin, clientId, { get: (k) => Deno.env.get(k) });", "billing before the account is made");
  before(buy, "const prov = await ensureTwilioAccount(", "const tw = await tenantTwilio();", "the account is made before it is resolved");
  before(buy, "const prov = await ensureTwilioAccount(", "hold: takeNumberHold", "and before the wallet hold");
  before(buy, "const prov = await ensureTwilioAccount(", "buyCallingNumber(", "and before the purchase");
  const refusal = slice(buy, "if (!prov.ok) {", "\n    }\n    // Everything the new number needs", "the refusal");
  assert(refusal.includes("return phoneUnavailable(ensureRefusalSentence(prov));"), "not configured: the Phone tab's unavailable answer");
  assert(refusal.includes('if (prov.reason === "busy") return json({ error: ensureRefusalSentence(prov) }, 409);'));
  assert(refusal.includes("return phoneRefused(ensureRefusalSentence(prov), 403);"), "suspended or closed: a marked refusal");
  assert(refusal.includes('code: "twilio_provision_failed"') && refusal.includes("return filedHere(json({ error: ensureRefusalSentence(prov) }, 502));"));
});

Deno.test("the Worker's default base: twilioProvision.ts and phoneNumber.ts agree", () => {
  assertEquals(SHARED_BASE, SETTINGS_BASE);
});
