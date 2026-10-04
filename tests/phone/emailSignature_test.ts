// Email signatures (Carolyn 2026-10-01: "be able to set up email signatures in the settings ... if
// I'm sitting here typing a message, I want to see my signature right here"), the wiring half:
//   * save_prefs keeps prefs.emailSignature, cleaned (the whitelist is the only register of what
//     survives a save, so a missing line here is a signature that silently evaporates);
//   * get_profile returns it, for My Synergy Phone's Email box;
//   * crm_send_email signs the email with the SIGNED-IN person's signature (never one from the
//     request), in the text and the HTML, and the ledger's body_text is the signed text;
//   * email_send_test signs the test;
//   * the portal: My Profile saves it, the record's Email tab shows it under the box.
// The rules themselves (cleaning, "-- ", escaping) are unit-tested in
// supabase/functions/_shared/emailSignature.test.ts and emailTemplates.test.ts. This file reads
// the SHIPPED source (slice between stable anchors, fail loudly if they move), the way
// emailConversation_test.ts does.
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/

import { assert } from "jsr:@std/assert@1";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
/** Whole-line `//` comments removed, so a comment that NAMES a field cannot satisfy a check. */
const code = (src: string) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const SETTINGS = code(await read("../../supabase/functions/portal-settings/index.ts"));
const EMAIL_SEND = await read("../../supabase/functions/_shared/emailSend.ts");
const SALES = await read("../../portal/02-sales.jsx");
const INTEG = await read("../../portal/08-integrations.jsx");
const SHELL = await read("../../portal/12-shell.jsx");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`emailSignature_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

Deno.test("portal-settings imports the signature helpers from the shared module", () => {
  assert(SETTINGS.includes(`import { cleanSignature, signatureHtml, signText } from "../_shared/emailSignature.ts";`));
});

Deno.test("save_prefs keeps emailSignature, through cleanSignature, and nothing else of it", () => {
  const save = slice(SETTINGS, `if (action === "save_prefs") {`, `if (action === "save") {`, "save_prefs");
  assert(save.includes("const emailSignature = cleanSignature(raw.emailSignature);"), "the value is cleaned (trimmed, capped, control characters out)");
  assert(save.includes("if (emailSignature) clean.emailSignature = emailSignature;"), "a signature is kept; an empty one drops the key");
  // The write still replaces the whole blob from `clean`, so the key must be set there and only there.
  assert(save.includes(".update({ prefs: Object.keys(clean).length ? clean : null })"), "prefs is still rebuilt from the whitelist");
  assert(!/clean\.emailSignature\s*=\s*raw\./.test(save), "the raw value never reaches the row");
});

Deno.test("get_profile returns the cleaned signature for the app ('' when none)", () => {
  const get = slice(SETTINGS, `if (action === "get_profile") {`, `if (action === "save_profile") {`, "get_profile");
  assert(get.includes(`.select("full_name, phone, role, prefs").eq("user_id", userId)`), "prefs is read off the caller's own row");
  assert(get.includes("emailSignature: cleanSignature((data?.prefs as Record<string, unknown> | null)?.emailSignature) ?? \"\","),
    "the same cleaning the send runs, so the app shows what goes out");
});

Deno.test("crm_send_email signs with the signed-in person's signature, text and HTML, and keeps the signed words", () => {
  const send = slice(SETTINGS, `if (action === "crm_send_email") {`, `if (action === "crm_save_note") {`, "crm_send_email");
  // Read off the JWT's user on THIS tenant, one row. (The reply-to address used to come from the
  // same read; since 2026-10-05 it is _shared/repReplyTo.ts's, which keys on the tenant too.)
  assert(send.includes(`.select("prefs").eq("user_id", userId ?? "").eq("client_id", clientId).limit(1).maybeSingle();`),
    "the prefs read is keyed on the session's user and this tenant");
  assert(send.includes("signature = operator ? null : cleanSignature(prefs?.emailSignature);"),
    "the stored signature is cleaned again on the way out, and none in view-as");
  assert(!/payload\.(signature|emailSignature)/.test(send), "nothing in the request body can choose the signature");
  // Both halves of the email.
  assert(send.includes("${signatureHtml(signature)}`;"), "the HTML half ends with the signature block");
  assert(send.includes("const text = signText(body, signature);"), "the text half is body, \"-- \", signature");
  const call = slice(send, "const out = await sendTenantEmail(admin, clientId, {", "} as any);", "the sendTenantEmail call");
  assert(/\n\s*text,\n/.test(call), "the signed text is what is sent");
  assert(call.includes("bodyText: text,"), "body_text is the full sent text, signature included");
  assert(!call.includes("text: body,"), "the unsigned body is no longer sent as the text");
});

Deno.test("email_send_test signs the test with the sender's signature", () => {
  const test = slice(SETTINGS, `if (action === "email_send_test") {`, `if (action === "email_disconnect") {`, "email_send_test");
  assert(test.includes(`.select("prefs").eq("user_id", userId ?? "").limit(1).maybeSingle();`), "keyed on the session's user");
  assert(test.includes("signature = operator ? null : cleanSignature((pu?.prefs as Record<string, unknown> | null)?.emailSignature);"),
    "cleaned, and none in view-as");
  assert(test.includes("...testEmail({ businessName, fromAddress: `${fromLocal}@${cur.email_domain}`, signature }),"), "testEmail draws it");
});

Deno.test("view-as never signs: the operator's own signature is not the builder's", () => {
  // In view-as the JWT is the operator's, and the keyed read finds THEIR prefs from their own
  // tenant. The composer shows no signature then (emailSignature={viewing ? null : ...}), so the
  // server must add none, or a builder's customer gets CSM Synergy's name under the email.
  const sites = SETTINGS.match(/signature = operator \? null : cleanSignature\(/g) ?? [];
  assert(sites.length === 2, `both signing sites gate on operator (found ${sites.length})`);
  assert(!/\bsignature = cleanSignature\(/.test(SETTINGS), "no ungated signing site is left");
});

Deno.test("sendTenantEmail is unchanged: signing is the caller's job", () => {
  // A signature added there would sign every quote and invoice too, which v1 deliberately doesn't.
  assert(!/emailSignature|signText|signatureHtml/.test(EMAIL_SEND), "emailSend.ts knows nothing about email signatures");
});

Deno.test("portal: My Profile saves emailSignature through save_prefs, capped at 1,000", () => {
  const profile = slice(INTEG, "function MyProfileSettings(", "\n}\n", "MyProfileSettings");
  assert(profile.includes("const back = await commit({ emailSignature: next });"), "saved through the one prefs writer");
  assert(profile.includes("maxLength={1000}"), "the box stops where the server does");
  assert(profile.includes("Your email signature"), "the card is there");
});

Deno.test("portal: the record's Email tab shows the signature under the box, with a way to change it", () => {
  const tab = slice(SALES, `{tab === "email" && canEdit && data.contact && data.contact.email && (`, `onClick={sendEmail}>`, "the Email tab");
  assert(tab.includes(`"Your signature is added: "`), "the preview line");
  assert(tab.includes(`"Edit in My Profile"`) && tab.includes(`"Add one in My Profile"`), "the link to My Profile");
  assert(tab.includes("window.confirm("), "leaving with words in the box asks first");
  const record = slice(SHELL, "<CrmRecord", "/>\n            ) : null}", "the CrmRecord mount");
  assert(record.includes("emailSignature={viewing ? null :"), "the signed-in person's signature, and nothing in view-as");
  assert(record.includes(`onEditProfile={viewing ? null : () => navigate("settings", "myprofile")}`));
});
