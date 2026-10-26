// Workstream 2, phase 3: where the builder's own Twilio sub-account is made, and who may START a
// texting registration while TWILIO_SUBACCOUNTS is not "on" (off, or "manual").
//
// ensureTwilioAccount itself is driven against fakes in supabase/functions/_shared/
// twilioProvision.test.ts. What is pinned here:
//   * the registration gate (portal-sms/registrationGate.ts), every case, run for real: a NEW
//     registration waits for the switch; one already at Twilio, a saved draft (save_intake only),
//     and a tenant whose account is decided (internal, a pin, parent holdings, "manual" with a sub)
//     never do; switch OFF, a registration that lives in a sub-account waits (review M3);
//   * portal-sms, read from the SHIPPED source: save_intake asks the gate before it writes; advance
//     asks it only with the switch off, then makes the account BEFORE the lock and before any stage,
//     and records the registration's account before anything is made there; buy_number makes sure
//     of the account before a number is bought, and the number row says which account;
//   * portal-settings phone_buy_number: the switch-off sub check (review H1), then the account, both
//     after the rollout and billing checks and BEFORE the wallet hold and the purchase; the number
//     row says which account; a number in a sub takes the sub's own voicemail TwiML, never the
//     parent's Bin (connect, the voicemail switch, the purchase);
//   * the Phone tab's PHONE_SELF_SERVE opens only with TWILIO_SUBACCOUNTS on (phoneReview_test);
//   * the two copies of the Worker's default base agree.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  registrationAtTwilio, registrationUnreachable, SMS_PAUSED_SENTENCE, SMS_SIGNUP_CLOSED_SENTENCE, smsSignupRefusal,
} from "../../supabase/functions/portal-sms/registrationGate.ts";
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
const never = () => { throw new Error("accountDecided should not have been asked"); };
const askedNo = () => Promise.resolve(false);
const askedYes = () => Promise.resolve(true);

Deno.test("gate: with the switch on, nothing is refused and nothing is asked", async () => {
  for (const action of ["save_intake", "advance"] as const) {
    assertEquals(await smsSignupRefusal({ action, mode: "on", reg: null, accountDecided: never }), null);
    assertEquals(await smsSignupRefusal({ action, mode: "on", reg: { status: "none" }, accountDecided: never }), null);
    assertEquals(await smsSignupRefusal({ action, mode: "on", reg: { status: "brand_pending", twilio_account_sid: "AC" + "5".repeat(32) }, accountDecided: never }), null);
  }
});

