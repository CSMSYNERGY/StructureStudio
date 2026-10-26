// Workstream 2, phase 4: the switch-on branches of the edge functions, wired to the shared
// decisions in supabase/functions/_shared/twilioAccount.ts.
//
// The decisions themselves (edgeWebhookAccount, signedBySub, webhookTenantVerdict,
// eventAccountVerdict) are tested with fakes in _shared/twilioAccount.test.ts. What is pinned here
// is that each handler, read from the SHIPPED source, still calls them, in the right place, and
// answers the way its own header promises:
//   * sms-inbound / sms-status: the account step runs before the parent's three-state check and
//     replaces it only for a sub; a refused account is a 401 BEFORE authentication; a tenant in
//     another account (or a failed read) AFTER authentication is logged and answered 200, never
//     stored (each file's ALWAYS-200-ONCE-AUTHENTICATED rule);
//   * twilio-events: a refused event is recorded under a key of its own, and acts on nothing;
//   * portal-sms check_auth_token: the parent's answer is unchanged while the switch is off, and a
//     sub with no token has its own verdict; the handler's catch maps TwilioAccountError;
//   * portal-settings: every tenantTwilio() result is checked before its account is used.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
//
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE.

import { assert } from "jsr:@std/assert@1";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const INBOUND = await read("../../supabase/functions/sms-inbound/index.ts");
const STATUS = await read("../../supabase/functions/sms-status/index.ts");
const EVENTS = await read("../../supabase/functions/twilio-events/index.ts");
const PORTAL_SMS = await read("../../supabase/functions/portal-sms/index.ts");
const SETTINGS = await read("../../supabase/functions/portal-settings/index.ts");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`twilioAccountWiring_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};
const before = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b);
  assert(i >= 0 && j >= 0, `${what}: "${a}" / "${b}" not found`);
  assert(i < j, `${what}: "${a}" must come before "${b}"`);
};

// ── sms-inbound ──────────────────────────────────────────────────────────────────────────────
Deno.test("sms-inbound: the account step (edgeWebhookAccount) signs a sub with its own token, and refuses with 401", () => {
  const step = slice(INBOUND, "const perAccount = await edgeWebhookAccount(", "// ── STAGE A", "the signature step");
  assert(step.includes("validateTwilioSignature(`${Deno.env.get(\"SUPABASE_URL\") ?? \"\"}/functions/v1/sms-inbound?key=${key}`, params, sig, token)"),
    "the sub's signature is checked over the same rebuilt URL, with the token the account step hands over");
  const refused = slice(step, 'if (perAccount.kind === "refused") {', "\n  }\n", "the refusal");
  for (const code of ["sms_account_lookup_failed", "sms_signature_invalid", "sms_wrong_account"]) {
    assert(refused.includes(code), `a refusal is logged as ${code}`);
  }
  assert(refused.trimEnd().endsWith("return deny();"), "an account refused before authentication is a 401");
  // The parent keeps its three states, and only a sub skips them.
  before(step, 'if (perAccount.kind === "sub") {', "} else if (hasSignatureKey()) {", "a sub replaces the parent's check, nothing else does");
  assert(step.includes("const ok = await validateTwilioSignature(url, params, sig);"), "the parent's check is today's, with the default (parent) token");
  assert(step.includes('code: "sms_signature_skipped"'), "and its unset-token state is still logged, not refused");
});

Deno.test("sms-inbound: a tenant in another account is logged and answered 200 after authentication, never stored", () => {
  before(INBOUND, "const clientId = String(tenant.client_id);", "const verdict = await webhookTenantVerdict(admin, account, clientId, envGet);", "the tenant is found first");
  before(INBOUND, "const verdict = await webhookTenantVerdict(admin, account, clientId, envGet);", "// ── STAGE B", "and checked before anything is read or written for it");
  const check = slice(INBOUND, "if (account) {\n    const verdict = await webhookTenantVerdict(", "// ── STAGE B", "the tenant check");
  assert(check.includes('"sms_account_lookup_failed"') && check.includes('"sms_account_mismatch"'), "both refusals are logged under their own codes");
  assert(check.includes("return twiml();") && !check.includes("deny()"), "a 200 with empty TwiML, never a 401 once authenticated");
});

// ── sms-status ───────────────────────────────────────────────────────────────────────────────
Deno.test("sms-status: the account step only with the switch on, and the parent's check otherwise unchanged", () => {
  const step = slice(STATUS, "if (subaccountsOn(envGet)) {", "const sid = String(params.MessageSid", "the signature step");
  before(step, "early = createClient(", "const perAccount = await edgeWebhookAccount(early, params.AccountSid, envGet,", "the early client only inside the switch");
  assert(step.includes("/functions/v1/sms-status?key=${key}`, params, sig, token)"), "the sub's signature over sms-status's own URL");
  const refused = slice(step, 'if (perAccount.kind === "refused") {', "\n    }\n", "the refusal");
  assert(refused.includes("return deny();") && refused.includes('"sms_account_lookup_failed"'), "a refused account is a 401; a failed lookup is logged");
  before(step, 'if (account?.source === "sub") {', "} else if (hasSignatureKey()) {", "only a sub skips the parent's check");
  assert(STATUS.includes("const admin = early ?? createClient("), "off, the client is made where it always was");
});

