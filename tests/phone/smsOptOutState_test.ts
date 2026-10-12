// Opt-out state (2026-10-13), asked for 2026-10-12: "Can we see if a customer has opted out?"
//
// Three places must agree with the send path (_shared/smsSend.ts), which refuses a text when the
// NUMBER has an sms_opt_outs row or the contact has the older crm_contacts.sms_opt_out_at:
//   * portal-settings crm_record: the record page's composer (`sms.optedOut`, and since the fix
//     round `sms.optOutReason`). It read only the contact's flag, so an opt-out recorded on the
//     number alone (a STOP before the contact was saved, an import's do-not-disturb, a contact
//     re-created after its STOP) showed nothing and Send failed. Its "Customer agreed to texts"
//     (crm_record_consent) had the same gap and could record a grant over such an opt-out;
//   * the phone-api Worker's GET /threads/:key `sms` (workers/phone-api/test/threadSms.test.ts
//     drives it end to end);
//   * the writers of a Twilio 21610: smsSend at send time, sms-status when it comes later in a
//     delivery status, both through _shared/smsOptOut.ts recordTwilioOptOut (one write, never two
//     copies; smsStatusOptOut_test.ts and smsOptOut.test.ts drive them).
// The screens read it through ONE helper, _shared/smsOptOut.ts smsOptOutFacts (smsOptOut.test.ts
// drives it: the number's row alone, the contact's flag alone, both, neither), so the portal and
// the Worker cannot word or decide it differently.
//
// portal-settings and sms-status end in Deno.serve, so their wiring is checked on the SHIPPED
// source between stable anchors, the crmCreateContact_test way. If an anchor moves, re-point it;
// do not delete the test.
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/

import { assert } from "jsr:@std/assert@1";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SETTINGS = await read("../../supabase/functions/portal-settings/index.ts");
const STATUS = await read("../../supabase/functions/sms-status/index.ts");
const SEND = await read("../../supabase/functions/_shared/smsSend.ts");
const READS = await read("../../workers/phone-api/src/routes/reads.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`smsOptOutState_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j + b.length);
};

Deno.test("crm_record: optedOut asks the number's sms_opt_outs row as well as the contact's flag, in the same wait, and says why", () => {
  assert(SETTINGS.includes('import { readSmsOptOut, smsOptOutFacts, smsOptOutRefusal } from "../_shared/smsOptOut.ts";'), "the shared reader");
  const block = slice(SETTINGS, "const [cfgRes, grantRes, optOutRes] = await Promise.all([", "consented:", "crm_record's SMS block");
  // readSmsOptOut: this business's row on the contact's 10 digits, nothing asked without a number
  // (smsOptOut.test.ts drives it, another business's row included).
  assert(block.includes("readSmsOptOut(admin, clientId, contact && contact.phone_digits),"), "the number's row, read the shared way, in the same wait");
  assert(!block.includes('admin.from("sms_opt_outs")'), "no second copy of the read");
  assert(block.includes("const optOut = smsOptOutFacts(optOutRes.data, contact ? contact.sms_opt_out_at : null);"), "either record of it, folded the shared way");
  assert(block.includes("optedOut: optOut.optedOut,"), "opted out on either");
  assert(block.includes("optOutReason: optOut.reason,"), "and why (additive: main's frontend reads optedOut alone)");
});

Deno.test("crm_record_consent: a grant is refused over EITHER record of an opt-out, worded by its reason, before anything is written", () => {
  const action = slice(SETTINGS, 'if (action === "crm_record_consent") {', 'await admin.from("sms_consent_log").insert({', "crm_record_consent");
  assert(action.includes("const { data: optOutRow, error: optOutErr } = await readSmsOptOut(admin, clientId, c.phone_digits);"), "this business's row for this contact's number");
  assert(action.includes('if (optOutErr) return dbFail(req, clientId, "check whether this customer opted out of texts", optOutErr);'), "a failed read refuses: a wrong \"no\" would let a grant through");
  assert(action.includes("const optOut = smsOptOutFacts(optOutRow, c.sms_opt_out_at);"), "both records, read the shared way");
  assert(action.includes("return json({ error: smsOptOutRefusal(optOut.reason) }, 409);"), "a 409 in the customer's terms");
  assert(!action.includes("if (c.sms_opt_out_at) {"), "no longer the contact's flag alone");
  // The refusal comes before the attestation is even read, so nothing is written for an opted-out number.
  assert(action.indexOf("smsOptOutRefusal(") < action.indexOf("const attestation ="), "refused before the attestation");
});

Deno.test("smsSend checks the same two facts the screens now show", () => {
  assert(SEND.includes('admin.from("sms_opt_outs")\n      .select("reason").eq("client_id", clientId).eq("phone_digits", key).maybeSingle();'), "the number's opt-out");
  assert(SEND.includes('.select("sms_opt_out_at").eq("client_id", clientId).eq("id", msg.contactId).maybeSingle();'), "the contact's flag");
  const state = slice(READS, "export async function smsStateFor(", "\n}\n", "the Worker's smsStateFor");
  assert(state.includes("readSmsOptOut(c.admin, c.ctx.client_id, digits),"), "the Worker asks the number's opt-out, the shared way");
  assert(state.includes('.eq("action", "granted").limit(1)'), "and, like smsSend, \"is there a grant?\", not the newest row");
  assert(state.includes("const o = smsOptOutFacts(row, contactOptOutAt);"), "either record of it, read as the portal reads it");
  assert(READS.includes('from "../../../../supabase/functions/_shared/smsOptOut.ts";'), "the shared reader");
  assert(READS.includes("export const optOutReasonOf = smsOptOutReasonOf;"), "one reason mapping for the Worker and the portal");
});

Deno.test("a 21610 is written one way: smsSend and sms-status both call recordTwilioOptOut, and neither writes it by hand", () => {
  assert(SEND.includes("await recordTwilioOptOut(admin, clientId, key, msg.contactId ?? null);"), "smsSend at send time");
  assert(!SEND.includes('from("sms_opt_outs").upsert('), "no second copy of the write in smsSend");
  assert(STATUS.includes("await recordTwilioOptOut(admin, row.client_id, smsPhoneKey(row.to_number), row.contact_id)"), "sms-status later");
  assert(!STATUS.includes('from("sms_opt_outs")'), "no second copy of the write in sms-status");
});

Deno.test("sms-status: the 21610 step runs after the status update, from our own row, on the update's own tenant terms", () => {
  const after = slice(STATUS, "const { error } = await update;", "return ok();\n}));", "the end of the handler");
  const step = slice(after, "if (optedOutByStatus(patch)) {", "\n  }\n", "the 21610 step");
  assert(step.includes('admin.from("sms_messages").select("client_id, contact_id, direction, to_number").eq("provider_sid", sid)'), "the number and contact come from our row");
  assert(step.includes('if (account?.source === "sub") find = find.eq("client_id", account.clientId ?? "");'), "a sub only finds its own business's row");
  assert(step.includes('row && row.direction === "out" && row.to_number'), "only a text we sent");
  assert(step.includes('code: "sms_opt_out_record_failed"'), "a failed write is logged");
  assert(!step.includes("params.To") && !step.includes("params.From"), "never the callback's own numbers");
});
