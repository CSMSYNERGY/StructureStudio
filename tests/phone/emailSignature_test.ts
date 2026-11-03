// Email signatures (Carolyn 2026-10-01: "be able to set up email signatures in the settings ... if
// I'm sitting here typing a message, I want to see my signature right here"), the wiring half:
//   * save_prefs keeps prefs.emailSignature, cleaned (the whitelist is the only register of what
//     survives a save, so a missing line here is a signature that silently evaporates);
//   * get_profile returns it, for My Synergy Phone's Email box;
//   * crm_send_email signs the email with the SIGNED-IN person's signature (never one from the
//     request), in the text and the HTML, and the ledger's body_text is the signed text;
//   * email_send_test signs the test;
//   * the portal: My Profile saves it, the record's Email tab shows it under the box.
//
// RICH SINCE 2026-11-01. A signature may now be HTML (a headshot, fonts, links, a rule, a grey
// disclaimer), held to its OWN sanitiser, _shared/emailSignatureHtml.ts. TWO prefs keys --
// `emailSignature` (the words, always) and `emailSignatureHtml` (the rich one) -- never one key
// with a marker or a sniff, because "Jane <jane@acme.com>" is a real plain-text signature that no
// heuristic may mangle. signaturePair owns the precedence rule, and the checks below are written
// against it. The invariants that must NOT move: nothing in the request body can choose a
// signature, and view-as still signs nothing.
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
  assert(SETTINGS.includes(`import { cleanSignature, signatureHtml, signText, signaturePair, signatureImageOrigin } from "../_shared/emailSignature.ts";`));
  assert(SETTINGS.includes(`} from "../_shared/emailSignatureHtml.ts";`), "the rich signature's own sanitiser is imported");
});

Deno.test("save_prefs keeps emailSignature, through cleanSignature, and nothing else of it", () => {
  const save = slice(SETTINGS, `if (action === "save_prefs") {`, `if (action === "save") {`, "save_prefs");
  assert(save.includes("const emailSignature = cleanSignature(raw.emailSignature);"), "the value is cleaned (trimmed, capped, control characters out)");
  assert(save.includes("if (emailSignature) clean.emailSignature = emailSignature;"), "a signature is kept; an empty one drops the key");
  // The rich half, and the twin DERIVED FROM IT SERVER-SIDE. The browser is not the authority on
  // what survived the sanitiser, so a browser-computed twin would drift from the stored HTML.
  assert(save.includes("const sigHtml = cleanSignatureHtml(raw.emailSignatureHtml, signatureImageOrigin());"), "the rich value goes through its own cleaner");
  assert(save.includes("clean.emailSignatureHtml = sigHtml;"), "the cleaned rich value is what is kept");
  assert(save.includes("const twin = cleanSignature(signatureHtmlToText(sigHtml));"), "the plain twin is derived from the HTML the server kept");
  assert(!/clean\.emailSignatureHtml\s*=\s*raw\./.test(save), "the raw rich value never reaches the row");
  // The write still replaces the whole blob from `clean`, so the key must be set there and only there.
  assert(save.includes(".update({ prefs: Object.keys(clean).length ? clean : null })"), "prefs is still rebuilt from the whitelist");
  assert(!/clean\.emailSignature\s*=\s*raw\./.test(save), "the raw value never reaches the row");
});

Deno.test("get_profile returns the cleaned signature for the app ('' when none)", () => {
  const get = slice(SETTINGS, `if (action === "get_profile") {`, `if (action === "save_profile") {`, "get_profile");
  // selfUserId since 2026-10-23, and the change of identifier is the point: "the caller's own row"
  // became ambiguous the day an operator could act as a named person. My Profile is about the person
  // whose screen it is, so acting as a rep shows the REP'S signature — not the operator's filed under
  // their name. (crm_send_email below still signs with `userId`: that is who is actually sending.)
  assert(get.includes(`.select("full_name, phone, role, prefs").eq("user_id", selfUserId)`), "prefs is read off the row of the person this screen is about");
  // `emailSignature` KEEPS ITS v1 MEANING AND VALUE here: My Synergy Phone reads this and is not
  // deployed by this change, so it must keep seeing words.
  assert(get.includes("emailSignature: signaturePair(data?.prefs).text ?? \"\","),
    "the same rule the send runs, so the app shows what goes out");
  assert(get.includes("emailSignatureHtml: signaturePair(data?.prefs).html ?? \"\","), "the rich one too, '' when there is none");
});

Deno.test("crm_send_email signs with the signed-in person's signature, text and HTML, and keeps the signed words", () => {
  const send = slice(SETTINGS, `if (action === "crm_send_email") {`, `if (action === "crm_save_note") {`, "crm_send_email");
  // Read off the JWT's user on THIS tenant, one row. (The reply-to address used to come from the
  // same read; since 2026-10-05 it is _shared/repReplyTo.ts's, which keys on the tenant too.)
  assert(send.includes(`.select("prefs").eq("user_id", userId ?? "").eq("client_id", clientId).limit(1).maybeSingle();`),
    "the prefs read is keyed on the session's user and this tenant");
  assert(send.includes("sig = operator ? { text: null, html: null } : signaturePair(pu?.prefs);"),
    "the stored signature is cleaned again on the way out, and none in view-as");
  assert(!/payload\.(signature|emailSignature|emailSignatureHtml)/.test(send), "nothing in the request body can choose the signature");
  // Both halves of the email, both shapes.
  assert(send.includes("${signatureHtml(sig.text, sig.html)}`;"), "the HTML half ends with the signature block");
  assert(send.includes("const text = signText(body, sig.text, sig.html);"), "the text half is body, \"-- \", the signature's WORDS");
  const call = slice(send, "const out = await sendTenantEmail(admin, clientId, {", "} as any);", "the sendTenantEmail call");
  assert(/\n\s*text,\n/.test(call), "the signed text is what is sent");
  assert(call.includes("bodyText: text,"), "body_text is the full sent text, signature included");
  assert(!call.includes("text: body,"), "the unsigned body is no longer sent as the text");
});

