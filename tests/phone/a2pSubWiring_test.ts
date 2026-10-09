// Workstream 2, phase 6: A2P inside a builder's sub-account, as portal-sms runs it (read from the
// SHIPPED source; the Twilio flow itself is supabase/functions/_shared/twilioTrustHubPrimaryLink.test.ts).
//
// What is pinned in advanceOne's `ready` stage:
//   * a recorded profile is FINISHED (finishSecondaryCustomerProfile) only in a sub; on the parent a
//     profile texting made itself (its A2P trust product beside it) is reused exactly as before, with
//     no extra request, and one it did not make (phone_trust_profile's) is read once;
//   * a reused profile Twilio REJECTED stops the stage before the A2P trust product and the brand
//     (ProfileRejectedError: a 409 with its own sentence and one app_errors row; review 2026-10-09);
//   * a failed cross-account link writes the profile it stopped on (customer_profile_sid) BEFORE the
//     error goes back, only in a sub, so the next press finishes it instead of making another;
//   * the handler answers that failure with its own code and sentence only when it crossed accounts,
//     and tells a REFUSAL from a link Twilio never answered; on the parent the old row
//     (sms_registration_failed) and the old sentence.
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE.

import { assert } from "jsr:@std/assert@1";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SMS = await read("../../supabase/functions/portal-sms/index.ts");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`a2pSubWiring_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const READY = slice(SMS, 'case "ready": {', 'case "profile_pending": {', "advanceOne ready stage");
const CATCH = slice(SMS, "if (e instanceof TwilioAccountError) {", 'code: "sms_registration_failed"', "the handler's catch");

Deno.test("ready: a recorded profile is finished only in a sub; on the parent texting's own is reused as before", () => {
  assert(/const onSub = creds\?\.source === "sub";/.test(READY), "onSub is the sub test");
  const reuse = slice(READY, "if (reg.customer_profile_sid) {", "prof = { profileSid: reg.customer_profile_sid };", "the reuse branch");
  assert(/if \(onSub\) \{\s*reviewed = \(await finishSecondaryCustomerProfile\(reg\.customer_profile_sid, primaryProfileSid, trustHubHttp\(creds\)/.test(reuse), reuse);
  assert(/\} else if \(!reg\.a2p_profile_sid\) \{\s*reviewed = \(await fetchCustomerProfile\(reg\.customer_profile_sid, trustHubHttp\(creds\)\)\)\.status;\s*\}/.test(reuse),
    "on the parent, ONE read and only for a profile texting did not make (no A2P product beside it)");
  assert(/prof = \{ profileSid: reg\.customer_profile_sid \};/.test(READY), "and then reused");
});

Deno.test("ready: a reused profile Twilio rejected stops before the A2P trust product and the brand (review 2026-10-09)", () => {
  const i = READY.indexOf('if (reviewed === "twilio-rejected") {');
  const t = READY.indexOf("throw new ProfileRejectedError();", i);
  const a2p = READY.indexOf("createA2pTrustProduct(");
  assert(i > 0 && t > i && a2p > t, "the refusal is thrown before the A2P trust product is made");
  const C = slice(SMS, "if (e instanceof ProfileRejectedError) {", "const err = e as TrustHubError;", "the rejected-profile answer");
  assert(/code: "sms_registration_profile_rejected", severity: "error"/.test(C), C);
  assert(/json\(\{ error: PROFILE_REJECTED_SENTENCE, code: "profile_rejected" \}, 409\)/.test(C), C);
  assert(/filedAtReturnSite\.add\(res\)/.test(C), "filed once");
  assert(/Nothing was charged/.test(slice(SMS, "const PROFILE_REJECTED_SENTENCE =", ";", "the sentence")));
});

Deno.test("ready: a refused cross-account link records the profile it stopped on, in a sub only, and rethrows", () => {
  const made = slice(READY, "} else {", "const a2p = ", "the create branch");
  assert(/catch \(e\) \{\s*if \(onSub && e instanceof PrimaryProfileLinkError/.test(made), made);
  const i = made.indexOf("await set({ customer_profile_sid: e.profileSid });"), j = made.indexOf("throw e;");
  assert(i > 0 && j > i, "written down before the error goes back");
  assert(/note\(e\.refused \? "primary_link_refused" : "primary_link_unanswered"/.test(made), "and noted in the registration's events, refused or unanswered");
});

Deno.test("the handler: its own code and sentence only for a link that crossed accounts", () => {
  assert(/if \(err instanceof PrimaryProfileLinkError && err\.crossAccount\) \{/.test(CATCH), CATCH);
  assert(/code: err\.refused \? "twilio_primary_link_refused" : "twilio_primary_link_unanswered", severity: "error"/.test(CATCH), CATCH);
  assert(/code: "primary_link_refused",\s*\}, 502\)/.test(CATCH), "a refusal: 502, support notified");
  assert(/code: "primary_link_unanswered",\s*\}, 503\)/.test(CATCH), "no answer: 503, submit again (review 2026-10-09)");
  assert(/filedAtReturnSite\.add\(res\)/.test(CATCH), "filed once, not again by withErrorLog");
});
