// The Sole Proprietor chain (a builder with NO EIN), 2026-10-27, pinned against a stubbed Twilio.
//
// Ahsan's rule for this build: spend nothing. No real registration, no mock brand, no `--real`
// spike, so these stubs are the only proof the chain sends what Twilio's ISV sole-prop guide
// (https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api-sole-prop-new)
// asks for. What is pinned:
//   * createStarterCustomerProfile: the exact request chain in a SUB-account (URLs in order, the
//     EndUser Type and its four Attribute keys, the Address, the supporting document, the Starter
//     PolicySid on the profile AND its Evaluation, the builder's own email, the parent's PRIMARY
//     linked across accounts, then pending-review), every request on the sub's own pair, and no
//     EIN-tier field anywhere; a refused primary link is a PrimaryProfileLinkError (profileKind
//     "starter") with nothing evaluated or submitted after it;
//   * createSoleProprietorTrustProduct: the sole_proprietor_information EndUser (brand_name = the
//     person, their mobile, CONSTRUCTION), the sole-prop PolicySid on the product and its
//     Evaluation, the STARTER profile assigned onto it, pending-review;
//   * resendBrandOtp: POST …/BrandRegistrations/{BN}/SmsOtp with no body, on the sub's pair;
//   * finishSecondaryCustomerProfile resumes a half-made Starter profile against the STARTER policy;
//   * brandReadyForCampaign's truth table and soleProprietorBrandName.
// Malformed inputs are refused before any request (every object Twilio makes lingers on the
// account). Every SID, key, name, number and address is made up (the repo is public).
// call() keeps its one-request-per-second throttle, so this file takes ~25 seconds on purpose.
// Run: deno test --node-modules-dir=none --import-map=supabase/functions/_shared/_test_stubs/import_map.json -A supabase/functions/_shared/twilioTrustHubSoleProp.test.ts

import {
  brandReadyForCampaign, createSoleProprietorTrustProduct, createStarterCustomerProfile, finishSecondaryCustomerProfile,
  POLICY_A2P_TRUST_PRODUCT, POLICY_SECONDARY_CUSTOMER_PROFILE, POLICY_SOLE_PROP_TRUST_PRODUCT, POLICY_STARTER_CUSTOMER_PROFILE,
  PRIMARY_LINK_REFUSED, PrimaryProfileLinkError, resendBrandOtp, SOLE_PROP_OTP_SENDER, soleProprietorBrandName,
  TrustHubError, type BuilderIntake, type TrustHubCreds, type TrustHubHttp,
} from "./twilioTrustHub.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

const PARENT = "AC" + "0".repeat(32);
const SUB: TrustHubCreds = { accountSid: "AC" + "5".repeat(32), user: "SK" + "5".repeat(32), pass: "subkeysecret" + "x".repeat(20) };
const PRIMARY = "BU" + "0".repeat(32);
const STARTER = "BU" + "5".repeat(32);
const SOLE_TP = "BU" + "6".repeat(32);
const PERSON = "IT" + "1".repeat(32);
const SOLE_INFO = "IT" + "2".repeat(32);
const ADDRESS = "AD" + "1".repeat(32);
const DOC = "RD" + "1".repeat(32);
const BRAND = "BN" + "5".repeat(32);
const TH = "https://trusthub.twilio.com/v1";
const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;

// A sole proprietor as the portal posts one. The job fields are left at the form's defaults on
// purpose: they must not reach Twilio for this tier.
const INTAKE: BuilderIntake = {
  legalBusinessName: "Pat Example", businessIndustry: "CONSTRUCTION", websiteUrl: "",
  street: "PO Box 100", city: "Testville", region: "MO", postalCode: "64101", isoCountry: "us",
  repFirstName: "  Pat ", repLastName: "Example", repEmail: "pat@example.test", repPhone: "+15555550123",
  repBusinessTitle: "Owner", repJobPosition: "CEO",
};

type Seen = { method: string; url: string; auth: string | null; contentType: string | null; body: string; form: URLSearchParams };

/** Swap globalThis.fetch for a recorder that answers like Twilio. `refusePrimary` answers the
 *  parent's primary assignment with a 403; `refuseAt` answers that request (1 = the first) with a 400
 *  (to stop a chain after one recorded request). */
