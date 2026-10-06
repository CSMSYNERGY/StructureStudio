/**
 * Unit tests for the suggested texting-registration wording (smsCopyTemplate.ts).
 *
 * What has to hold, and why each one matters:
 *  - the suggestion passes the SAME rules a submit is held to (validateCampaignCopy), so a builder
 *    who accepts it as it stands is never refused by our own server;
 *  - the opt-in answer quotes the designer's tick-box sentence byte for byte — a carrier reviewer
 *    compares the two, and a paraphrase is a misrepresentation;
 *  - every example names the business and says how to stop, which is what the self-check's
 *    "Example messages say who they are from" row looks for;
 *  - it is offered only when it is true: no name, or the box switched off, means nothing;
 *  - no business name is baked into the template (the repo is public, and a baked-in name would
 *    put one builder's name in every other builder's registration).
 *
 * Run: deno test --allow-env --allow-read --node-modules-dir=none supabase/functions/_shared/smsCopyTemplate.test.ts
 * (the pre-push gate discovers _shared/*.test.ts automatically — see scripts/preflight.mjs)
 *
 * Fixtures are made up ("Acme Sheds", example.test addresses).
 */

import { campaignCopyIsEmpty, suggestedCampaignCopy, suggestedCopyForRow, type SuggestedCopyInput } from "./smsCopyTemplate.ts";
import { smsConsentSentence } from "./smsConsentText.ts";
import { validateCampaignCopy } from "./twilioTrustHub.ts";
import { consistencyChecks } from "./smsComplianceCheck.ts";

