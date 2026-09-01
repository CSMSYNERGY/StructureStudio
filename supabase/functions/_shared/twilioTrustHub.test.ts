import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  suggestBrandTier,
  validateIntake,
  normalizeBrandStatus,
  normalizeCampaignStatus,
  validateCampaignCopy,
  JOB_POSITIONS,
  BUSINESS_TYPES,
} from "./twilioTrustHub.ts";

// These tests cover the decisions that cost money when they are wrong: which brand tier a
// builder lands in, and which submissions we refuse locally instead of paying to be told.

const GOOD: Record<string, string> = {
  legalBusinessName: "Junior Barns LLC",
  ein: "12-3456789",
  businessType: "Limited Liability Corporation",
  businessIndustry: "CONSTRUCTION",
  websiteUrl: "https://juniorbarns.example",
  street: "100 Shed Row",
  city: "Austin",
  region: "TX",
  postalCode: "78701",
  isoCountry: "US",
  repFirstName: "Pat",
  repLastName: "Miller",
  repEmail: "pat@juniorbarns.example",
  repPhone: "+15125550123",
  repBusinessTitle: "Owner",
  repJobPosition: "CEO",
};

Deno.test("brand tier is decided by the tax ID, NOT by expected volume", () => {
  // The whole point: Sole Proprietor is an eligibility tier for businesses with no EIN.
  // A small builder WITH an EIN must still be Standard, or Twilio rejects with 30915.
  assertEquals(suggestBrandTier(true), "low_volume_standard");
  assertEquals(suggestBrandTier(false), "sole_proprietor");
});

Deno.test("a clean intake with an EIN passes", () => {
  assertEquals(validateIntake(GOOD, true), []);
});

Deno.test("an LLC claiming sole proprietor is refused BEFORE it costs anything", () => {
  // Twilio error 30915 fires on exactly this, and it is billable to find out. The name
  // carries the evidence, so catch it here.
  const problems = validateIntake({ ...GOOD, ein: "" }, false);
  assert(problems.length > 0);
  assert(problems.some((p) => /sole proprietor/i.test(p) && /EIN/i.test(p)),
    `expected an EIN/sole-proprietor explanation, got: ${JSON.stringify(problems)}`);
});

Deno.test("Inc. and Corp. are caught the same way as LLC", () => {
  for (const name of ["Shed Co Inc.", "Barn Corp", "Barns Incorporated"]) {
    const problems = validateIntake({ ...GOOD, legalBusinessName: name, ein: "" }, false);
    assert(problems.some((p) => /sole proprietor/i.test(p)), `${name} should be refused`);
  }
});

Deno.test("a genuine sole proprietor is refused too — the chain is not built", () => {
  // This test asserted the OPPOSITE until 2026-08-31, and the change is the point: sole
  // proprietor needs a Starter profile, no EIN fields and the mobile on the brand, none of
  // which we send. Letting a clean-looking intake through only meant charging for a
  // rejection. When the second chain IS built, this test flips back — deliberately.
  const problems = validateIntake({ ...GOOD, legalBusinessName: "Pat Miller Sheds", ein: "" }, false);
  assert(problems.some((p) => /EIN/i.test(p)),
    `expected an EIN-only refusal, got: ${JSON.stringify(problems)}`);
});