async function withTwilio(opts: { refusePrimary?: boolean; refuseAt?: number }, fn: (seen: Seen[]) => Promise<void>) {
  const saved = Deno.env.get("TWILIO_ACCOUNT_SID");
  Deno.env.set("TWILIO_ACCOUNT_SID", PARENT);
  const seen: Seen[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init?.headers);
    const body = init?.body == null ? "" : String(init.body);
    seen.push({ method: String(init?.method ?? "GET").toUpperCase(), url, auth: h.get("authorization"), contentType: h.get("content-type"), body, form: new URLSearchParams(body) });
    const json = (b: unknown, status = 201) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (opts.refuseAt && seen.length === opts.refuseAt) return json({ code: 70002, message: "echoes what was sent" }, 400);
    if (url.endsWith("/EndUsers")) {
      const type = new URLSearchParams(body).get("Type");
      return json({ sid: type === "starter_customer_profile_information" ? PERSON : type === "sole_proprietor_information" ? SOLE_INFO : "IT" + "9".repeat(32) });
    }
    if (url.endsWith("/Addresses.json")) return json({ sid: ADDRESS });
    if (url.endsWith("/SupportingDocuments")) return json({ sid: DOC });
    if (url.endsWith("/CustomerProfiles")) return json({ sid: STARTER, status: "draft" });
    if (url.endsWith("/TrustProducts")) return json({ sid: SOLE_TP, status: "draft" });
    if (url.endsWith("/EntityAssignments")) {
      return opts.refusePrimary && new URLSearchParams(body).get("ObjectSid") === PRIMARY
        ? json({ code: 20403, message: "echoes what was sent" }, 403)
        : json({ sid: "BV" + "1".repeat(32) });
    }
    if (url.endsWith("/Evaluations")) return json({ sid: "EL" + "1".repeat(32), status: "compliant" });
    if (url.endsWith(`/CustomerProfiles/${STARTER}`)) return json({ sid: STARTER, status: "pending-review" }, 200);
    if (url.endsWith(`/TrustProducts/${SOLE_TP}`)) return json({ sid: SOLE_TP, status: "pending-review" }, 200);
    if (url.endsWith("/SmsOtp")) return json({ account_sid: SUB.accountSid, brand_registration_sid: BRAND });
    return json({ message: `unexpected ${url}` }, 500);
  }) as typeof fetch;
  try {
    await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
    saved === undefined ? Deno.env.delete("TWILIO_ACCOUNT_SID") : Deno.env.set("TWILIO_ACCOUNT_SID", saved);
  }
}

const attrs = (s: Seen) => JSON.parse(s.form.get("Attributes") ?? "{}");

Deno.test("the constants are Twilio's sole-prop values, distinct from the EIN tier's", () => {
  assertEquals([POLICY_STARTER_CUSTOMER_PROFILE, POLICY_SOLE_PROP_TRUST_PRODUCT, SOLE_PROP_OTP_SENDER],
    ["RN806dd6cd175f314e1f96a9727ee271f4", "RN670d5d2e282a6130ae063b234b6019c8", "+19152782000"]);
  assertEquals(new Set<string>([POLICY_STARTER_CUSTOMER_PROFILE, POLICY_SECONDARY_CUSTOMER_PROFILE, POLICY_SOLE_PROP_TRUST_PRODUCT, POLICY_A2P_TRUST_PRODUCT]).size, 4,
    "four different policies: a Secondary profile can never stand in for a Starter one");
});