// Local assertions rather than jsr:@std/assert, like the other _shared tests: the gate runs this
// file with no network and no import map.
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}${msg ? ` — ${msg}` : ""}`);
}

const DESIGNER = "https://app.example.test/?client=acme-sheds";
const DISCLOSURE = "https://db.example.test/functions/v1/sms-optin-disclosure?client=acme-sheds";
const PRIVACY = "https://acme.example.test/privacy";
const TERMS = "https://acme.example.test/terms";

const input = (over: Partial<SuggestedCopyInput> = {}): SuggestedCopyInput => ({
  companyName: "Acme Sheds",
  designerUrl: DESIGNER,
  disclosureUrl: DISCLOSURE,
  privacyUrl: PRIVACY,
  termsUrl: TERMS,
  consentBoxOn: true,
  ...over,
});

const NAMES = ["Acme Sheds", "Bluebird Barn Co.", "O'Neil & Sons Portable Buildings", "Zed"];

Deno.test("the suggestion passes the same rules a submit is held to", () => {
  for (const name of NAMES) {
    const s = suggestedCampaignCopy(input({ companyName: name }));
    assert(s, `a suggestion for ${name}`);
    assertEquals(validateCampaignCopy(s!), [], `validateCampaignCopy for ${name}`);
  }
  // And with neither policy address (a builder who has not saved them yet).
  const bare = suggestedCampaignCopy(input({ privacyUrl: "", termsUrl: null }));
  assertEquals(validateCampaignCopy(bare!), [], "validateCampaignCopy without policy addresses");
});

Deno.test("the opt-in answer quotes the designer's tick-box sentence word for word", () => {
  for (const name of NAMES) {
    const s = suggestedCampaignCopy(input({ companyName: name }))!;
    const sentence = smsConsentSentence(name);
    assert(s.messageFlow.includes(`"${sentence}"`), `the quoted sentence for ${name}: ${s.messageFlow}`);
    assert(!/this builder/.test(s.messageFlow), "never the 'this builder' fallback");
  }
  // A name with stray spaces is trimmed the way the disclosure page trims it, so the quote is
  // still the sentence the customer saw.
  const padded = suggestedCampaignCopy(input({ companyName: "  Acme Sheds \n" }))!;
  assertEquals(padded, suggestedCampaignCopy(input())!, "a padded name gives the same wording");
});

Deno.test("the opt-in answer points at the designer, the disclosure page and both policies", () => {
  const s = suggestedCampaignCopy(input())!;
  for (const u of [DESIGNER, DISCLOSURE, PRIVACY, TERMS]) {
    assert(s.messageFlow.includes(u), `the opt-in answer names ${u}`);
  }
  assert(s.description.includes(DESIGNER), "the description names the designer");
  // Only what is true of EVERY text: one a person types goes out as typed, with no business name
  // and no STOP line, so the description must not promise either; a STOP reply does end them.
  assert(!/every message/i.test(s.description) && !/names Acme Sheds/.test(s.description), "no promise about what every text says");
  assert(/reply STOP to any message/.test(s.description), "says a STOP reply ends them");
  assert(/not ticked for them/.test(s.messageFlow) && /not required/.test(s.messageFlow), "unticked and optional");
  assert(/stored with the customer's record/.test(s.messageFlow), "says where each tick is kept");
});

Deno.test("each policy address is named only when there is one", () => {
  const privacyOnly = suggestedCampaignCopy(input({ termsUrl: "" }))!.messageFlow;
  assert(privacyOnly.includes(PRIVACY) && !/Terms \(/.test(privacyOnly), privacyOnly);
  assert(privacyOnly.includes("with a link to our Privacy Policy"), privacyOnly);

  const termsOnly = suggestedCampaignCopy(input({ privacyUrl: null }))!.messageFlow;
  assert(termsOnly.includes(TERMS) && !/Privacy Policy/.test(termsOnly), termsOnly);

  const neither = suggestedCampaignCopy(input({ privacyUrl: "", termsUrl: "" }))!.messageFlow;
  assert(!/Privacy Policy|Terms \(/.test(neither), neither);
  assert(neither.includes(`The same wording is published at ${DISCLOSURE}.`), neither);

  // Not a web address is the same as none: "acme.example.test/privacy" with no scheme is what a
  // half-finished details screen holds, and a reviewer cannot open it.
  const loose = suggestedCampaignCopy(input({ privacyUrl: "acme.example.test/privacy", termsUrl: "  " }))!.messageFlow;
  assertEquals(loose, neither, "an address with no https:// is left out");
});

Deno.test("every example starts with the business name, uses [Name] and says how to stop", () => {
  for (const name of NAMES) {
    const s = suggestedCampaignCopy(input({ companyName: name }))!;
    assertEquals(s.messageSamples.length, 2, "two examples");
    for (const m of s.messageSamples) {
      assert(m.startsWith(`${name}: `), `starts with the name: ${m}`);
      assert(/\bSTOP\b/.test(m), `says how to stop: ${m}`);
      assert(m.includes("[Name]"), `writes [Name], never a customer: ${m}`);
    }
  }
});

Deno.test("the self-check passes the examples: they name the business and carry no link", () => {
  for (const name of NAMES) {
    const s = suggestedCampaignCopy(input({ companyName: name }))!;
    const rows = consistencyChecks({
      websiteUrl: "https://acme.example.test", privacyPolicyUrl: PRIVACY, termsUrl: TERMS,
      settingsWebsite: "https://acme.example.test", legalBusinessName: `${name} LLC`,
      consentCompanyName: name, messageSamples: s.messageSamples, hasEmbeddedLinks: false,
    });
    const verdict = (key: string) => rows.find((r) => r.key === key)?.verdict;
    assertEquals(verdict("match.samples.name"), "pass", `match.samples.name for ${name}`);
    assertEquals(verdict("match.samples.links"), "pass", `match.samples.links for ${name}`);
  }
});

Deno.test("nothing is suggested when it would not be true", () => {
  // No name: the box would read "this builder", which reads as a refusal.
  for (const companyName of ["", "   ", null as unknown as string, undefined as unknown as string]) {
    assertEquals(suggestedCampaignCopy(input({ companyName })), null, `name ${JSON.stringify(companyName)}`);
  }
  // The box switched off (migration 242), or a switch we could not read: no box, no "tick the box".
  for (const consentBoxOn of [false, undefined, null, "true", 1] as unknown[]) {
    assertEquals(suggestedCampaignCopy(input({ consentBoxOn: consentBoxOn as boolean })), null, `box ${JSON.stringify(consentBoxOn)}`);
  }
  // No page to point at: a disclosure address built with no SUPABASE_URL is a bare path.
  assertEquals(suggestedCampaignCopy(input({ disclosureUrl: "/functions/v1/sms-optin-disclosure?client=x" })), null, "bare disclosure path");
  assertEquals(suggestedCampaignCopy(input({ designerUrl: "" })), null, "no designer address");
  assertEquals(suggestedCampaignCopy(null as unknown as SuggestedCopyInput), null, "no input at all");
});

Deno.test("no business name is baked into the template", () => {
  // Swap the inputs for markers: if the template carried a name of its own, two different
  // businesses would leave different text behind.
  const shape = (name: string, slug: string) => {
    const s = suggestedCampaignCopy(input({
      companyName: name,
      designerUrl: `https://app.example.test/?client=${slug}`,
      disclosureUrl: `https://db.example.test/d?client=${slug}`,
      privacyUrl: `https://${slug}.example.test/privacy`,
      termsUrl: `https://${slug}.example.test/terms`,
    }))!;
    return JSON.stringify(s)
      .replaceAll(name, "<CO>")
      .replaceAll(/https:\/\/[^\s)"\\]+/g, "<URL>");
  };
  const a = shape("Acme Sheds", "acme-sheds");
  assertEquals(a, shape("Bluebird Barn Co.", "bluebird"), "two businesses, one template");

  // And what is left is plain words: every capitalised word is one of these, so no trading name
  // can hide in the fixed text. A new word here is a conscious edit, not an accident.
  const allowed = new Set([
    "By", "Customers", "Date", "Each", "HELP", "Hi", "It", "Message", "Messages", "Name",
    "Building", "Policy", "Privacy", "Reply", "STOP", "Terms", "The", "CO", "URL",
  ]);
  const words = a.match(/\b[A-Z][A-Za-z]*\b/g) ?? [];
  const stray = [...new Set(words.filter((w) => !allowed.has(w)))];
  assertEquals(stray, [], "capitalised words outside the template's own vocabulary");
});