Deno.test("email_send_test signs the test with the sender's signature", () => {
  const test = slice(SETTINGS, `if (action === "email_send_test") {`, `if (action === "email_disconnect") {`, "email_send_test");
  assert(test.includes(`.select("prefs").eq("user_id", userId ?? "").limit(1).maybeSingle();`), "keyed on the session's user");
  assert(test.includes("sig = operator ? { text: null, html: null } : signaturePair(pu?.prefs);"),
    "cleaned, and none in view-as");
  // The BLOCK is rendered here and handed over as a finished string. emailTemplates.ts is bundled
  // into four functions, so importing the signature cleaner there would quadruple the deploy set.
  assert(test.includes("const signatureBlockHtml = signatureHtml(sig.text, sig.html);"), "the block is rendered by the caller");
  assert(test.includes("...testEmail({ businessName, fromAddress: `${fromLocal}@${cur.email_domain}`, signature: sig.text, signatureBlockHtml }),"), "testEmail draws it");
});

Deno.test("view-as never signs: the operator's own signature is not the builder's", () => {
  // In view-as the JWT is the operator's, and the keyed read finds THEIR prefs from their own
  // tenant. The composer shows no signature then (emailSignature={viewing ? null : ...}), so the
  // server must add none, or a builder's customer gets CSM Synergy's name under the email.
  const sites = SETTINGS.match(/sig = operator \? \{ text: null, html: null \} : signaturePair\(/g) ?? [];
  assert(sites.length === 2, `both signing sites gate on operator (found ${sites.length})`);
  assert(!/\bsig = signaturePair\(/.test(SETTINGS), "no ungated signing site is left");
  // And the upload an operator must not be able to make into a builder's bucket.
  assert(SETTINGS.includes(`if (action === "signature_upload_url") {`), "the self-gated upload exists");
  assert(/signature_upload_url"\) \{[\s\S]{0,400}?if \(operator\) return json\(/.test(SETTINGS), "and it refuses an operator in view-as");
});

Deno.test("sendTenantEmail is unchanged: signing is the caller's job", () => {
  // A signature added there would sign every quote and invoice too, which v1 deliberately doesn't.
  assert(!/emailSignature|signText|signatureHtml|signaturePair|cleanSignatureHtml/.test(EMAIL_SEND), "emailSend.ts knows nothing about email signatures");
});

Deno.test("portal: My Profile saves emailSignature through save_prefs, capped at 1,000", () => {
  const profile = slice(INTEG, "function MyProfileSettings(", "\n}\n", "MyProfileSettings");
  // BOTH KEYS ON EVERY SAVE. mergePrefs carries back any key a save does not name, so naming only
  // one would leave the other shape of the old signature still going out.
  assert(profile.includes(`const back = await commit({ emailSignatureHtml: send, emailSignature: "" });`), "saved through the one prefs writer, naming both keys");
  assert(profile.includes("<SsSigEditor"), "the rich editor, not a textarea");
  assert(!profile.includes("maxLength={1000}"), "the old plain-text box is gone");
  assert(profile.includes("Your email signature"), "the card is there");
  // The preview is an iframe. An innerHTML here would be a stored-XSS primitive one sanitiser bug
  // away from live.
  assert(!/dangerouslySetInnerHTML\s*=/.test(INTEG), "no innerHTML anywhere in this part");
  assert(/function SsSigPreview[\s\S]{0,800}sandbox=""/.test(INTEG), "the preview frame is sandboxed");
});

Deno.test("portal: the record's Email tab shows the signature under the box, with a way to change it", () => {
  const tab = slice(SALES, `{tab === "email" && tabOn("email") && canEdit && data.contact && data.contact.email && (`, `onClick={sendEmail}>`, "the Email tab");
  assert(tab.includes(`"Your signature is added: "`), "the plain preview line");
  assert(tab.includes(`"Your signature is added."`), "and the rich one, which cannot be flattened onto a line");
  assert(tab.includes("<SsSigPreview"), "a rich signature gets a rendered preview");
  assert(!/dangerouslySetInnerHTML\s*=/.test(SALES), "no innerHTML in the record either");
  assert(tab.includes(`"Edit in My Profile"`) && tab.includes(`"Add one in My Profile"`), "the link to My Profile");
  assert(tab.includes("window.confirm("), "leaving with words in the box asks first");
  const record = slice(SHELL, "<CrmRecord", "/>\n            ) : null}", "the CrmRecord mount");
  assert(record.includes("emailSignature={viewing ? null :"), "the signed-in person's signature, and nothing in view-as");
  assert(record.includes("emailSignatureHtml={viewing ? null :"), "the rich one carries the same guard");
  assert(record.includes(`onEditProfile={viewing ? null : () => navigate("settings", "myprofile")}`));
});