Deno.test("createStarterCustomerProfile in a sub: the exact Starter chain, the primary linked, then pending-review", async () => {
  await withTwilio({}, async (seen) => {
    const r = await createStarterCustomerProfile({ intake: INTAKE, primaryProfileSid: PRIMARY, friendlyName: "sub-builder — Pat Example" }, SUB);
    assertEquals(r, { profileSid: STARTER, endUserSid: PERSON, addressSid: ADDRESS, repSid: PERSON },
      "the same shape as the Secondary one; the person is the end user AND the representative");
    assertEquals(seen.map((s) => `${s.method} ${s.url}`), [
      `POST ${TH}/EndUsers`,
      `POST https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/Addresses.json`,
      `POST ${TH}/SupportingDocuments`,
      `POST ${TH}/CustomerProfiles`,
      `POST ${TH}/CustomerProfiles/${STARTER}/EntityAssignments`,
      `POST ${TH}/CustomerProfiles/${STARTER}/EntityAssignments`,
      `POST ${TH}/CustomerProfiles/${STARTER}/EntityAssignments`,
      `POST ${TH}/CustomerProfiles/${STARTER}/Evaluations`,
      `POST ${TH}/CustomerProfiles/${STARTER}`,
    ]);
    assert(seen.every((s) => s.auth === basic(SUB.user, SUB.pass)), "every request on the sub's own pair");

    const [person, address, doc, profile, a1, a2, a3, evaluation, submit] = seen;
    assertEquals(person.form.get("Type"), "starter_customer_profile_information");
    assertEquals(Object.keys(attrs(person)).sort(), ["email", "first_name", "last_name", "phone_number"], "exactly the Starter EndUser's four keys");
    assertEquals(attrs(person), { email: "pat@example.test", first_name: "Pat", last_name: "Example", phone_number: "+15555550123" },
      "trimmed, so the profile names the person exactly as the brand will");
    assertEquals([address.form.get("CustomerName"), address.form.get("Street"), address.form.get("IsoCountry")], ["Pat Example", "PO Box 100", "US"]);
    assertEquals([doc.form.get("Type"), attrs(doc)], ["customer_profile_address", { address_sids: ADDRESS }]);
    assertEquals([profile.form.get("PolicySid"), profile.form.get("Email"), profile.form.get("FriendlyName")],
      [POLICY_STARTER_CUSTOMER_PROFILE, "pat@example.test", "sub-builder — Pat Example"], "the Starter policy and the BUILDER's own email");
    assertEquals([a1, a2, a3].map((s) => s.form.get("ObjectSid")), [PERSON, DOC, PRIMARY], "its two objects, then the parent's primary");
    assertEquals(evaluation.form.get("PolicySid"), POLICY_STARTER_CUSTOMER_PROFILE, "evaluated against the STARTER policy, not the Secondary");
    assertEquals(submit.form.get("Status"), "pending-review");

    const wire = seen.map((s) => s.body).join("\n");
    for (const banned of ["business_registration", "EIN", "authorized_representative", "job_position", "business_type", POLICY_SECONDARY_CUSTOMER_PROFILE]) {
      assert(!wire.includes(encodeURIComponent(banned)) && !wire.includes(banned), `no EIN-tier field on the wire: ${banned}`);
    }
  });
});

Deno.test("createStarterCustomerProfile: a refused primary link is the typed error (starter), and nothing is evaluated after it", async () => {
  await withTwilio({ refusePrimary: true }, async (seen) => {
    let caught: unknown = null;
    try {
      // The positional call shape.
      await createStarterCustomerProfile(INTAKE, PRIMARY, "sub-builder — Pat Example", SUB);
    } catch (e) { caught = e; }
    assert(caught instanceof PrimaryProfileLinkError, `a PrimaryProfileLinkError, got ${String(caught)}`);
    assert(caught instanceof TrustHubError, "and still a TrustHubError");
    const e = caught as PrimaryProfileLinkError;
    assertEquals([e.profileSid, e.crossAccount, e.refused, e.profileKind, e.code], [STARTER, true, true, "starter", 20403]);
    assert(e.message.startsWith(PRIMARY_LINK_REFUSED) && e.message.includes("starter one"), e.message);
    assert(!/echoes what was sent/.test(e.message), "Twilio's body never reaches the message");
    const last = seen[seen.length - 1];
    assertEquals([last.url, last.form.get("ObjectSid")], [`${TH}/CustomerProfiles/${STARTER}/EntityAssignments`, PRIMARY], "the refused link is the last request");
    assert(!seen.some((s) => s.url.endsWith("/Evaluations")), "nothing evaluated");
    assert(seen.every((s) => s.auth === basic(SUB.user, SUB.pass)), "the positional shape picked up the sub's pair");
  });
});