Deno.test("the sentence is imported, never retyped, and the module stays a leaf", async () => {
  const src = await Deno.readTextFile(new URL("./smsCopyTemplate.ts", import.meta.url));
  assert(/import \{ smsConsentSentence \} from "\.\/smsConsentText\.ts";/.test(src), "imports smsConsentSentence");
  assert(!src.includes("may send you text messages about"), "the tick-box sentence is not retyped here");
  assert(!/from\s+"(?:jsr|npm|https?):/.test(src), "no jsr:, npm: or URL imports");
  assert(!/Deno\.env|fetch\(/.test(src), "no environment or network");
});

Deno.test("suggestedCopyForRow: offered only for a row with no wording, with the row's own policy addresses", () => {
  const ctx = { companyName: "Acme Sheds", consentBoxOn: true, designerUrl: DESIGNER, disclosureUrl: DISCLOSURE };
  // A builder at 'none': no row wording, no policy addresses yet.
  const fresh = suggestedCopyForRow({ campaign_message_samples: [] }, ctx)!;
  assertEquals(fresh, suggestedCampaignCopy(input({ privacyUrl: "", termsUrl: "" })), "nothing saved yet");
  // After the details screen is saved, the same row carries both addresses, and so does the answer.
  const saved = suggestedCopyForRow({ campaign_message_samples: [], privacy_policy_url: PRIVACY, terms_url: TERMS }, ctx)!;
  assertEquals(saved, suggestedCampaignCopy(input()), "with the saved policy addresses");
  // A first read creates the row, so it can even be missing.
  assertEquals(suggestedCopyForRow(null, ctx), suggestedCampaignCopy(input({ privacyUrl: "", termsUrl: "" })), "no row yet");
  // ⚠️ Anything saved means no suggestion at all — not even beside it.
  assertEquals(suggestedCopyForRow({ campaign_description: "We text about quotes and deliveries for our sheds." }, ctx), null, "description saved");
  assertEquals(suggestedCopyForRow({ campaign_message_samples: ["Acme Sheds: hi [Name]. Reply STOP to opt out.", ""] }, ctx), null, "one example saved");
  // And the "would it be true" rules still apply on top.
  assertEquals(suggestedCopyForRow({}, { ...ctx, consentBoxOn: false }), null, "box off");
  assertEquals(suggestedCopyForRow({}, { ...ctx, companyName: "" }), null, "no name");
});

Deno.test("campaignCopyIsEmpty: only a row with no wording at all", () => {
  assert(campaignCopyIsEmpty(null), "no row");
  assert(campaignCopyIsEmpty(undefined), "undefined row");
  assert(campaignCopyIsEmpty({}), "no columns");
  assert(campaignCopyIsEmpty({ campaign_description: null, campaign_message_flow: null, campaign_message_samples: [] }), "nulls and []");
  assert(campaignCopyIsEmpty({ campaign_description: "  ", campaign_message_flow: "\n", campaign_message_samples: ["", "  "] }), "whitespace only");
  assert(campaignCopyIsEmpty({ campaign_message_samples: "not an array" }), "a malformed samples column");
  assert(!campaignCopyIsEmpty({ campaign_description: "We text our customers." }), "a description alone");
  assert(!campaignCopyIsEmpty({ campaign_message_flow: "They tick a box." }), "an opt-in answer alone");
  assert(!campaignCopyIsEmpty({ campaign_message_samples: ["", "Acme Sheds: hello. Reply STOP to opt out."] }), "one example alone");
});