Deno.test("sms-status: a sub moves only its own rows; the parent's owner check answers 200 and writes nothing", () => {
  const scope = slice(STATUS, "let update = admin.from(\"sms_messages\")", "const { error } = await update;", "the scoped update");
  assert(scope.includes('update = update.eq("client_id", account.clientId ?? "");'), "a sub's status update is limited to its own business");
  assert(scope.includes("const verdict = await webhookTenantVerdict(admin, account, owner, envGet);"), "the parent's: the owner's account is checked");
  assert(scope.includes("return ok();") && !scope.includes("deny()"), "a refusal after authentication is a 200, nothing written");
  assert(scope.includes('"sms_account_mismatch"') && scope.includes('"sms_account_lookup_failed"'), "and logged");
});

// ── twilio-events ────────────────────────────────────────────────────────────────────────────
Deno.test("twilio-events: an event is acted on only when eventAccountVerdict says ok; a refusal keeps the real key free", () => {
  const block = slice(EVENTS, "if (perAccount && reg) {", "// ── Record first, act second", "the account check");
  assert(block.includes("const verdict = await eventAccountVerdict(admin, d, String(reg.client_id), envGet);"), "the shared decision");
  assert(block.includes("mismatched.push("), "reported as twilio_event_account_mismatch at the end of the batch");
  assert(block.includes("event_id: realKey ? `${realKey}:refused` : null"), "recorded under a key of its own, never the event's real one");
  assert(block.includes("client_id: null"), "with no tenant");
  assert(block.trimEnd().endsWith("continue;\n      }\n    }") || /continue;\s*}\s*}\s*$/.test(block), "and nothing below acts on it");
  assert(EVENTS.includes('code: "twilio_event_account_mismatch"'), "the batch report");
  assert(EVENTS.includes("const perAccount = subaccountsOn(envGet);"), "off, the block is skipped without a lookup");
});

// ── portal-sms ───────────────────────────────────────────────────────────────────────────────
Deno.test("portal-sms check_auth_token: off answers exactly as before; a sub with no token has its own verdict", () => {
  const c = slice(PORTAL_SMS, 'case "check_auth_token": {', "\n      default:", "check_auth_token");
  before(c, 'let which: Record<string, string> = {};', "if (subaccountsOn((k) => Deno.env.get(k))) {", "the answer carries no account key unless the switch is on");
  const on = slice(c, "if (subaccountsOn((k) => Deno.env.get(k))) {", 'if (!acct) return json({ ok: false, verdict: "no_account_sid", ...which });', "the switch-on branch");
  assert(on.includes('which = { account: "sub" };') && on.includes('which = { account: "parent" };'), "with it on, the answer says which account");
  assert(on.includes("tok = account.authToken ?? \"\";"), "a sub's own token (the one its webhooks are signed with) is checked");
  before(c, 'verdict: "sub_token_missing"', 'verdict: "empty"', "a sub with no token is not the parent's unset state");
  assert(c.includes('if (!tok && which.account === "sub") {'), "the sub verdict only for a sub");
});

Deno.test("portal-sms: a TwilioAccountError reaching the handler's catch is a refusal (not_ready) or a logged fault", () => {
  const c = slice(PORTAL_SMS, "if (e instanceof TwilioAccountError) {", "const err = e as TrustHubError;", "the catch");
  assert(c.includes('if (e.kind === "not_ready") {') && c.includes("}, 503);"), "not_ready: 503, still being set up");
  assert(c.includes('code: "twilio_account_lookup_failed"') && c.includes("}, 502);"), "a failed lookup: logged once, 502");
  // Inside the handler's catch, ahead of the generic TrustHub path (which would file it as a
  // registration failure with a Twilio code it never had).
  const handlerCatch = slice(PORTAL_SMS, "if (e instanceof BillingRefusal) return json(e.body, e.status);", "code: \"sms_registration_failed\",", "the handler's catch");
  before(handlerCatch, "if (e instanceof TwilioAccountError) {", "const err = e as TrustHubError;", "before the TrustHub error path");
});

// ── portal-settings ──────────────────────────────────────────────────────────────────────────
Deno.test("portal-settings: every tenantTwilio() answer is checked before its account is used", () => {
  const calls = [...SETTINGS.matchAll(/const tw = await tenantTwilio\(\);\n(.*)\n/g)];
  assert(calls.length >= 6, `expected the six Twilio paths, found ${calls.length}`);
  for (const m of calls) assert(/^\s*if \(!tw\.ok\) return /.test(m[1]), `an unchecked tenantTwilio(): ${m[1].trim()}`);
  const refused = slice(SETTINGS, "const tenantTwilioRefused = (e: unknown): Response => {", "\n  };\n", "tenantTwilioRefused");
  assert(refused.includes('if (e instanceof TwilioAccountError && e.kind === "not_ready") {') && refused.includes("return phoneUnavailable("),
    "a sub still being set up is the Phone tab's unavailable answer");
  assert(refused.includes('code: "twilio_account_lookup_failed"') && refused.includes("}, 502)"), "a failed lookup is a logged 502");
  assert(SETTINGS.includes("(tenantTwilioMemo ??= resolveTwilioAccount(admin, clientId, (k) => Deno.env.get(k))"),
    "resolved at most once per request, through the shared resolver");
});
