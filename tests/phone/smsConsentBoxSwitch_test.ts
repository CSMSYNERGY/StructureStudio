// The texting-consent box switch (Carolyn 2026-11-01). client_settings.lead_sms_consent_box
// (migration 242) had no screen: the form designer told builders it was "switched off in
// Settings" and there was nothing in Settings to find. portal-sms now reads it into `status` and
// writes it with `save_consent_box`, on Customer Hub → Text Messaging.
//
// Pinned against the shipped source, the way smsCopyPrefill_test.ts pins its neighbours, because
// this file's GATES table is NOT cross-checked by preflight (it dispatches with `switch`), so a
// missing gate line is a runtime 403 with no push-time warning.
import { assert } from "jsr:@std/assert@1";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SMS_FN = await read("../../supabase/functions/portal-sms/index.ts");
const UI = await read("../../portal/11-sms.jsx");
const FORMS = await read("../../portal/08-integrations.jsx");

Deno.test("save_consent_box is gated at save_copy's bar and has a branch", () => {
  assert(/\n\s+save_consent_box:\s*\{ area: "settings_billing", level: "edit" \},/.test(SMS_FN));
  assert(SMS_FN.includes('case "save_consent_box": {'));
});

Deno.test("the switch refuses anything but a boolean, and creates a row only to turn the box off", () => {
  const i = SMS_FN.indexOf('case "save_consent_box": {');
  const body = SMS_FN.slice(i, SMS_FN.indexOf("case \"accept_aup\"", i));
  assert(body.includes('if (typeof p.on !== "boolean")'));
  assert(body.includes('.update({ lead_sms_consent_box: on, updated_at: now })'));
  assert(/=== 0 && !on\)/.test(body), "insert only when turning off");
  assert(body.includes("ramp_enabled: false"), "a created row must not switch ramps on");
});

Deno.test("status reports what the designer shows: a missing row reads as on", () => {
  assert(SMS_FN.includes("const consentBoxShown = csRow?.lead_sms_consent_box !== false;"));
  assert(SMS_FN.includes("consentBox: consentBoxShown,"));
});

Deno.test("Text Messaging draws the switch and the form designer stops pointing at nothing", () => {
  assert(UI.includes('call("save_consent_box", { on })'));
  assert(!FORMS.includes("switched off in Settings"), "the old note named a setting that did not exist");
  assert(FORMS.includes("Turn it on in Customer Hub → SMS - A2P"));
});