Deno.test("createStarterCustomerProfile: the (intake, {primary, name}, creds) shape, and malformed inputs refused before any request", async () => {
  await withTwilio({ refuseAt: 1 }, async (seen) => {
    let threw = false;
    try { await createStarterCustomerProfile(INTAKE, { primaryProfileSid: PRIMARY, friendlyName: "named" }, SUB); } catch { threw = true; }
    assert(threw, "the stubbed refusal of the first request surfaces");
    assertEquals([seen.length, seen[0].url, seen[0].auth, seen[0].form.get("FriendlyName")],
      [1, `${TH}/EndUsers`, basic(SUB.user, SUB.pass), "named — starter profile info"]);
  });
  await withTwilio({}, async (seen) => {
    for (const bad of [
      () => createStarterCustomerProfile({ intake: INTAKE, primaryProfileSid: "BUnope", friendlyName: "x" }, SUB),
      () => createStarterCustomerProfile({ intake: { ...INTAKE, repFirstName: " ", repLastName: "" }, primaryProfileSid: PRIMARY, friendlyName: "x" }, SUB),
    ]) {
      let caught: unknown = null;
      try { await bad(); } catch (e) { caught = e; }
      assert(caught instanceof TrustHubError && caught.permanent, String(caught));
    }
    assertEquals(seen.length, 0, "nothing reached Twilio");
  });
});

Deno.test("createSoleProprietorTrustProduct: the person's name and mobile on the sole-prop EndUser, the Starter profile assigned, pending-review", async () => {
  await withTwilio({}, async (seen) => {
    await createSoleProprietorTrustProduct(INTAKE, "BUnope", SUB).catch(() => {});
    assertEquals(seen.length, 0, "a malformed Starter SID is refused before any request");

    const r = await createSoleProprietorTrustProduct(INTAKE, STARTER, SUB);
    assertEquals(r, { a2pProfileSid: SOLE_TP });
    assertEquals(seen.map((s) => `${s.method} ${s.url}`), [
      `POST ${TH}/EndUsers`,
      `POST ${TH}/TrustProducts`,
      `POST ${TH}/TrustProducts/${SOLE_TP}/EntityAssignments`,
      `POST ${TH}/TrustProducts/${SOLE_TP}/EntityAssignments`,
      `POST ${TH}/TrustProducts/${SOLE_TP}/Evaluations`,
      `POST ${TH}/TrustProducts/${SOLE_TP}`,
    ]);
    assert(seen.every((s) => s.auth === basic(SUB.user, SUB.pass)), "every request on the sub's own pair");
    const [info, tp, a1, a2, evaluation, submit] = seen;
    assertEquals(info.form.get("Type"), "sole_proprietor_information");
    assertEquals(attrs(info), { brand_name: "Pat Example", mobile_phone_number: "+15555550123", vertical: "CONSTRUCTION" },
      "the PERSON as the brand (30914), their mobile (where the YES text goes), CONSTRUCTION");
    assertEquals([tp.form.get("PolicySid"), tp.form.get("Email"), tp.form.get("FriendlyName")],
      [POLICY_SOLE_PROP_TRUST_PRODUCT, "pat@example.test", "Pat Example"]);
    assertEquals([a1.form.get("ObjectSid"), a2.form.get("ObjectSid")], [SOLE_INFO, STARTER],
      "its own sole_proprietor_information EndUser, then the STARTER profile");
    assertEquals(evaluation.form.get("PolicySid"), POLICY_SOLE_PROP_TRUST_PRODUCT);
    assertEquals(submit.form.get("Status"), "pending-review");
    assert(!seen.some((s) => s.body.includes("us_a2p_messaging_profile_information")), "not the EIN tier's messaging-profile EndUser");
  });
});

Deno.test("createSoleProprietorTrustProduct: the options-object shape takes profileSid, a name and an email", async () => {
  await withTwilio({ refuseAt: 2 }, async (seen) => {
    // Stopped at the second request (the Trust Product), which is far enough to read both names
    // and the email it was given.
    await createSoleProprietorTrustProduct({ intake: INTAKE, profileSid: STARTER, friendlyName: "sub-builder — sole prop A2P", email: "office@example.test" }, SUB).catch(() => {});
    assertEquals(seen.map((s) => [s.url, s.form.get("FriendlyName"), s.auth]), [
      [`${TH}/EndUsers`, "sub-builder — sole prop A2P — sole proprietor info", basic(SUB.user, SUB.pass)],
      [`${TH}/TrustProducts`, "sub-builder — sole prop A2P", basic(SUB.user, SUB.pass)],
    ]);
    assertEquals(seen[1].form.get("Email"), "office@example.test");
  });
  await withTwilio({}, async (seen) => {
    await createSoleProprietorTrustProduct({ intake: { ...INTAKE, repPhone: "5555550123" }, customerProfileSid: STARTER }, SUB).catch(() => {});
    assertEquals(seen.length, 0, "a mobile not in +1 form is refused before any request");
  });
});