Deno.test("a free email address is refused — it is a documented rejection cause", () => {
  for (const email of ["pat@gmail.com", "pat@yahoo.com", "pat@outlook.com", "pat@icloud.com"]) {
    const problems = validateIntake({ ...GOOD, repEmail: email }, true);
    assert(problems.some((p) => /company's own domain/i.test(p)), `${email} should be refused`);
  }
});

Deno.test("a company-domain address that merely CONTAINS a free provider name is fine", () => {
  // gmail.co.uk-style false positives would block a legitimate builder, which is worse than
  // the rejection this rule prevents.
  assertEquals(validateIntake({ ...GOOD, repEmail: "pat@gmailsheds.example" }, true), []);
});

Deno.test("a missing or malformed EIN is refused when they said they have one", () => {
  assert(validateIntake({ ...GOOD, ein: "" }, true).some((p) => /EIN/i.test(p)));
  assert(validateIntake({ ...GOOD, ein: "123" }, true).some((p) => /EIN/i.test(p)));
  // Both the hyphenated and bare nine-digit forms are accepted.
  assertEquals(validateIntake({ ...GOOD, ein: "123456789" }, true), []);
});

Deno.test("a Facebook page or bare domain is not a website", () => {
  assert(validateIntake({ ...GOOD, websiteUrl: "" }, true).some((p) => /website/i.test(p)));
  assert(validateIntake({ ...GOOD, websiteUrl: "juniorbarns" }, true).some((p) => /website/i.test(p)));
});

Deno.test("the representative's phone must be a US E.164 number", () => {
  for (const bad of ["5125550123", "+445551234567", "512-555-0123", ""]) {
    assert(validateIntake({ ...GOOD, repPhone: bad }, true).some((p) => /mobile number/i.test(p)),
      `${bad} should be refused`);
  }
});

Deno.test("a missing address component is named specifically", () => {
  const problems = validateIntake({ ...GOOD, city: "" }, true);
  assert(problems.some((p) => /city/i.test(p)), "the builder should be told WHICH field");
});

Deno.test("job position and business type must come from Twilio's own lists", () => {
  assert(validateIntake({ ...GOOD, repJobPosition: "Head Honcho" }, true).length > 0);
  assert(validateIntake({ ...GOOD, businessType: "Sole Trader" }, true).length > 0);
  // And the exported lists are what the UI renders, so they must be non-empty.
  assert(JOB_POSITIONS.length > 0 && BUSINESS_TYPES.length > 0);
});

Deno.test("Event Streams vocabulary is normalised onto the REST vocabulary", () => {
  // The two are DISJOINT. Storing both raw would make one column mean two things depending
  // on which code path wrote it last.
  assertEquals(normalizeBrandStatus("registered"), "APPROVED");
  assertEquals(normalizeBrandStatus("REGISTERED"), "APPROVED");
  assertEquals(normalizeBrandStatus("vetting_failed"), "FAILED");
  // REST values pass through untouched.
  assertEquals(normalizeBrandStatus("APPROVED"), "APPROVED");
  assertEquals(normalizeBrandStatus("IN_REVIEW"), "IN_REVIEW");
  assertEquals(normalizeBrandStatus("SUSPENDED"), "SUSPENDED");
});

Deno.test("an unknown status is preserved rather than silently becoming APPROVED", () => {
  // Twilio adds states. Inventing "approved" for one we do not recognise would switch
  // texting on for a builder the carriers have not cleared.
  assertEquals(normalizeBrandStatus("SOMETHING_NEW"), "SOMETHING_NEW");
  assert(normalizeBrandStatus("") === "PENDING", "an empty status is pending, never approved");
});

Deno.test("campaign VERIFIED means approved; REJECTED means failed", () => {
  assertEquals(normalizeCampaignStatus("VERIFIED"), "APPROVED");
  assertEquals(normalizeCampaignStatus("verified"), "APPROVED");
  assertEquals(normalizeCampaignStatus("REJECTED"), "FAILED");
  assertEquals(normalizeCampaignStatus("IN_PROGRESS"), "PENDING");
  assertEquals(normalizeCampaignStatus(""), "PENDING");
});

Deno.test("Event Streams says success/failure where REST says VERIFIED/REJECTED", () => {
  // ⚠️ REGRESSION GUARD FOR A REAL STALL. TCR rejected the first live campaign and Event
  // Streams delivered `campaignregistrationstatus: "failure"`. That is not "REJECTED", so it
  // fell through to `default`, was stored verbatim as "FAILURE", and never matched the
  // `s === "FAILED"` branch in twilio-events — so the row stayed campaign_pending with
  // needs_attention false, and the builder's screen read "the carriers are reviewing…"
  // indefinitely while the answer had already arrived and been recorded.
  assertEquals(normalizeCampaignStatus("failure"), "FAILED");
  assertEquals(normalizeCampaignStatus("FAILURE"), "FAILED");
  assertEquals(normalizeCampaignStatus("success"), "APPROVED");
  assertEquals(normalizeCampaignStatus("SUCCESS"), "APPROVED");
  // The Event Streams spelling for "still waiting" already matched, and must keep matching.
  assertEquals(normalizeCampaignStatus("pending"), "PENDING");
});

// ── validateCampaignCopy ─────────────────────────────────────────────────────────────────
// Every case below is a shape the FIRST REAL REGISTRATION actually produced or nearly did.
// The submit button was `disabled={busy}` and nothing else, and the server read the copy only
// in a later branch, so a builder submitted with the consent question and both examples left at
// their placeholders while the screen said "Everything is filled in."

const GOOD_COPY = {
  description: "We send our customers a one-time password to access their quotes in our portal.",
  messageFlow: "Customers tick a consent checkbox when they request a quote on our website.",
  messageSamples: [
    "Hi [Name], your Structure Studio code is 123456. Reply STOP to opt out.",
    "Hi [Name], your building is scheduled for delivery on [Date]. Reply STOP to opt out.",
  ],
};

Deno.test("a complete campaign copy passes", () => {
  assertEquals(validateCampaignCopy(GOOD_COPY), []);
});

Deno.test("an EMPTY MessageFlow is refused — it is a documented TCR rejection cause", () => {
  // This is the one the live registration shipped with. The carriers check it against the
  // consent language actually on the website, so blank is a refusal, not an unanswered field.
  const problems = validateCampaignCopy({ ...GOOD_COPY, messageFlow: "" });
  assert(problems.length > 0, "an empty messageFlow must be refused");
  assert(problems.some((p) => /agree to be texted/i.test(p)), "the message must name the field");
});

Deno.test("placeholder-only samples are refused, not counted", () => {
  // The inputs render a placeholder when the value is "", which is exactly how two blank
  // examples looked filled in on screen.
  const problems = validateCampaignCopy({ ...GOOD_COPY, messageSamples: ["", ""] });
  assert(problems.some((p) => /Two example messages are required/i.test(p)));
});

Deno.test("one real sample and one blank is still only one sample", () => {
  const problems = validateCampaignCopy({ ...GOOD_COPY, messageSamples: [GOOD_COPY.messageSamples[0], "  "] });
  assert(problems.some((p) => /Two example messages are required/i.test(p)));
});

Deno.test("samples with no STOP are refused — the most-cited campaign rejection", () => {
  const problems = validateCampaignCopy({
    ...GOOD_COPY,
    messageSamples: [
      "Hi [Name], your quote is ready and waiting in our portal for you.",
      "Hi [Name], your building is scheduled for delivery on [Date] this week.",
    ],
  });
  assert(problems.some((p) => /how to stop/i.test(p)), "at least one sample must carry STOP");
});

Deno.test("a too-short sample is refused", () => {
  const problems = validateCampaignCopy({ ...GOOD_COPY, messageSamples: ["STOP", "ok STOP"] });
  assert(problems.some((p) => /too short/i.test(p)));
});

Deno.test("more than five samples is refused", () => {
  const problems = validateCampaignCopy({ ...GOOD_COPY, messageSamples: Array(6).fill(GOOD_COPY.messageSamples[0]) });
  assert(problems.some((p) => /Five example messages/i.test(p)));
});

Deno.test("a one-word description is refused", () => {
  // "Passwords." is a sentence a builder would genuinely type, and the carriers will not take it.
  assert(validateCampaignCopy({ ...GOOD_COPY, description: "Passwords." }).length > 0);
});

Deno.test("missing fields are refused rather than throwing", () => {
  // The browser can post {} — the brand_approved card did exactly that after a reload.
  const problems = validateCampaignCopy({});
  assert(problems.length >= 3, "description, messageFlow and samples must all complain");
});
