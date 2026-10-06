// Settings → Text Messaging fills in wording for a new builder (Carolyn 2026-09-17: "I want it to
// basically prefill for them"), and the example message boxes are several lines (2026-10-05).
//
//   * portal-sms/index.ts: `suggestedCopy` on the status answer, built by the shared
//     suggestedCopyForRow, and the tick-box switch read with the website (read from the SHIPPED
//     source; the template itself is unit-tested in _shared/smsCopyTemplate.test.ts);
//   * portal/11-sms.jsx: smsCopySeed and friends, EVALUATED — what the form holds after each status
//     read, so a builder's typing is never replaced and a suggestion never outlives its facts;
//   * the form's markup: the one-line note, "Start blank", the example boxes as textareas, and the
//     hooks above the early return;
//   * portal/02-sales.jsx: the record page's "how they gave it" note is two lines.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
//
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE. Fixtures are made up ("Acme Sheds", example.test).

import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { suggestedCampaignCopy } from "../../supabase/functions/_shared/smsCopyTemplate.ts";
import { validateCampaignCopy } from "../../supabase/functions/_shared/twilioTrustHub.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SMS_FN = await read("../../supabase/functions/portal-sms/index.ts");
const SMS_TAB = await read("../../portal/11-sms.jsx");
const SALES = await read("../../portal/02-sales.jsx");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`smsCopyPrefill_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

type Copy = { description: string; messageFlow: string; messageSamples: string[] };
type Box = { copy: Copy; suggested: Copy | null; declined: boolean };

// ── the portal's pieces, lifted out of the shipped file and run ─────────────────────────────
const HELPERS = slice(SMS_TAB, "function smsCopyProblems(copy) {", "/** Anything a human typed into a US phone box", "the copy helpers");
const ui = new Function(`${HELPERS}; return { smsCopyProblems, smsCopyBlank, smsCopyFrom, smsCopyEmpty, smsCopySame, smsCopySeed };`)() as {
  smsCopyProblems: (c: unknown) => string[];
  smsCopyBlank: () => Copy;
  smsCopyFrom: (c: unknown) => Copy;
  smsCopyEmpty: (c: unknown) => boolean;
  smsCopySame: (a: unknown, b: unknown) => boolean;
  smsCopySeed: (box: Box, d: unknown, canSuggest: boolean) => Box;
};

const BASE = {
  companyName: "Acme Sheds",
  designerUrl: "https://app.example.test/?client=acme-sheds",
  disclosureUrl: "https://db.example.test/functions/v1/sms-optin-disclosure?client=acme-sheds",
  consentBoxOn: true,
};
// What the server suggests before the details screen is saved, and after (with the policy links).
const SUGGEST_EARLY = suggestedCampaignCopy({ ...BASE })!;
const SUGGEST_LATER = suggestedCampaignCopy({ ...BASE, privacyUrl: "https://acme.example.test/privacy", termsUrl: "https://acme.example.test/terms" })!;
const BLANK_ROW = { description: "", messageFlow: "", messageSamples: ["", ""] };
const SAVED = {
  description: "Acme Sheds texts customers about their quotes and deliveries after they ask for a quote.",
  messageFlow: "Customers tick an unticked, optional box on our quote form to agree to texts.",
  messageSamples: ["Acme Sheds: Hi [Name], your quote is ready. Reply STOP to opt out.", "Acme Sheds: Hi [Name], delivery is [Date]. Reply STOP to opt out."],
};
const status = (o: Record<string, unknown> = {}) => ({ status: "ready", copy: BLANK_ROW, suggestedCopy: SUGGEST_LATER, ...o });
const fresh = (): Box => ({ copy: ui.smsCopyBlank(), suggested: null, declined: false });

Deno.test("a new builder's form is filled in with the suggestion, and says so", () => {
  const b = ui.smsCopySeed(fresh(), status(), true);
  assertEquals(b.copy, SUGGEST_LATER);
  assertEquals(b.suggested, SUGGEST_LATER, "the form knows the wording is ours (the note shows)");
  // The portal's mirror of the submit rules agrees with the server's: Submit is not greyed out.
  assertEquals(ui.smsCopyProblems(b.copy), []);
  assertEquals(validateCampaignCopy(b.copy), []);
});

Deno.test("saved wording always wins: it is loaded, and a suggestion beside it is ignored", () => {
  // The server never sends both; the form does not rely on that.
  const b = ui.smsCopySeed(fresh(), status({ copy: SAVED }), true);
  assertEquals(b.copy, SAVED);
  assertEquals(b.suggested, null, "no 'we filled this in' over the builder's own words");
});

Deno.test("the builder's typing is never replaced — not by saved wording, not by a suggestion", () => {
  const typed: Box = { copy: { ...ui.smsCopyBlank(), description: "W" }, suggested: null, declined: false };
  assertStrictEquals(ui.smsCopySeed(typed, status(), true), typed, "a half-typed form with a suggestion on offer");
  assertStrictEquals(ui.smsCopySeed(typed, status({ copy: SAVED }), true), typed, "a half-typed form with saved wording");
  // Even one space in one example box counts as started.
  const space: Box = { copy: { ...ui.smsCopyBlank(), messageSamples: ["", " "] }, suggested: null, declined: false };
  assertStrictEquals(ui.smsCopySeed(space, status(), true), space);

  // And an edited suggestion is theirs now: a newer suggestion does not replace it.
  const seeded = ui.smsCopySeed(fresh(), status({ suggestedCopy: SUGGEST_EARLY }), true);
  const edited: Box = { ...seeded, copy: { ...seeded.copy, messageSamples: [seeded.copy.messageSamples[0], "Acme Sheds: our own words. Reply STOP to opt out."] } };
  assertStrictEquals(ui.smsCopySeed(edited, status({ suggestedCopy: SUGGEST_LATER }), true), edited);
});

Deno.test("an untouched suggestion follows its facts: the policy links arrive once the details are saved", () => {
  // At 'none' the details are not saved, so there are no policy addresses to name yet.
  const early = ui.smsCopySeed(fresh(), status({ status: "none", suggestedCopy: SUGGEST_EARLY }), true);
  assertEquals(early.copy, SUGGEST_EARLY);
  // Saved details → the next read suggests the wording with both links, and the untouched form takes it.
  const later = ui.smsCopySeed(early, status({ suggestedCopy: SUGGEST_LATER }), true);
  assertEquals(later.copy, SUGGEST_LATER);
  assert(later.copy.messageFlow.includes("https://acme.example.test/privacy"));
  // The same suggestion again changes nothing (no re-render churn on the 60-second poll).
  assertStrictEquals(ui.smsCopySeed(later, status({ suggestedCopy: SUGGEST_LATER }), true), later);
});

Deno.test("an untouched suggestion goes when the server stops standing behind it", () => {
  // The tick box switched off, or the business name cleared: suggestedCopy is null now.
  const seeded = ui.smsCopySeed(fresh(), status(), true);
  const gone = ui.smsCopySeed(seeded, status({ suggestedCopy: null }), true);
  assertEquals(gone.copy, BLANK_ROW);
  assertEquals(gone.suggested, null);
  // But an edited one stays: those are the builder's words now.
  const edited: Box = { ...seeded, copy: { ...seeded.copy, description: seeded.copy.description + " Also repairs." } };
  assertStrictEquals(ui.smsCopySeed(edited, status({ suggestedCopy: null }), true), edited);
});

Deno.test("submitting the suggestion as it stands makes it the builder's: the note goes", () => {
  const seeded = ui.smsCopySeed(fresh(), status(), true);
  // save_copy stored exactly those words; the server now sends them as `copy` and no suggestion.
  const after = ui.smsCopySeed(seeded, status({ status: "profile_pending", copy: seeded.copy, suggestedCopy: null }), true);
  assertEquals(after.copy, SUGGEST_LATER);
  assertEquals(after.suggested, null);
});

Deno.test("'Start blank' sticks while the page is open", () => {
  const declined: Box = { copy: ui.smsCopyBlank(), suggested: null, declined: true };
  const b = ui.smsCopySeed(declined, status(), true);
  assertEquals(b.copy, BLANK_ROW);
  assertEquals(b.suggested, null);
  // Saved wording still loads into an empty form, as it always has.
  assertEquals(ui.smsCopySeed(declined, status({ copy: SAVED }), true).copy, SAVED);
});

Deno.test("someone who cannot edit the form sees what is saved, never our wording", () => {
  const b = ui.smsCopySeed(fresh(), status(), false);
  assertEquals(b.copy, BLANK_ROW);
  assertEquals(b.suggested, null);
  assertEquals(ui.smsCopySeed(fresh(), status({ copy: SAVED }), false).copy, SAVED);
});

Deno.test("an older server (no suggestedCopy) behaves exactly as before", () => {
  const { suggestedCopy: _gone, ...old } = status();
  assertEquals(ui.smsCopySeed(fresh(), old, true).copy, BLANK_ROW);
  assertEquals(ui.smsCopySeed(fresh(), { ...old, copy: SAVED }, true).copy, SAVED);
  // No `copy` at all (an error answer, a cached shape): the form is left alone.
  const box = fresh();
  assertStrictEquals(ui.smsCopySeed(box, { status: "ready" }, true), box);
  assertStrictEquals(ui.smsCopySeed(box, null, true), box);
  // Five saved examples load as five; fewer than two give the form its two boxes.
  const five = { ...SAVED, messageSamples: ["a", "b", "c", "d", "e", "f"] };
  assertEquals(ui.smsCopySeed(fresh(), { ...old, copy: five }, true).copy.messageSamples, ["a", "b", "c", "d", "e"]);
  assertEquals(ui.smsCopyFrom({ messageSamples: ["only one"] }).messageSamples, ["", ""]);
});

// ── portal-sms ───────────────────────────────────────────────────────────────────────────────
Deno.test("portal-sms: suggestedCopy comes from suggestedCopyForRow with the tick-box switch, failing closed", () => {
  assert(SMS_FN.includes('import { suggestedCopyForRow } from "../_shared/smsCopyTemplate.ts";'));
  // The switch rides the website read, and anything but a clean `true` (a failed read) means off.
  assert(/admin\.from\("client_settings"\)\.select\("business_website, lead_sms_consent_box"\)/.test(SMS_FN));
  assert(SMS_FN.includes("const consentBoxOn = csRow?.lead_sms_consent_box === true;"));
  const v = slice(SMS_FN, "const view = (reg: any, numbers: any[]) => ({", "aupAcceptedAt:", "view()");
  assert(/suggestedCopy: suggestedCopyForRow\(reg, \{\n\s+companyName: consentCompanyName,\n\s+consentBoxOn,\n\s+designerUrl: designerUrl\(clientId\),\n\s+disclosureUrl: optInDisclosureUrl\(clientId\),\n\s+\}\),/.test(v), v);
  // The suggestion is never written anywhere: only the builder's own save_copy writes wording.
  assertEquals((SMS_FN.match(/\bsuggestedCopy\b/g) ?? []).length, 1, "the one projection key");
  assertEquals((SMS_FN.match(/\bsuggestedCopyForRow\b/g) ?? []).length, 2, "imported, and called once, in view()");
});

// ── the form ─────────────────────────────────────────────────────────────────────────────────
const FORM = slice(SMS_TAB, "function SmsCopyForm(", "/** Mirrored from validateCampaignCopy", "SmsCopyForm");
const VIEW = slice(SMS_TAB, "function SmsMessagingView(", "\nfunction ", "SmsMessagingView");

Deno.test("the form: the one-line note and 'Start blank', only while the wording is ours", () => {
  assert(FORM.includes("{suggested && ("), "the note is gated on `suggested`");
  assert(/We filled this in with wording carriers have approved before\. Check it describes your\s+business and change anything that doesn&rsquo;t\./.test(FORM));
  assert(/\{!readOnly && onStartBlank && \(/.test(FORM), "no 'Start blank' for someone who cannot edit");
  assert(/data-ss-sms-copy-blank="" onClick=\{onStartBlank\}/.test(FORM));
  // All three places the form is drawn (ready, brand_approved, campaign_failed) pass both.
  const uses = SMS_TAB.match(/<SmsCopyForm [^>]*\/>/g) ?? [];
  assertEquals(uses.length, 3);
  for (const u of uses) assert(/suggested=\{copySuggested\} onStartBlank=\{startBlank\}/.test(u), u);
});

Deno.test("the example messages are several lines, wired as before, with neutral placeholders", () => {
  assert(/<textarea style=\{SMS_TEXTAREA\} rows=\{3\} value=\{sample\} disabled=\{readOnly\} data-ss-sms-sample=\{i\}/.test(FORM));
  assert(!/<input[^>]*value=\{sample\}/.test(FORM), "no one-line example box left");
  assert(/next\[i\] = e\.target\.value;\n\s+setCopy\(\{ \.\.\.copy, messageSamples: next \}\);/.test(FORM), "same onChange wiring");
  // The repo is public: placeholders name no business, only "[Your business]".
  const placeholders = slice(FORM, "placeholder={i === 0", "onChange", "the example placeholders");
  assertEquals((placeholders.match(/"\[Your business\]: Hi \[Name\], /g) ?? []).length, 2, placeholders);
  // With the suggestion in, the disclosure address is already in the answer: the button says so
  // instead of silently doing nothing, and comes back when the answer lacks it.
  assert(/\{String\(copy\.messageFlow \|\| ""\)\.includes\(optInUrl\) \? \(\n\s+<button type="button" disabled data-ss-sms-optin-link="present"/.test(FORM));
  assert(/Already in your answer &#10003;/.test(FORM) && /data-ss-sms-optin-link="add"/.test(FORM));
  // The other three answers kept their multi-line boxes.
  assertEquals((FORM.match(/<textarea style=\{SMS_TEXTAREA\}/g) ?? []).length, 3);
});

Deno.test("the view: one copy state with its suggestion flag, every hook above the early return", () => {
  const early = VIEW.indexOf("if (!data) return <SkelRows");
  assert(early > 0);
  for (const hook of [
    "const [copyBox, setCopyBox] = useState(",
    "const setCopy = useCallback(",
    "const refresh = useCallback(",
  ]) {
    const at = VIEW.indexOf(hook);
    assert(at > 0 && at < early, `${hook} sits above the early return`);
  }
  assert(VIEW.includes("setCopyBox((b) => smsCopySeed(b, d, !!canEdit));"), "refresh seeds through smsCopySeed");
  assert(/\}, \[call, clientId, canEdit\]\);/.test(VIEW), "refresh re-reads when canEdit changes");
  // Start blank asks before throwing away an edited suggestion, and remembers the choice.
  const sb = slice(VIEW, "const startBlank = () => {", "};", "startBlank");
  assert(/window\.confirm\(/.test(sb) && sb.includes("declined: true"), sb);
});

// ── the record page ──────────────────────────────────────────────────────────────────────────
Deno.test("the record page's 'how they gave it' note is two lines and still capped at 200", () => {
  const note = slice(SALES, "<textarea value={consentNote}", "/>", "the consent note");
  assert(/rows=\{2\} maxLength=\{200\}/.test(note), note);
  assert(!/<input value=\{consentNote\}/.test(SALES), "no one-line note left");
});