Deno.test("resendBrandOtp: POST …/BrandRegistrations/{BN}/SmsOtp with no body, on the account's own pair", async () => {
  await withTwilio({}, async (seen) => {
    await resendBrandOtp(BRAND, SUB);
    assertEquals(seen.map((s) => [s.method, s.url, s.auth, s.body, s.contentType]), [
      ["POST", `https://messaging.twilio.com/v1/a2p/BrandRegistrations/${BRAND}/SmsOtp`, basic(SUB.user, SUB.pass), "", null],
    ]);
    let threw = false;
    try { await resendBrandOtp("BN../x", SUB); } catch (e) { threw = e instanceof TrustHubError; }
    assert(threw && seen.length === 1, "a malformed brand SID never reaches Twilio");
  });
});

/** A stub transport over one profile's state (twilioTrustHubPrimaryLink.test.ts's, smaller). */
function profileStub(o: { linked: boolean; status: string; refuseLink?: boolean }) {
  const calls: string[] = [];
  const state = { ...o };
  const http: TrustHubHttp = (method, url, form) => {
    calls.push(`${method} ${url.replace(TH, "")}${form ? " " + JSON.stringify(form) : ""}`);
    if (method === "GET" && url.includes("/EntityAssignments")) {
      return Promise.resolve({ results: [{ object_sid: PERSON }, ...(state.linked ? [{ object_sid: PRIMARY }] : [])] });
    }
    if (method === "POST" && url.endsWith("/EntityAssignments")) {
      if (state.refuseLink) return Promise.reject(new TrustHubError({ message: "refused", status: 400, code: 70002, permanent: true }));
      state.linked = true;
      return Promise.resolve({ sid: "BV" + "2".repeat(32) });
    }
    if (method === "GET") return Promise.resolve({ sid: STARTER, status: state.status });
    if (url.endsWith("/Evaluations")) return Promise.resolve({ sid: "EL" + "1".repeat(32), status: "compliant" });
    state.status = "pending-review";
    return Promise.resolve({ sid: STARTER, status: "pending-review" });
  };
  return { http, calls };
}

Deno.test("finishSecondaryCustomerProfile resumes a half-made STARTER profile against the Starter policy (either way of passing it)", async () => {
  const expected = [
    `GET /CustomerProfiles/${STARTER}/EntityAssignments?PageSize=50`,
    `POST /CustomerProfiles/${STARTER}/EntityAssignments {"ObjectSid":"${PRIMARY}"}`,
    `GET /CustomerProfiles/${STARTER}`,
    `POST /CustomerProfiles/${STARTER}/Evaluations {"PolicySid":"${POLICY_STARTER_CUSTOMER_PROFILE}"}`,
    `POST /CustomerProfiles/${STARTER} {"Status":"pending-review"}`,
  ];
  const viaOpts = profileStub({ linked: false, status: "draft" });
  assertEquals(await finishSecondaryCustomerProfile(STARTER, PRIMARY, viaOpts.http, { crossAccount: true, policySid: POLICY_STARTER_CUSTOMER_PROFILE }),
    { linked: true, submitted: true, status: "pending-review" });
  assertEquals(viaOpts.calls, expected);
  const viaArg = profileStub({ linked: false, status: "draft" });
  await finishSecondaryCustomerProfile(STARTER, PRIMARY, viaArg.http, { crossAccount: true }, POLICY_STARTER_CUSTOMER_PROFILE);
  assertEquals(viaArg.calls, expected);
  // With no policy it is the Secondary one, exactly as before.
  const plain = profileStub({ linked: true, status: "draft" });
  await finishSecondaryCustomerProfile(STARTER, PRIMARY, plain.http);
  assert(plain.calls.includes(`POST /CustomerProfiles/${STARTER}/Evaluations {"PolicySid":"${POLICY_SECONDARY_CUSTOMER_PROFILE}"}`), plain.calls.join(" | "));
});