Deno.test("gate: switch off or manual, a NEW registration is refused with the builder's sentence", async () => {
  for (const mode of ["off", "manual"] as const) {
    for (const action of ["save_intake", "advance"] as const) {
      for (const reg of [null, { status: "none" }]) {
        assertEquals(await smsSignupRefusal({ action, mode, reg, accountDecided: askedNo }), SMS_SIGNUP_CLOSED_SENTENCE, `${mode} ${action} ${JSON.stringify(reg)}`);
      }
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
    for (const mode of ["off", "manual"] as const) {
      // Off, one that lives in a SUB-account is the exception (its own test below).
      if (mode === "off" && reg.twilio_account_sid) continue;
      for (const action of ["save_intake", "advance"] as const) {
        assertEquals(await smsSignupRefusal({ action, mode, reg, accountDecided: never }), null, `${mode} ${action} ${JSON.stringify(reg)}`);
      }
    }
  }
});

Deno.test("gate: switch OFF, a registration that lives in a sub-account waits (the parent cannot reach it); editing its intake does not", async () => {
  const inSub = { status: "brand_pending", twilio_account_sid: "AC" + "5".repeat(32), brand_sid: "BN" + "0".repeat(32) };
  assert(registrationUnreachable("off", inSub) && !registrationUnreachable("manual", inSub) && !registrationUnreachable("on", inSub));
  assert(!registrationUnreachable("off", { status: "brand_pending", brand_sid: "BN" + "0".repeat(32) }), "a parent registration is reachable");
  assertEquals(await smsSignupRefusal({ action: "advance", mode: "off", reg: inSub, accountDecided: never }), SMS_PAUSED_SENTENCE);
  assertEquals(await smsSignupRefusal({ action: "save_intake", mode: "off", reg: inSub, accountDecided: never }), null);
  assert(!/twilio|sub-?account|parent/i.test(SMS_PAUSED_SENTENCE), "a builder-facing sentence");
});

Deno.test("gate: switch off, a saved draft may still be edited; its first SUBMIT is what waits", async () => {
  for (const status of ["intake", "aup_pending", "ready"]) {
    assert(!registrationAtTwilio({ status }), status);
    assertEquals(await smsSignupRefusal({ action: "save_intake", mode: "off", reg: { status }, accountDecided: never }), null, status);
    assertEquals(await smsSignupRefusal({ action: "advance", mode: "off", reg: { status }, accountDecided: askedNo }), SMS_SIGNUP_CLOSED_SENTENCE, status);
  }
});

Deno.test("gate: a tenant whose account is decided is never refused", async () => {
  for (const mode of ["off", "manual"] as const) {
    for (const action of ["save_intake", "advance"] as const) {
      assertEquals(await smsSignupRefusal({ action, mode, reg: { status: "none" }, accountDecided: askedYes }), null);
    }
  }
});

// ── portal-sms, the shipped source ───────────────────────────────────────────────────────────
Deno.test("portal-sms: the gate's own reads (internal flag, the account row, parent holdings), and a failed read refuses", () => {
  const fn = slice(SMS, "const accountDecided = async (): Promise<boolean> => {", "\n  };\n", "accountDecided");
  assert(fn.includes('admin.from("client_settings").select("internal_account").eq("client_id", clientId).maybeSingle()'));
  assert(fn.includes('admin.from("twilio_accounts").select("kind").eq("client_id", clientId).maybeSingle()'));
  assert(fn.includes('admin.rpc("twilio_parent_holdings", { p_client_id: clientId })'), "review L1: holdings on the parent decide it");
  assert(fn.includes('?.internal_account === true') && fn.includes('kind === "parent"') && fn.includes("(!held?.error && !!held?.data)"), "only a positive answer allows it");
  assert(fn.includes('(kind === "sub" && switchMode() === "manual")'), "a sub-account counts only while the switch is manual (off, the parent would make it)");
  const refused = slice(SMS, "const signupRefused = async", "\n  };\n", "signupRefused");
  assert(refused.includes('json({ error: why, code: "sms_signup_closed" }, 403)'), "a 403 with the gate's own sentence");
  assert(refused.includes("smsSignupRefusal({ action: act, mode: switchMode(), reg, accountDecided })"));
});

Deno.test("portal-sms status: the lazy sweep and the rejection read leave a sub's registration alone while the switch is off", () => {
  const c = slice(SMS, 'case "status": {', 'case "save_intake": {', "status");
  assert(c.includes("&& !registrationUnreachable(switchMode(), reg);"), "the sweep");
  assert(c.includes("trustHubConfigured() && !registrationUnreachable(switchMode(), reg)) {"), "the rejection read");
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
  before(c, "const offSub = await subAccountWhileOff(admin, clientId, (k) => Deno.env.get(k));", "const notReady = await ensureAccount();", "review H1: the switch-off sub check first");
  assert(c.includes('if (offSub === "sub") return json({ error: SUB_WHILE_OFF_SENTENCE, code: "twilio_sub_while_off" }, 409);'));
  before(c, "const notReady = await ensureAccount();", "const creds = await tenantCreds();", "ensure first");
  before(c, "const creds = await tenantCreds();", "const already = await findPurchasedNumbers(clientId, creds);", "then the purchase path");
  before(c, "const notReady = await ensureAccount();", "takeHold(admin, clientId, \"sms_number_monthly\"", "and before the wallet hold");
  assert(c.includes('...(creds?.source === "sub" ? { twilio_account_sid: creds.accountSid } : {}),'), "the number row records the sub; the parent's is unchanged");
});

Deno.test("portal-sms ensureAccount: refusals answer with ensureRefusalSentence; faults are logged once", () => {
  const fn = slice(SMS, "const ensureAccount = async (): Promise<Response | null> => {", "\n  };\n", "ensureAccount");
  assert(fn.includes("const prov = await ensureTwilioAccount(admin, clientId, { get: (k) => Deno.env.get(k) });"));
  assert(fn.includes('|| prov.reason === "manual") {'), "manual: the builder's sentence, not a logged fault");
  assert(fn.includes('code: notConfigured ? "twilio_provision_not_configured" : "twilio_provision_failed"'));
  assert(fn.includes("filedAtReturnSite.add(res)"), "the fault is not filed twice by withErrorLog");
  assert(!/prov\.missing \?\? \[\]\)\.join[^;]*json\(/.test(fn), "the missing names go to the log, never to the browser");
});

// ── portal-settings phone_buy_number ─────────────────────────────────────────────────────────
Deno.test("portal-settings phone_buy_number: rollout → billing → the account → resolve → hold and buy, the row says which account", () => {
  const buy = slice(SETTINGS, 'if (action === "phone_buy_number") {', "// ── Migration 266: a calling-only number joins texting", "phone_buy_number");
  before(buy, "const refused = await phoneRolloutGate();", "if (!mayBuyPhoneNumber()) {", "rollout first");
  before(buy, "if (!mayBuyPhoneNumber()) {", "const offSub = await subAccountWhileOff(admin, clientId, (k) => Deno.env.get(k));", "billing before the H1 check");
  before(buy, "const offSub = await subAccountWhileOff(", "const prov = await ensureTwilioAccount(admin, clientId, { get: (k) => Deno.env.get(k) });", "the H1 check before the account");
  assert(buy.includes('if (offSub === "sub") return json({ error: SUB_WHILE_OFF_SENTENCE, code: "twilio_sub_while_off" }, 409);'));
  before(buy, "const offSub = await subAccountWhileOff(", "hold: takeNumberHold", "and before the wallet hold");
  before(buy, "if (!mayBuyPhoneNumber()) {", "const prov = await ensureTwilioAccount(admin, clientId, { get: (k) => Deno.env.get(k) });", "billing before the account is made");
  before(buy, "const prov = await ensureTwilioAccount(", "const tw = await tenantTwilio();", "the account is made before it is resolved");
  before(buy, "const prov = await ensureTwilioAccount(", "hold: takeNumberHold", "and before the wallet hold");
  before(buy, "const prov = await ensureTwilioAccount(", "buyCallingNumber(", "and before the purchase");
  const refusal = slice(buy, "if (!prov.ok) {", "\n    }\n    // Everything the new number needs", "the refusal");
  assert(refusal.includes("return phoneUnavailable(ensureRefusalSentence(prov));"), "not configured: the Phone tab's unavailable answer");
  assert(refusal.includes('if (prov.reason === "busy") return json({ error: ensureRefusalSentence(prov) }, 409);'));
  assert(refusal.includes("return phoneRefused(ensureRefusalSentence(prov), 403);"), "suspended or closed: a marked refusal");
  assert(refusal.includes('code: "twilio_provision_failed"') && refusal.includes("return filedHere(json({ error: ensureRefusalSentence(prov) }, 502));"));
  assert(refusal.includes('if (prov.reason === "manual") return json({ error: ensureRefusalSentence(prov), code: `twilio_manual_${prov.code}` }, 409);'));
  // The new number's voicemail: the sub's own, after the account is resolved.
  before(buy, "const tw = await tenantTwilio();", 'const ve = voiceEnv((k) => Deno.env.get(k), creds?.source === "sub");', "the account before its voicemail");
  before(buy, 'const ve = voiceEnv((k) => Deno.env.get(k), creds?.source === "sub");', "buyCallingNumber(", "checked before the purchase");
  assert(buy.includes("config: { ...numberVoicemailConfig(ve.env),"), "the purchase's voicemail settings come from that env");
});

Deno.test("portal-settings: a number in a sub-account is never pointed at the parent's Bin (connect, and calling switched off)", () => {
  const connect = slice(SETTINGS, "const connectNumberForCalls = async (n: PhoneNum):", "\n  };\n", "connectNumberForCalls");
  before(connect, "const creds = tw.account;", 'const vEnv = creds.source === "sub" ? voiceEnv((k) => Deno.env.get(k), true) : ve;', "the account before its env");
  assert(connect.includes("const config = { ...numberVoiceConfig(vEnv.env),"), "the number's fallback comes from the account's env");
  const vm = slice(SETTINGS, "const numberToVoicemail = async (n: PhoneNum): Promise<boolean> => {", "\n  };\n", "numberToVoicemail");
  assert(vm.includes('const target = onSub ? subVoicemailUrlOf((k) => Deno.env.get(k)) : fallbackUrl;'));
  assert(vm.includes('config: numberVoicemailConfig({ fallbackUrl: target, ...(onSub ? { fallbackMethod: "GET" as const } : {}) }),'));
});

Deno.test("the Worker's default base: twilioProvision.ts and phoneNumber.ts agree", () => {
  assertEquals(SHARED_BASE, SETTINGS_BASE);
});
