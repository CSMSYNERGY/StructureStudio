// Workstream 2, phase 6: A2P inside a builder's sub-account, as portal-sms runs it (read from the
// SHIPPED source; the Twilio flow itself is supabase/functions/_shared/twilioTrustHubPrimaryLink.test.ts).
//
// What is pinned in advanceOne's `ready` stage:
//   * a recorded profile is FINISHED (finishSecondaryCustomerProfile) only in a sub; on the parent it
//     is reused exactly as before, with no extra request;
//   * a refused cross-account link writes the profile it stopped on (customer_profile_sid) BEFORE the
//     error goes back, only in a sub, so the next press finishes it instead of making another;
//   * the handler answers that refusal with its own code and sentence only when it crossed accounts;
//     on the parent the old row (sms_registration_failed) and the old sentence.
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

Deno.test("ready: a recorded profile is finished only in a sub; on the parent it is reused as before", () => {
  assert(/const onSub = creds\?\.source === "sub";/.test(READY), "onSub is the sub test");
  const reuse = slice(READY, "if (reg.customer_profile_sid) {", "} else {", "the reuse branch");
  assert(/if \(onSub\) \{\s*await finishSecondaryCustomerProfile\(reg\.customer_profile_sid, primaryProfileSid, trustHubHttp\(creds\)/.test(reuse), reuse);
  assert(/prof = \{ profileSid: reg\.customer_profile_sid \};/.test(reuse), "and then reused");
});

Deno.test("ready: a refused cross-account link records the profile it stopped on, in a sub only, and rethrows", () => {
  const made = slice(READY, "} else {", "const a2p = ", "the create branch");
  assert(/catch \(e\) \{\s*if \(onSub && e instanceof PrimaryProfileLinkError/.test(made), made);
  const i = made.indexOf("await set({ customer_profile_sid: e.profileSid });"), j = made.indexOf("throw e;");
  assert(i > 0 && j > i, "written down before the error goes back");
  assert(/note\("primary_link_refused"/.test(made), "and noted in the registration's events");
});

Deno.test("the handler: its own code and sentence only for a link that crossed accounts", () => {
  assert(/if \(err instanceof PrimaryProfileLinkError && err\.crossAccount\) \{/.test(CATCH), CATCH);
  assert(/code: "twilio_primary_link_refused", severity: "error"/.test(CATCH));
  assert(/code: "primary_link_refused"/.test(CATCH));
  assert(/filedAtReturnSite\.add\(res\)/.test(CATCH), "filed once, not again by withErrorLog");
});