Deno.test("finishSecondaryCustomerProfile: a Starter link refused says starter; a Trust Product policy is refused before any request", async () => {
  const s = profileStub({ linked: false, status: "draft", refuseLink: true });
  let caught: unknown = null;
  try { await finishSecondaryCustomerProfile(STARTER, PRIMARY, s.http, { crossAccount: true, policySid: POLICY_STARTER_CUSTOMER_PROFILE }); } catch (e) { caught = e; }
  assert(caught instanceof PrimaryProfileLinkError, String(caught));
  assertEquals([(caught as PrimaryProfileLinkError).profileKind, (caught as PrimaryProfileLinkError).profileSid], ["starter", STARTER]);
  assertEquals(s.calls.length, 2, "the read and the refused link, then nothing");

  const none = profileStub({ linked: false, status: "draft" });
  let threw = false;
  try { await finishSecondaryCustomerProfile(STARTER, PRIMARY, none.http, { policySid: POLICY_SOLE_PROP_TRUST_PRODUCT }); } catch (e) { threw = e instanceof TrustHubError; }
  assert(threw && none.calls.length === 0, "only the two customer-profile policies are accepted");
});

Deno.test("brandReadyForCampaign: a sole proprietor needs APPROVED and VERIFIED; every other tier APPROVED, as before", () => {
  const T = true, F = false;
  // [tier, brand status, identity status, ready?]
  const table: Array<[string | null, string | null, string | null, boolean]> = [
    ["sole_proprietor", "APPROVED", "VERIFIED", T],
    ["sole_proprietor", "APPROVED", "verified", T],          // the event's lowercase spelling
    ["sole_proprietor", "registered", "verified", T],        // the brand-verified event, raw
    ["sole_proprietor", "APPROVED", "VETTED_VERIFIED", T],
    ["sole_proprietor", "APPROVED", "UNVERIFIED", F],        // approved, waiting for the YES
    ["sole_proprietor", "registered", "unverified", F],      // the brand-unverified event, raw
    ["sole_proprietor", "APPROVED", null, F],
    ["sole_proprietor", "APPROVED", "SELF_DECLARED", F],
    ["sole_proprietor", "PENDING", "VERIFIED", F],
    ["sole_proprietor", "FAILED", "VERIFIED", F],
    ["sole_proprietor", null, null, F],
    ["low_volume_standard", "APPROVED", null, T],
    ["low_volume_standard", "APPROVED", "UNVERIFIED", T],    // identity is not this tier's gate
    ["low_volume_standard", "APPROVED", "SELF_DECLARED", T],
    ["low_volume_standard", "registered", null, T],
    ["low_volume_standard", "PENDING", "VERIFIED", F],
    ["low_volume_standard", "IN_REVIEW", null, F],
    ["low_volume_standard", "FAILED", null, F],
    ["low_volume_standard", "SUSPENDED", null, F],
    ["low_volume_standard", null, null, F],
    ["standard", "APPROVED", "VETTED_VERIFIED", T],
    ["standard", "PENDING", null, F],
    [null, "APPROVED", null, T],                             // a row with no tier read is not sole prop
  ];
  for (const [tier, status, identity, ready] of table) {
    assertEquals(brandReadyForCampaign(tier, status, identity), ready, `${tier} / ${status} / ${identity}`);
  }
  assertEquals(brandReadyForCampaign(undefined, undefined, undefined), false);
});

Deno.test("soleProprietorBrandName: the person's first and last name, trimmed, single spaces", () => {
  assertEquals(soleProprietorBrandName({ repFirstName: "  Pat ", repLastName: " Example  " }), "Pat Example");
  assertEquals(soleProprietorBrandName({ repFirstName: "Mary  Ann", repLastName: "Example" }), "Mary Ann Example");
  assertEquals(soleProprietorBrandName({ repFirstName: "Pat", repLastName: "" }), "Pat");
  assertEquals(soleProprietorBrandName({}), "");
  // It takes the whole intake too (the portal-sms callers pass it).
  assertEquals(soleProprietorBrandName(INTAKE), "Pat Example");
});
