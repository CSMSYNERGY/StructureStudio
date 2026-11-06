// No-EIN texting (Twilio's Sole Proprietor A2P tier, 2026-10-27), the server half: portal-sms and its
// soleProp.ts, twilio-events, portal-settings' textingServiceSid and phoneTrust.ts, the opt-in
// disclosure page and the compliance check. (The Twilio chain itself is
// supabase/functions/_shared/twilioTrustHubSoleProp.test.ts; the portal is tests/harness/smsSoleProp.mjs.)
//
// What is pinned:
//   * THE SWITCH (migration 342), read tolerantly: anything but a clean true is off. Off, "no EIN" at
//     save_intake is the 400 every builder got before, with the sentence word for word, asked BEFORE
//     the sole-proprietor rules; a sole-proprietor row stops at `ready` and at `profile_pending` (the
//     paid step) with a note and no Twilio call;
//   * brandReadyForCampaign gates BOTH brand paths (portal-sms's poll and twilio-events), so a sole
//     proprietor waits in brand_pending for the YES, polled every ten minutes, with a note past 30 days;
//   * resend_otp: advance's gate and can_bill, only while the YES is awaited, ten minutes apart in the
//     database, CLAIMED (a unique event_id) before it texts, and a refused send frees its claim;
//   * the ready stage reads a recorded profile's policy before building on it (readySoleProprietor,
//     driven against stubs), the use case is SOLE_PROPRIETOR by name, the sole-prop codes have
//     plain sentences, and switching tier is refused once the carriers hold anything: towards sole
//     proprietor on ANY recorded profile, trust product or brand (the caller-ID trap, review
//     2026-10-27), back from it on the same, freely with nothing recorded, and never between the
//     two EIN tiers;
//   * the sole-prop step notes (switched off, not a Starter profile, no use case, late YES) are
//     cleared when their step moves on (both brand promotions, the campaign's creation, a tier
//     change at save_intake) and no other note ever is; a sole proprietor's brand-failure EVENT
//     stores its errors in the portal's shape with the code's plain sentence (the shipped
//     twilio-events statements are sliced out and run), and an EIN row's patch is what it was;
//   * portal-settings: textingServiceSid is null for a sole proprietor (one number per campaign), and
//     trustProfileFor / chooseTrustProfile / runTrustProfile never use or overwrite a Starter profile;
//   * every EIN builder's answer is what it was: the old sentences are still in place, the old
//     branches still run for every other tier.
// Run: deno test --node-modules-dir=none --import-map=supabase/functions/_shared/_test_stubs/import_map.json -A tests/phone/smsSoleProp_test.ts
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE. Every SID is made up, every person is "Pat Example".

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as SP from "../../supabase/functions/portal-sms/soleProp.ts";
import * as NOTES from "../../supabase/functions/_shared/smsSoleProprietorNotes.ts";
import {
  chooseTrustProfile, NO_PROFILE_CODE, runTrustProfile, SOLE_PROP_PROFILE_CODE, SOLE_PROP_PROFILE_SENTENCE, trustProfileFor,
  TRUST_PROFILE_SOLE_PROP_SENTENCE, type TrustLock,
} from "../../supabase/functions/portal-settings/phoneTrust.ts";
import { consistencyChecks, type Declared } from "../../supabase/functions/_shared/smsComplianceCheck.ts";
import {
  brandReadyForCampaign, POLICY_A2P_TRUST_PRODUCT, POLICY_SECONDARY_CUSTOMER_PROFILE, POLICY_SOLE_PROP_TRUST_PRODUCT,
  POLICY_STARTER_CUSTOMER_PROFILE, SOLE_PROP_OTP_SENDER, type BuilderIntake,
} from "../../supabase/functions/_shared/twilioTrustHub.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SMS = await read("../../supabase/functions/portal-sms/index.ts");
const EVENTS = await read("../../supabase/functions/twilio-events/index.ts");
const SETTINGS = await read("../../supabase/functions/portal-settings/index.ts");
const DISCLOSURE = await read("../../supabase/functions/sms-optin-disclosure/index.ts");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`smsSoleProp_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};
const before = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b);
  assert(i >= 0 && j >= 0, `${what}: "${a}" / "${b}" not found`);
  assert(i < j, `${what}: "${a}" must come before "${b}"`);
};

const SAVE = slice(SMS, 'case "save_intake": {', 'case "compliance_check": {', "save_intake");
const READY = slice(SMS, 'case "ready": {', 'case "profile_pending": {', "advanceOne ready");
const PROFILE_PENDING = slice(SMS, 'case "profile_pending": {', 'case "brand_pending": {', "advanceOne profile_pending");
const BRAND_PENDING = slice(SMS, 'case "brand_pending": {', 'case "brand_approved": {', "advanceOne brand_pending");
const BRAND_APPROVED = slice(SMS, 'case "brand_approved": {', 'case "campaign_pending": {', "advanceOne brand_approved");
const CAMPAIGN_PENDING = slice(SMS, 'case "campaign_pending": {', 'case "campaign_failed": {', "advanceOne campaign_pending");
const RESEND = slice(SMS, 'case "resend_otp": {', 'case "advance": {', "resend_otp");
const STATUS = slice(SMS, 'case "status": {', 'case "save_intake": {', "status");
const VIEW = slice(SMS, "const view = (reg: any, numbers: any[]) => ({", "\n  });\n", "view()");

const PRIMARY = "BU" + "1".repeat(32);
const STARTER = "BU" + "2".repeat(32);
const SECONDARY = "BU" + "3".repeat(32);
const SOLE_TP = "BU" + "4".repeat(32);
const BRAND = "BN" + "5".repeat(32);
const SOLE_INTAKE: BuilderIntake = {
  legalBusinessName: "Pat Example", businessIndustry: "CONSTRUCTION", websiteUrl: "", street: "1 Test Way",
  city: "Testville", region: "MO", postalCode: "64101", isoCountry: "US", repFirstName: "Pat", repLastName: "Example",
  repEmail: "pat@example.test", repPhone: "+15555550101", repBusinessTitle: "", repJobPosition: "",
};

// ── The switch ───────────────────────────────────────────────────────────────────────────────
function settingsDb(answer: { data?: unknown; error?: unknown; throws?: boolean }) {
  const asked: string[] = [];
  const chain = {
    select: (cols: string) => { asked.push(cols); return chain; },
    eq: () => chain,
    maybeSingle: () => answer.throws ? Promise.reject(new Error("network")) : Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null }),
  };
  return { asked, admin: { from: (t: string) => { asked.push(t); return chain; } } };
}

Deno.test("soleProprietorOn: only a clean true is on; no 342, no row, a failed read or a throw are off", async () => {
  const on = settingsDb({ data: { sms_sole_prop: true } });
  assertEquals(await SP.soleProprietorOn(on.admin, "example-builder"), true);
  assertEquals(on.asked, ["client_settings", "sms_sole_prop"], "its own read, of that one column");
  for (const a of [
    { data: { sms_sole_prop: false } }, { data: { sms_sole_prop: "true" } }, { data: null },
    { error: { code: "42703", message: "column client_settings.sms_sole_prop does not exist" } },
    { error: { code: "PGRST204" } }, { error: { code: "57014" } }, { throws: true },
  ]) {
    assertEquals(await SP.soleProprietorOn(settingsDb(a).admin, "example-builder"), false, JSON.stringify(a));
  }
});

Deno.test("portal-sms reads the switch as a THIRD read beside the website one, never a column in it", () => {
  assert(/const \[\{ data: csRow \}, \{ data: ccRow \}, soleOn\] = await Promise\.all\(\[\n\s+admin\.from\("client_settings"\)\.select\("business_website, lead_sms_consent_box"\)[^\n]*\n\s+admin\.from\("client_configs"\)[^\n]*\n\s+soleProprietorOn\(admin, clientId\),\n\s+\]\);/.test(SMS),
    "a database without 342 must not take the website and the consent-box switch with it");
  assert(!/select\("[^"]*sms_sole_prop/.test(SMS), "portal-sms never names the column in a select of its own");
});

// ── Off: the old refusal, word for word ─────────────────────────────────────────────────────
Deno.test("save_intake: no EIN with the switch off is the old 400, word for word, before any sole-prop rule", () => {
  assertEquals(SP.NO_EIN_REFUSAL,
    "Texting can only be set up for a business that has an EIN at the moment. Registering without one goes through a " +
    "different carrier process that we have not built yet — if that is your situation, contact support and we will tell " +
    "you where it stands.", "validateIntake's sentence from before 2026-10-27, verbatim");
  assert(SAVE.includes("if (!hasEin && !soleOn) return json({ error: NO_EIN_REFUSAL, problems: [NO_EIN_REFUSAL] }, 400);"));
  before(SAVE, "if (!hasEin && !soleOn)", "const problems = validateIntake(intake, hasEin);", "the switch is asked before the rules");
  before(SAVE, "if (!hasEin && !soleOn)", "const reg = await load();", "and before anything is read or made");
});

Deno.test("save_intake: switching tier is refused once the carriers hold anything; the sole-prop echo names the person", () => {
  before(SAVE, 'const closed = await signupRefused("save_intake", reg);', "const switchRefused = tierSwitchRefusal(reg, suggestBrandTier(hasEin));", "after the gate");
  before(SAVE, "if (switchRefused) return json({ error: switchRefused, code: \"sms_tier_switch\" }, 409);", 'await admin.from("sms_registrations").update({', "before the write");
  assert(SAVE.includes("...(hasEin ? {} : soleProprietorEcho(soleProprietorBrandName(intake), intake.websiteUrl)),"));
  // The EIN tier's echo lines are untouched.
  for (const l of ["legal_business_name: intake.legalBusinessName ?? null,", "ein_last4: ein ? ein.slice(-4) : null,",
    "website_url: intake.websiteUrl ?? null,", "brand_tier: suggestBrandTier(hasEin),"]) assert(SAVE.includes(l), l);

  const T = SP.tierSwitchRefusal;
  assertEquals(T(null, "sole_proprietor"), null);
  assertEquals(T({ brand_tier: "low_volume_standard", status: "ready" }, "low_volume_standard"), null, "same tier: always");
  assertEquals(T({ brand_tier: "low_volume_standard", status: "none" }, "sole_proprietor"), null, "nothing at Twilio yet");
  assertEquals(T({ status: "none" }, "sole_proprietor"), null, "the column default reads as the EIN tier");
  assertEquals(T({ brand_tier: "low_volume_standard", brand_sid: BRAND, status: "brand_failed" }, "sole_proprietor"), SP.SOLE_PROP_SWITCH_PROFILE_SENTENCE);
  assertEquals(T({ brand_tier: "sole_proprietor", brand_sid: BRAND, status: "brand_failed" }, "low_volume_standard"), SP.TIER_SWITCH_SENTENCE);
  assertEquals(T({ brand_tier: "sole_proprietor", customer_profile_sid: STARTER, status: "ready" }, "low_volume_standard"), SP.TIER_SWITCH_SENTENCE,
    "a Starter profile can never back the EIN chain");
  assertEquals(SP.soleProprietorEcho("Pat Example", "  "), { legal_business_name: "Pat Example", ein_last4: null, website_url: null });
  assertEquals(SP.soleProprietorEcho("Pat Example", " https://example.test "), { legal_business_name: "Pat Example", ein_last4: null, website_url: "https://example.test" });
});

// The 2026-10-27 review's trap: phone_trust_profile (caller ID on the Phone tab) writes a SECONDARY
// profile onto a row that never submitted texting (status 'none', default tier). A "No" used to be
// allowed there, which made the row a sole proprietor holding an EIN business's profile, and the
// way back was then refused as "already gone to the carriers": stuck without hand-written SQL.
Deno.test("tierSwitchRefusal: no route to sole proprietor while ANY Twilio object is recorded, so a sole-prop row never holds a non-Starter profile", () => {
  const T = SP.tierSwitchRefusal;
  const NO = SP.SOLE_PROP_SWITCH_PROFILE_SENTENCE;
  const TP = "BU" + "7".repeat(32);
  // Towards sole proprietor, from either EIN tier or the column default, refused on each object alone.
  for (const from of [{ brand_tier: "low_volume_standard" }, { brand_tier: "standard" }, { brand_tier: null }, {}]) {
    for (const held of [{ customer_profile_sid: SECONDARY }, { a2p_profile_sid: TP }, { brand_sid: BRAND }, { customer_profile_sid: SECONDARY, a2p_profile_sid: TP }]) {
      assertEquals(T({ ...from, status: "none", ...held }, "sole_proprietor"), NO, JSON.stringify({ from, held }));
    }
  }
  // The exact row phone_trust_profile leaves: status 'none', no tier written, a Secondary BU, no brand.
  assertEquals(T({ status: "none", customer_profile_sid: SECONDARY }, "sole_proprietor"), NO, "the caller-ID row is refused up front");
  // ...and the sentence is true there: it does not claim a registration went anywhere.
  assert(/business profile at the carriers/.test(NO) && /caller ID on the Phone tab/.test(NO) && /needs support/.test(NO), NO);
  assert(!/already gone to the carriers/.test(NO) && !/\d{5}/.test(NO));
  // Away from sole proprietor: refused once a (now necessarily Starter) profile, a trust product or a brand is recorded.
  for (const held of [{ customer_profile_sid: STARTER }, { a2p_profile_sid: SOLE_TP }, { brand_sid: BRAND }]) {
    for (const to of ["low_volume_standard", "standard"]) {
      assertEquals(T({ brand_tier: "sole_proprietor", status: "ready", ...held }, to), SP.TIER_SWITCH_SENTENCE, JSON.stringify({ held, to }));
    }
  }
  // Between the two EIN tiers nothing is refused, brand or not: save_intake never refused it before 2026-10-27.
  assertEquals(T({ brand_tier: "standard", brand_sid: BRAND, customer_profile_sid: SECONDARY, status: "brand_failed" }, "low_volume_standard"), null);
  assertEquals(T({ brand_tier: "low_volume_standard", brand_sid: BRAND, status: "brand_failed" }, "standard"), null);
});

Deno.test("tierSwitchRefusal: a sole-prop row with NOTHING recorded still goes back to the EIN route", () => {
  const T = SP.tierSwitchRefusal;
  // Saved as "No" (switch on), maybe pressed Submit with the switch off (SOLE_PROP_OFF_NOTE): no profile, no brand.
  for (const row of [
    { brand_tier: "sole_proprietor", status: "aup_pending" },
    { brand_tier: "sole_proprietor", status: "ready", needs_attention: true, attention_note: SP.SOLE_PROP_OFF_NOTE },
    { brand_tier: "sole_proprietor", status: "ready", customer_profile_sid: null, a2p_profile_sid: "", brand_sid: null },
  ]) {
    assertEquals(T(row, "low_volume_standard"), null, JSON.stringify(row));
  }
});

Deno.test("save_intake: a tier that changed takes a sole-prop step note with it, and only then", () => {
  const changed = 'const tierChanged = String(reg?.brand_tier ?? "low_volume_standard") !== suggestBrandTier(hasEin);';
  assert(SAVE.includes(changed), "the change is measured against the row's tier, default included");
  before(SAVE, "if (switchRefused) return json(", changed, "only for a switch that was allowed");
  const spread = "...(tierChanged ? clearSoleProprietorStepNote(reg?.attention_note) : {}),";
  assert(SAVE.includes(spread), "spread into the one update");
  before(SAVE, 'await admin.from("sms_registrations").update({', spread, "inside the update");
  before(SAVE, spread, '}).eq("client_id", clientId);', "inside the update");
  // The rule it applies: the switched-off note goes; anyone else's note stays; no change, no key at all.
  const clear = (tierChangedNow: boolean, note: unknown) => (tierChangedNow ? SP.clearSoleProprietorStepNote(note) : {});
  assertEquals(clear(true, SP.SOLE_PROP_OFF_NOTE), { needs_attention: false, attention_note: null });
  assertEquals(clear(true, SP.SOLE_PROP_NOT_STARTER_NOTE), { needs_attention: false, attention_note: null });
  assertEquals(clear(true, "The carriers refused to register this number. It may need to be released and replaced."), {});
  assertEquals(clear(true, null), {});
  assertEquals(clear(false, SP.SOLE_PROP_OFF_NOTE), {}, "an unchanged tier writes exactly what it wrote before");
});

Deno.test("ready and profile_pending: a sole-proprietor row with the switch off stops before Twilio and before the hold", () => {
  const off = 'if (reg.brand_tier === "sole_proprietor" && !(await soleProprietorOn(admin, clientId))) {';
  assert(READY.includes(off) && PROFILE_PENDING.includes(off));
  before(READY, off, "const intake = (p.intake ?? {}) as BuilderIntake;", "ready: before the intake is read");
  before(READY, off, "readySoleProprietor(", "ready: before the chain");
  before(PROFILE_PENDING, "if (reg.brand_sid) {", off, "profile_pending: a brand already made is reconciled first");
  before(PROFILE_PENDING, off, 'takeHold(admin, clientId, "sms_registration"', "profile_pending: before the wallet hold");
  before(PROFILE_PENDING, off, "registerBrand({", "and before the paid brand");
  for (const s of [READY, PROFILE_PENDING]) {
    const block = slice(s, off, "\n      }\n", "the off block");
    assert(/await note\("sole_prop_switched_off", \{ stage: "(ready|profile_pending)" \}\);\s*return await set\(\{ needs_attention: true, attention_note: SOLE_PROP_OFF_NOTE \}\);/.test(block), block);
  }
  // Turned on later: the brand step clears that note for a sole proprietor only.
  assert(PROFILE_PENDING.includes('...(reg.brand_tier === "sole_proprietor" ? { needs_attention: false, attention_note: null } : {}),'));
});

// ── The ready stage ──────────────────────────────────────────────────────────────────────────
Deno.test("ready: a sole proprietor branches off after the copy is saved; the EIN tier below is untouched", () => {
  const branch = 'if (reg.brand_tier === "sole_proprietor") {\n        return await readySoleProprietor(reg, soleReadyDeps({ admin, clientId, intake, primaryProfileSid, note, set, creds }), soon);';
  assert(READY.includes(branch), "the branch");
  before(READY, "campaign_copy_updated_at: new Date().toISOString(),", branch, "the copy is written down first");
  before(READY, branch, 'const onSub = creds?.source === "sub";', "before the EIN tier's stages");
  // Validated as no-EIN for this tier, as before (validateIntake now holds the sole-prop rules).
  assert(READY.includes('const problems = validateIntake(intake, reg.brand_tier !== "sole_proprietor");'));
  // The deps: the Starter policy on finish, the link written down in a sub only, a rejection is the 409.
  const deps = slice(SMS, "function soleReadyDeps(o: {", "\n}\n", "soleReadyDeps");
  assert(/finishSecondaryCustomerProfile\(sid, o\.primaryProfileSid, http, \{\s*crossAccount: onSub, policySid: POLICY_STARTER_CUSTOMER_PROFILE,\s*\}\)/.test(deps), deps);
  assert(/if \(onSub && e instanceof PrimaryProfileLinkError && \/\^BU\[0-9a-f\]\{32\}\$\/i\.test\(e\.profileSid\)\) \{\s*await o\.set\(\{ customer_profile_sid: e\.profileSid \}\);/.test(deps));
  assert(deps.includes("rejected: () => Promise.reject(new ProfileRejectedError()),"));
  assert(deps.includes("readProfile: (sid) => readCustomerProfile(sid, http),") && deps.includes("readTrustProduct: (sid) => fetchTrustProduct(sid, http),"));
});

type Call = string;
function readyWorld(o: {
  profilePolicy?: string; profileStatus?: string; finishStatus?: string; tpPolicy?: string; createFails?: unknown;
} = {}) {
  const log: Call[] = [];
  const writes: Record<string, unknown>[] = [];
  const deps: SP.SoleReadyDeps = {
    set: (patch) => { log.push(`set ${Object.keys(patch).join(",")}`); writes.push(patch); return Promise.resolve({ ...patch }); },
    note: (t) => { log.push(`note ${t}`); return Promise.resolve(); },
    readProfile: (sid) => { log.push(`readProfile ${sid.slice(0, 4)}`); return Promise.resolve({ policySid: o.profilePolicy ?? POLICY_STARTER_CUSTOMER_PROFILE, status: (o.profileStatus ?? "in-review") as "in-review" }); },
    readTrustProduct: (sid) => { log.push(`readTrustProduct ${sid.slice(0, 4)}`); return Promise.resolve({ policySid: o.tpPolicy ?? POLICY_SOLE_PROP_TRUST_PRODUCT, status: "in-review" as const }); },
    finishStarter: (sid) => { log.push(`finish ${sid.slice(0, 4)}`); return Promise.resolve({ status: (o.finishStatus ?? "in-review") as "in-review" }); },
    createStarter: () => { log.push("createStarter"); return o.createFails ? Promise.reject(o.createFails) : Promise.resolve({ profileSid: STARTER }); },
    createTrustProduct: (sid) => { log.push(`createTrustProduct ${sid.slice(0, 4)}`); return Promise.resolve({ a2pProfileSid: SOLE_TP }); },
    rejected: () => { log.push("rejected"); return Promise.reject(new Error("rejected")); },
  };
  return { log, writes, deps };
}
const soon = (m: number) => `+${m}m`;

Deno.test("readySoleProprietor: nothing recorded → Starter profile, then the trust product ON it, then profile_pending", async () => {
  const w = readyWorld();
  await SP.readySoleProprietor({ status: "ready", brand_tier: "sole_proprietor" }, w.deps, soon);
  assertEquals(w.log, ["createStarter", `createTrustProduct ${STARTER.slice(0, 4)}`, "note profiles_created",
    "set customer_profile_sid,a2p_profile_sid,status,next_poll_at,needs_attention,attention_note"]);
  assertEquals(w.writes.at(-1), {
    customer_profile_sid: STARTER, a2p_profile_sid: SOLE_TP, status: "profile_pending", next_poll_at: "+2m",
    needs_attention: false, attention_note: null,
  });
});

Deno.test("readySoleProprietor: a recorded SECONDARY profile is refused with a note — nothing made, finished or charged", async () => {
  for (const policy of [POLICY_SECONDARY_CUSTOMER_PROFILE, ""]) {
    const w = readyWorld({ profilePolicy: policy });
    await SP.readySoleProprietor({ status: "ready", brand_tier: "sole_proprietor", customer_profile_sid: SECONDARY }, w.deps, soon);
    assertEquals(w.log, [`readProfile ${SECONDARY.slice(0, 4)}`, "note sole_prop_profile_not_starter", "set needs_attention,attention_note"], policy);
    assertEquals(w.writes[0], { needs_attention: true, attention_note: SP.SOLE_PROP_NOT_STARTER_NOTE });
  }
});

Deno.test("readySoleProprietor: a recorded Starter profile is finished against its own policy, then reused", async () => {
  const w = readyWorld();
  await SP.readySoleProprietor({ status: "ready", brand_tier: "sole_proprietor", customer_profile_sid: STARTER }, w.deps, soon);
  assertEquals(w.log.slice(0, 3), [`readProfile ${STARTER.slice(0, 4)}`, `finish ${STARTER.slice(0, 4)}`, `createTrustProduct ${STARTER.slice(0, 4)}`]);
  assert(!w.log.includes("createStarter"), "never a second profile");
  assertEquals(w.writes.at(-1)?.customer_profile_sid, STARTER);
});

Deno.test("readySoleProprietor: a profile Twilio rejected stops before the trust product (read, or after finishing)", async () => {
  for (const o of [{ profileStatus: "twilio-rejected" }, { finishStatus: "twilio-rejected" }]) {
    const w = readyWorld(o);
    let thrown = false;
    try { await SP.readySoleProprietor({ status: "ready", brand_tier: "sole_proprietor", customer_profile_sid: STARTER }, w.deps, soon); } catch { thrown = true; }
    assert(thrown, JSON.stringify(o));
    assert(w.log.includes("note profile_rejected") && w.log.at(-1) === "rejected", w.log.join(" | "));
    assert(!w.log.some((l) => l.startsWith("createTrustProduct")) && !w.log.some((l) => l.startsWith("set")), "nothing built or written");
  }
});

Deno.test("readySoleProprietor: a recorded trust product that is not a Sole Proprietor one is refused, never built on", async () => {
  const w = readyWorld({ tpPolicy: POLICY_A2P_TRUST_PRODUCT });
  await SP.readySoleProprietor({ status: "ready", brand_tier: "sole_proprietor", customer_profile_sid: STARTER, a2p_profile_sid: SOLE_TP }, w.deps, soon);
  assert(!w.log.some((l) => l.startsWith("createTrustProduct")));
  assertEquals(w.writes.at(-1), { customer_profile_sid: STARTER, needs_attention: true, attention_note: SP.SOLE_PROP_TRUST_PRODUCT_NOTE });
  const ok = readyWorld();
  await SP.readySoleProprietor({ status: "ready", brand_tier: "sole_proprietor", customer_profile_sid: STARTER, a2p_profile_sid: SOLE_TP }, ok.deps, soon);
  assert(ok.log.includes(`readTrustProduct ${SOLE_TP.slice(0, 4)}`) && !ok.log.some((l) => l.startsWith("createTrustProduct")), "a sole-prop one is reused");
  assertEquals(ok.writes.at(-1)?.status, "profile_pending");
});

Deno.test("readySoleProprietor: a create that fails throws with nothing written here (the caller records a sub's link)", async () => {
  const w = readyWorld({ createFails: new Error("link refused") });
  let thrown: unknown = null;
  try { await SP.readySoleProprietor({ status: "ready", brand_tier: "sole_proprietor" }, w.deps, soon); } catch (e) { thrown = e; }
  assert(thrown instanceof Error);
  assertEquals(w.log, ["createStarter"]);
});

Deno.test("readCustomerProfile: one GET of the profile, its policy and review state; a malformed SID asks nothing", async () => {
  const asked: string[] = [];
  const http = (m: string, u: string) => { asked.push(`${m} ${u}`); return Promise.resolve({ policy_sid: POLICY_STARTER_CUSTOMER_PROFILE, status: "in-review" }); };
  assertEquals(await SP.readCustomerProfile(STARTER, http), { policySid: POLICY_STARTER_CUSTOMER_PROFILE, status: "in-review" });
  assertEquals(asked, [`GET https://trusthub.twilio.com/v1/CustomerProfiles/${STARTER}`]);
  assertEquals(await SP.readCustomerProfile("BUnope", http), { policySid: "", status: null });
  assertEquals(asked.length, 1);
});

// ── The YES: brandReadyForCampaign in both brand paths ───────────────────────────────────────
Deno.test("brand_pending (poll and lazy sweep): promoted only when brandReadyForCampaign says so", () => {
  const gate = "if (brandReadyForCampaign(reg.brand_tier, status, identity)) {";
  assert(BRAND_PENDING.includes(gate));
  assertEquals((BRAND_PENDING.match(/status: "brand_approved"/g) ?? []).length, 1, "one promotion, behind the gate");
  before(BRAND_PENDING, gate, 'status: "brand_approved"', "the gate is the promotion's only door");
  assert(!/if \(status === "APPROVED"\) \{/.test(BRAND_PENDING), "the old APPROVED-only test is gone");
  // Approved without the YES: stays, identity recorded, ten minutes, a note past 30 days.
  const wait = slice(BRAND_PENDING, 'if (soleProp && status === "APPROVED") {', "\n      }\n", "the YES wait");
  assert(wait.includes("const wait = yesWait(await brandRegisteredAt(admin, clientId));"));
  assert(wait.includes("brand_status: status, brand_identity_status: identity, next_poll_at: soon(wait.pollMins),"));
  assert(wait.includes("...(wait.late && !reg.needs_attention ? { needs_attention: true, attention_note: SOLE_PROP_LATE_NOTE } : {}),"));
  assert(!wait.includes("brand_approved"));
  // The sweep still reaches it: brand_pending is swept, and the poll is a pure read.
  assert(STATUS.includes('["brand_pending", "campaign_pending"].includes(reg.status)'));
  // EIN tier: the same two sentences as before.
  assert(BRAND_PENDING.includes('"The carriers suspended this brand. Only Twilio support can lift it."'));
  assert(BRAND_PENDING.includes('const failedNote = "The carriers rejected this registration. Check the details and resubmit.";'));
  assert(BRAND_PENDING.includes(": !soleProp ? failedNote"), "every other tier keeps the old sentence");
  assert(BRAND_PENDING.includes('(soleProp && status === "EXPIRED")'), "EXPIRED fails only a sole proprietor");
  assert(BRAND_PENDING.includes("return await set({ brand_status: status, next_poll_at: soon(60) });"), "the EIN tier still waits an hour");
});

Deno.test("twilio-events: the brand event promotes only through brandReadyForCampaign, with the event's identity first", () => {
  assert(EVENTS.includes('import { brandReadyForCampaign } from "../_shared/twilioTrustHub.ts";'));
  assert(EVENTS.includes('const identityNow = identityRaw ? identityRaw.toUpperCase() : (reg.brand_identity_status ?? null);'));
  assert(EVENTS.includes('if (reg.status === "brand_pending" && brandReadyForCampaign(reg.brand_tier, s, identityNow)) {'));
  assert(!EVENTS.includes('if (s === "APPROVED" && reg.status === "brand_pending") {'), "the old APPROVED-only promotion is gone");
  const idOnly = slice(EVENTS, '} else if (identityRaw && reg.brand_tier === "sole_proprietor" && reg.status === "brand_pending"', "\n    }\n", "the identity-only branch");
  assert(idOnly.includes("brandReadyForCampaign(reg.brand_tier, reg.brand_status, identityNow)") && idOnly.includes('patch.status = "brand_approved";'));
  assertEquals((EVENTS.match(/patch\.status = "brand_approved";/g) ?? []).length, 2, "both promotions are gated");
  assert(EVENTS.includes("if (identityRaw) patch.brand_identity_status = identityRaw.toUpperCase();"), "identity still stored as before");
  // The registration row it gates on carries brand_tier (and the identity already recorded).
  assert(EVENTS.includes('admin.from("sms_registrations").select("*").eq("brand_sid", brandSid).maybeSingle()'));
});

Deno.test("brandReadyForCampaign: a sole proprietor needs the YES; every other tier is APPROVED as before", () => {
  assertEquals(brandReadyForCampaign("low_volume_standard", "APPROVED", null), true);
  assertEquals(brandReadyForCampaign("low_volume_standard", "registered", "unverified"), true, "the event vocabulary");
  assertEquals(brandReadyForCampaign(null, "APPROVED", null), true);
  assertEquals(brandReadyForCampaign("sole_proprietor", "APPROVED", "UNVERIFIED"), false);
  assertEquals(brandReadyForCampaign("sole_proprietor", "registered", "unverified"), false, "the brand-unverified event");
  assertEquals(brandReadyForCampaign("sole_proprietor", "APPROVED", "VERIFIED"), true);
  assertEquals(brandReadyForCampaign("sole_proprietor", "PENDING", "VERIFIED"), false);
});

Deno.test("yesWait: ten minutes while waiting; past 30 days since the brand, an hour and a note", () => {
  const now = Date.parse("2026-11-30T12:00:00Z");
  const day = 24 * 60 * 60_000;
  assertEquals(SP.yesWait(null, now), { pollMins: 10, late: false }, "no brand_registered event: no note");
  assertEquals(SP.yesWait(now - 29 * day, now), { pollMins: 10, late: false });
  assertEquals(SP.yesWait(now - 31 * day, now), { pollMins: 60, late: true });
});

// ── resend_otp ───────────────────────────────────────────────────────────────────────────────
Deno.test("resend_otp: advance's gate and can_bill, only while the YES is awaited, the cooldown before anything", () => {
  assert(/\n\s*resend_otp:\s*\{ area: "settings_billing", level: "edit" \},/.test(SMS), "GATES");
  before(RESEND, "if (r.ctx.operator && !r.ctx.operator.canBill) {", "const reg = await load();", "can_bill first");
  before(RESEND, "if (!otpWaiting(reg)) {", "const last = await lastOtpResend(admin, clientId);", "only while waiting");
  assert(RESEND.includes("if (registrationUnreachable(switchMode(), reg)) return json({ error: SMS_PAUSED_SENTENCE }, 409);"));
  assert(RESEND.includes('if (last.error) return json({ error: "Couldn\'t check when the last text went out. Try again in a minute." }, 503);'), "a failed read refuses");
  const cool = slice(RESEND, "const opensAt = otpResendAvailableAt(last.createdAt);", "\n        }\n", "the cooldown");
  assert(cool.includes('code: "otp_resend_cooldown", otpResendAvailableAt: opensAt,') && cool.includes("}, 429);"), cool);
  before(RESEND, "const opensAt = otpResendAvailableAt(last.createdAt);", "const creds = await tenantCreds();", "the cooldown before the account");
  before(RESEND, "const creds = await tenantCreds();", 'admin.from("sms_registration_events")\n          .insert({', "the account before the claim");
  before(RESEND, "event_id: otpResendKey(clientId, last.id),", "await resendBrandOtp(reg.brand_sid, creds);", "CLAIM, THEN SEND");
  assert(/if \(claimErr && String\(\(claimErr as \{ code\?: string \}\)\.code \?\? ""\) === "23505"\) \{\s*return json\(\{[\s\S]*?code: "otp_resend_cooldown"[\s\S]*?\}, 429\);/.test(RESEND), "a second press at once sends nothing");
  assert(/if \(claimErr \|\| !claim\) \{\s*return json\(\{ error: "Couldn't record the request just now, so nothing was sent\. Try again in a minute\." \}, 503\);/.test(RESEND));
  const fail = slice(RESEND, "} catch (e) {", "throw e;", "a refused send");
  assert(fail.includes(".update({ event_type: OTP_RESEND_FAILED_EVENT, event_id: null })"), "frees the claim: neither the cooldown nor the key");
  assert(RESEND.includes("return json({ ok: true, ...view(await load(), await numbersOf()) });"), "answers with the new view");
  // The status answer says when the button opens, reading only for a registration that is waiting.
  assert(/if \(otpWaiting\(reg\)\) \{\s*const last = await lastOtpResend\(admin, clientId\);\s*if \(!last\.error\) lastOtpResentAt = last\.createdAt;\s*\}/.test(STATUS));
});

Deno.test("the cooldown and the claim key, as numbers", () => {
  const now = Date.parse("2026-10-27T15:00:00Z");
  assertEquals(SP.OTP_RESEND_COOLDOWN_MS, 10 * 60_000);
  assertEquals(SP.otpResendAvailableAt(null, now), null);
  assertEquals(SP.otpResendAvailableAt("not a date", now), null);
  assertEquals(SP.otpResendAvailableAt(new Date(now - 4 * 60_000).toISOString(), now), new Date(now + 6 * 60_000).toISOString());
  assertEquals(SP.otpResendAvailableAt(new Date(now - 10 * 60_000).toISOString(), now), null, "ten minutes on, open");
  assertEquals(SP.otpResendKey("example-builder", null), "otp_resent:example-builder:first");
  assertEquals(SP.otpResendKey("example-builder", "0b0b0b0b-0000-4000-8000-000000000001"), "otp_resent:example-builder:0b0b0b0b-0000-4000-8000-000000000001");
  assertEquals([SP.OTP_RESENT_EVENT, SP.OTP_RESEND_FAILED_EVENT], ["otp_resent", "otp_resend_failed"]);
});

Deno.test("otpWaiting: a sole proprietor in brand_pending, APPROVED, not yet VERIFIED, with a brand", () => {
  const base = { brand_tier: "sole_proprietor", status: "brand_pending", brand_sid: BRAND, brand_status: "APPROVED", brand_identity_status: "UNVERIFIED" };
  assertEquals(SP.otpWaiting(base), true);
  assertEquals(SP.otpWaiting({ ...base, brand_identity_status: null }), true);
  assertEquals(SP.otpWaiting({ ...base, brand_identity_status: "verified" }), false);
  assertEquals(SP.otpWaiting({ ...base, brand_identity_status: "VETTED_VERIFIED" }), false);
  assertEquals(SP.otpWaiting({ ...base, brand_status: "PENDING" }), false, "Twilio has not texted yet");
  assertEquals(SP.otpWaiting({ ...base, status: "brand_approved" }), false);
  assertEquals(SP.otpWaiting({ ...base, brand_tier: "low_volume_standard" }), false);
  assertEquals(SP.otpWaiting({ ...base, brand_sid: null }), false);
  assertEquals(SP.otpWaiting(null), false);
});

// ── The campaign ─────────────────────────────────────────────────────────────────────────────
Deno.test("brand_approved: a sole proprietor asks for SOLE_PROPRIETOR by name, and no campaign without it", () => {
  const guard = slice(BRAND_APPROVED, 'if (reg.brand_tier === "sole_proprietor" && !eligible.some((u) => u.code === "SOLE_PROPRIETOR")) {', "\n      }\n", "the guard");
  assert(guard.includes("attention_note: SOLE_PROP_NO_USE_CASE_NOTE,") && guard.includes("needs_attention: true,"));
  before(BRAND_APPROVED, "const eligible = await fetchEligibleUseCases(", 'if (reg.brand_tier === "sole_proprietor" && !eligible.some(', "asked after the use cases are read");
  before(BRAND_APPROVED, 'if (reg.brand_tier === "sole_proprietor" && !eligible.some(', "const c = await createCampaign({", "and before any campaign");
  assert(BRAND_APPROVED.includes('const wanted = reg.brand_tier === "sole_proprietor" ? "SOLE_PROPRIETOR" : String(p.useCase ?? "");'));
  // The EIN tier's fallback is unchanged.
  assert(/\?\? eligible\.find\(\(u\) => u\.code === "MIXED"\)\s*\?\? eligible\.find\(\(u\) => u\.code === "CUSTOMER_CARE"\)\s*\?\? eligible\[0\];/.test(BRAND_APPROVED));
  // The stale claim is gone.
  assert(!SMS.includes("own record, because the Usa2p resource has no update operation"));
});

Deno.test("the sole-prop codes in plain words, and every other tier keeps its sentences", () => {
  assertEquals(SP.errorCodesOf([{ error_code: 30701 }, { code: 30793 }, { registrationerrorcode: "30791" }, { error_code: 30701 }, null, {}]), [30701, 30793, 30791]);
  assertEquals(SP.errorCodesOf("nope"), []);
  const fb = "fallback";
  assert(/email address or the street address/.test(SP.soleProprietorBrandNote([{ error_code: 30701 }], fb)));
  assert(/wrong way round/.test(SP.soleProprietorBrandNote([{ error_code: 30793 }], fb)));
  assert(/Press Resubmit/.test(SP.soleProprietorBrandNote([{ registrationerrorcode: 30791 }], fb)));
  assertEquals(SP.soleProprietorBrandNote([{ error_code: 99999 }], fb), fb);
  assert(/tax ID/.test(SP.soleProprietorCampaignNote([{ error_code: 30903 }], fb)));
  assert(/first and last name/.test(SP.soleProprietorCampaignNote([{ error_code: 30914 }], fb)));
  assert(/registered company/.test(SP.soleProprietorCampaignNote([{ code: 30915 }], fb)));
  assertEquals(SP.soleProprietorCampaignNote([{ error_code: 30908 }], fb), fb, "a general code keeps the general sentence");
  assertEquals(SP.soleProprietorCampaignNote([], fb), fb);
  // Wired for the sole proprietor only.
  assert(BRAND_PENDING.includes(": soleProprietorBrandNote(b.errors, failedNote),"));
  assert(CAMPAIGN_PENDING.includes('attention_note: reg.brand_tier === "sole_proprietor" ? soleProprietorCampaignNote(c.errors, turnedDown) : turnedDown,'));
  assert(CAMPAIGN_PENDING.includes('const turnedDown = "The carriers turned down the way this campaign describes its texting. Fix the wording and send it again — resending costs nothing.";'));
  // Every sentence here is plain: no Twilio text, no code numbers.
  for (const c of [30701, 30793, 30791]) assert(!/\d{5}/.test(SP.soleProprietorBrandNote([{ error_code: c }], fb)));
  for (const c of [30903, 30914, 30915]) assert(!/\d{5}/.test(SP.soleProprietorCampaignNote([{ error_code: c }], fb)));
});

// ── The notes live in _shared now (twilio-events writes them too) ────────────────────────────
Deno.test("the sole-prop notes come from _shared/smsSoleProprietorNotes.ts; soleProp.ts re-exports the same values", () => {
  for (const k of ["SOLE_PROP_OFF_NOTE", "SOLE_PROP_NOT_STARTER_NOTE", "SOLE_PROP_TRUST_PRODUCT_NOTE", "SOLE_PROP_NO_USE_CASE_NOTE",
    "SOLE_PROP_LATE_NOTE", "SOLE_PROP_EXPIRED_NOTE", "SOLE_PROP_STEP_NOTES", "errorCodesOf", "soleProprietorBrandNote",
    "soleProprietorCampaignNote", "clearSoleProprietorStepNote", "isSoleProprietorStepNote", "brandEventErrors"] as const) {
    assert((SP as Record<string, unknown>)[k] !== undefined && (SP as Record<string, unknown>)[k] === (NOTES as Record<string, unknown>)[k], k);
  }
  // No function imports another's files: twilio-events reaches them through _shared only.
  assert(EVENTS.includes('import { brandEventErrors, clearSoleProprietorStepNote, soleProprietorBrandNote } from "../_shared/smsSoleProprietorNotes.ts";'));
  assert(!/from "\.\.\/portal-sms\//.test(EVENTS), "never portal-sms's files");
});

// The review's other gap: a step note ("still waiting for your YES", "no campaign was sent") stayed on
// the screen and in the operators' needs_attention list after the step it described moved on.
Deno.test("clearSoleProprietorStepNote: clears the four step notes and NOTHING else", () => {
  const CLEARED = { needs_attention: false, attention_note: null };
  for (const n of [SP.SOLE_PROP_LATE_NOTE, SP.SOLE_PROP_NO_USE_CASE_NOTE, SP.SOLE_PROP_OFF_NOTE, SP.SOLE_PROP_NOT_STARTER_NOTE]) {
    assertEquals(SP.clearSoleProprietorStepNote(n), CLEARED, n.slice(0, 40));
  }
  assertEquals([...SP.SOLE_PROP_STEP_NOTES].sort(), [SP.SOLE_PROP_LATE_NOTE, SP.SOLE_PROP_NO_USE_CASE_NOTE, SP.SOLE_PROP_OFF_NOTE, SP.SOLE_PROP_NOT_STARTER_NOTE].sort());
  for (const n of [
    SP.SOLE_PROP_TRUST_PRODUCT_NOTE, SP.SOLE_PROP_EXPIRED_NOTE,
    SP.soleProprietorBrandNote([{ error_code: 30701 }], "x"), SP.soleProprietorCampaignNote([{ error_code: 30914 }], "x"),
    // Every other tier's notes, and portal-sms / twilio-events' own.
    "The carriers rejected this registration. Check the details and resubmit.", "The carriers rejected this registration.",
    "The carriers suspended this brand. Only Twilio support can lift it.",
    "The carriers refused to register this number. It may need to be released and replaced.",
    "Twilio offered no eligible campaign use cases for this brand.",
    SP.SOLE_PROP_LATE_NOTE + " ", SP.SOLE_PROP_LATE_NOTE.toUpperCase(), "", null, undefined, 42,
  ]) {
    assertEquals(SP.clearSoleProprietorStepNote(n), {}, String(n).slice(0, 50));
    assertEquals(SP.isSoleProprietorStepNote(n), false, String(n).slice(0, 50));
  }
});

Deno.test("brand_pending → brand_approved (poll) and the campaign's creation clear a sole proprietor's step note; every other tier adds nothing", () => {
  // The poll's promotion.
  const promo = slice(BRAND_PENDING, "if (brandReadyForCampaign(reg.brand_tier, status, identity)) {", "\n      }\n", "the poll's promotion");
  assert(promo.includes("last_errors: b.errors, status: \"brand_approved\", next_poll_at: soon(1),"), "the promotion as it was");
  assert(promo.includes("...(soleProp ? clearSoleProprietorStepNote(reg.attention_note) : {}),"), promo);
  assert(BRAND_PENDING.includes('const soleProp = reg.brand_tier === "sole_proprietor";'));
  before(BRAND_PENDING, 'const soleProp = reg.brand_tier === "sole_proprietor";', "...(soleProp ? clearSoleProprietorStepNote(", "soleProp is the tier");
  // The campaign's creation (the one createCampaign in brand_approved).
  const made = slice(BRAND_APPROVED, "return await set({\n        messaging_service_sid: svc.serviceSid,\n        campaign_sid: c.campaignSid,", "\n      });", "the campaign_pending write");
  assert(made.includes('status: "campaign_pending",') && made.includes("next_poll_at: soon(60),"), made);
  assert(made.includes('...(reg.brand_tier === "sole_proprietor" ? clearSoleProprietorStepNote(reg.attention_note) : {}),'), made);
  // Neither writes needs_attention / attention_note itself: only through the rule.
  assert(!/needs_attention|attention_note:/.test(promo.replace("clearSoleProprietorStepNote(reg.attention_note)", "")), promo);
  assert(!/needs_attention|attention_note:/.test(made.replace("clearSoleProprietorStepNote(reg.attention_note)", "")), made);
});

Deno.test("twilio-events: both brand promotions clear a sole proprietor's step note, read off the select(\"*\") row", () => {
  const promo = slice(EVENTS, 'if (reg.status === "brand_pending" && brandReadyForCampaign(reg.brand_tier, s, identityNow)) {', "\n      }\n", "the brand event's promotion");
  assert(promo.includes("if (soleProp) Object.assign(patch, clearSoleProprietorStepNote(reg.attention_note));"), promo);
  assert(EVENTS.includes('const soleProp = reg.brand_tier === "sole_proprietor";'));
  const idOnly = slice(EVENTS, '} else if (identityRaw && reg.brand_tier === "sole_proprietor" && reg.status === "brand_pending"', "\n    }\n", "the identity-only branch");
  assert(idOnly.includes("Object.assign(patch, clearSoleProprietorStepNote(reg.attention_note));"), idOnly);
  // attention_note is on the row it decides from: both tenant lookups select every column.
  assert(EVENTS.includes('admin.from("sms_registrations").select("*").eq("brand_sid", brandSid).maybeSingle()'));
  assert(EVENTS.includes('admin.from("sms_registrations").select("*").eq("messaging_service_sid", serviceSid).maybeSingle()'));
  // THE SHIPPED STATEMENTS, run (the promotion block above, sliced out of twilio-events and executed
  // as written): an EIN row's patch is exactly what it was.
  const runPromo = new Function("reg", "s", "identityNow", "patch", "soleProp", "brandReadyForCampaign", "clearSoleProprietorStepNote",
    promo + "\n      }") as (...a: unknown[]) => void;
  const run = (reg: { brand_tier?: string; status?: string; attention_note?: string | null }, s: string, identity: string | null) => {
    const patch: Record<string, unknown> = { updated_at: "t" };
    runPromo(reg, s, identity, patch, reg.brand_tier === "sole_proprietor", brandReadyForCampaign, SP.clearSoleProprietorStepNote);
    delete patch.next_poll_at;
    return patch;
  };
  const late = { status: "brand_pending", attention_note: SP.SOLE_PROP_LATE_NOTE };
  assertEquals(run({ ...late, brand_tier: "sole_proprietor" }, "APPROVED", "VERIFIED"), { updated_at: "t", status: "brand_approved", needs_attention: false, attention_note: null });
  assertEquals(run({ ...late, brand_tier: "sole_proprietor" }, "APPROVED", "UNVERIFIED"), { updated_at: "t" }, "no YES yet: not promoted, note kept");
  assertEquals(run({ status: "brand_pending", brand_tier: "sole_proprietor", attention_note: "An operator's own note." }, "APPROVED", "VERIFIED"), { updated_at: "t", status: "brand_approved" });
  assertEquals(run({ ...late, brand_tier: "low_volume_standard" }, "APPROVED", null), { updated_at: "t", status: "brand_approved" }, "an EIN row: the old promotion, nothing else");
  // The identity-only branch, run the same way.
  const runIdOnly = new Function("reg", "patch", "clearSoleProprietorStepNote",
    idOnly.slice(idOnly.indexOf("patch.status = \"brand_approved\";"), idOnly.indexOf("handled = true;"))) as (...a: unknown[]) => void;
  const p2: Record<string, unknown> = {};
  runIdOnly({ attention_note: SP.SOLE_PROP_NO_USE_CASE_NOTE }, p2, SP.clearSoleProprietorStepNote);
  assertEquals({ ...p2, next_poll_at: undefined }, { status: "brand_approved", next_poll_at: undefined, needs_attention: false, attention_note: null });
});

// The review's third gap: a sole proprietor's brand refused BY EVENT (the usual order: Event Streams
// beats the 30-minute poll) got the generic note and no stored errors, so the plain sentence for its
// code never reached the screen.
Deno.test("twilio-events: a sole proprietor's brand-failure event stores its errors and the code's sentence; an EIN row is as before", () => {
  const block = slice(EVENTS, 'if (!staleSoleFailure && (s === "FAILED" || s === "SUSPENDED" || (soleProp && s === "REGISTRATION_FAILED"))) {', "\n      handled = true;", "the brand failure");
  // Every tier: the statements from before, word for word.
  for (const l of ['patch.status = "brand_failed";', "patch.next_poll_at = null;", "patch.needs_attention = true;",
    'patch.attention_note = s === "SUSPENDED"\n          ? "The carriers suspended this brand. Only Twilio support can lift it."\n          : "The carriers rejected this registration.";']) {
    assert(block.includes(l), l);
  }
  // The sole proprietor's additions, behind the tier only.
  const sole = slice(block, "if (soleProp) {", "\n        }\n", "the sole-prop additions");
  assert(sole.includes("const errs = brandEventErrors(d.brandregistrationerrors ?? d.brandRegistrationErrors);"));
  assert(sole.includes("if (errs) patch.last_errors = errs;"));
  assert(sole.includes('if (s !== "SUSPENDED") patch.attention_note = soleProprietorBrandNote(errs, String(patch.attention_note));'));
  before(block, 'patch.attention_note = s === "SUSPENDED"', "if (soleProp) {", "the generic note first, the sole-prop one over it");
  // REGISTRATION_FAILED (the failure event's own status) fails only a sole proprietor's brand.
  // The only other place it is named is the sole-prop staleness test just above the block.
  for (const line of EVENTS.split("\n").filter((l) => /\|\| s === "REGISTRATION_FAILED"/.test(l))) {
    assert(line.includes('const staleSoleFailure = soleProp && (s === "FAILED" || s === "SUSPENDED" || s === "REGISTRATION_FAILED")'), "never for every tier: " + line);
  }
  assert(!/last_errors/.test(block.replace(sole, "")), "an EIN row's brand failure writes no last_errors, as before");

  // THE SHIPPED STATEMENTS (the block above, sliced out of twilio-events and executed as written),
  // against Twilio's documented failure payload (A2P.BrandRegistrationFailure).
  const runBlock = new Function("s", "soleProp", "patch", "d", "brandEventErrors", "soleProprietorBrandNote", "staleSoleFailure", block) as (...a: unknown[]) => void;
  const apply = (reg: { brand_tier: string }, d: Record<string, unknown>, s: string, stale = false) => {
    const patch: Record<string, unknown> = {};
    runBlock(s, reg.brand_tier === "sole_proprietor", patch, d, SP.brandEventErrors, SP.soleProprietorBrandNote, stale);
    return patch;
  };
  // A sole proprietor's failure that predates their Resubmit changes nothing in this block.
  assertEquals(apply({ brand_tier: "sole_proprietor" }, { brandstatus: "failed" }, "FAILED", true), {}, "stale: the resubmitted attempt stands");
  const failure = {
    brandsid: BRAND, brandstatus: "registration_failed",
    brandregistrationerrors: [{ registrationerrorcode: 30701, registrationerrordescription: "Invalid input parameters", registrationerrorurl: "https://example.test/30701", registrationerrorfields: ["street"] }],
  };
  const out = apply({ brand_tier: "sole_proprietor" }, failure, "REGISTRATION_FAILED");
  assertEquals(out.status, "brand_failed");
  assertEquals(out.last_errors, [{ error_code: 30701, description: "Invalid input parameters", fields: ["street"] }]);
  assertEquals(out.attention_note, SP.soleProprietorBrandNote([{ error_code: 30701 }], "x"));
  assertEquals(apply({ brand_tier: "sole_proprietor" }, { ...failure, brandregistrationerrors: [{ registrationerrorcode: 21736 }] }, "FAILED").attention_note,
    "The carriers rejected this registration.", "a code without a sentence keeps the event's own");
  assertEquals(apply({ brand_tier: "sole_proprietor" }, failure, "SUSPENDED").attention_note, "The carriers suspended this brand. Only Twilio support can lift it.");
  assertEquals("last_errors" in apply({ brand_tier: "sole_proprietor" }, { brandstatus: "failed" }, "FAILED"), false, "no list in the event: last_errors untouched");
  // EIN tiers: exactly the old patch, and the failure event's own status is not (yet) a failure for them.
  for (const tier of ["low_volume_standard", "standard"]) {
    assertEquals(apply({ brand_tier: tier }, failure, "FAILED"), { status: "brand_failed", next_poll_at: null, needs_attention: true, attention_note: "The carriers rejected this registration." });
    assertEquals(apply({ brand_tier: tier }, failure, "REGISTRATION_FAILED"), {});
  }
});

// ── What the portal is told ──────────────────────────────────────────────────────────────────
const CTX = {
  on: true, lastOtpResentAt: null, companyName: "Example Sheds", consentBoxOn: true,
  designerUrl: "https://app.example.test/?client=example-builder",
  disclosureUrl: "https://db.example.test/functions/v1/sms-optin-disclosure?client=example-builder",
};

Deno.test("view(): the four keys for every builder, spread LAST; only a sole proprietor's suggested wording is re-stated", () => {
  const spread = VIEW.indexOf("...soleProprietorView(reg, {");
  assert(spread > VIEW.indexOf("compliance: {"), "after everything else in the projection");
  assert(/\.\.\.soleProprietorView\(reg, \{\n\s+on: soleOn,\n\s+lastOtpResentAt,\n\s+companyName: consentCompanyName,\n\s+consentBoxOn,\n\s+designerUrl: designerUrl\(clientId\),\n\s+disclosureUrl: optInDisclosureUrl\(clientId\),\n\s+\}\),$/.test(VIEW), VIEW.slice(-400));
  assert(VIEW.includes('brandTier: String(reg?.brand_tier ?? ""),'), "the compliance cross-checks know the tier");

  const lvs = SP.soleProprietorView({ status: "none", brand_tier: "low_volume_standard" }, { ...CTX, on: false });
  assertEquals(Object.keys(lvs).sort(), ["identityStatus", "otpResendAvailableAt", "soleProprietorAvailable", "soleProprietorLimits"]);
  assertEquals(lvs.soleProprietorAvailable, false);
  assertEquals(lvs.soleProprietorLimits, { numbers: 1, dailyTMobile: 1000, dailyTotalApprox: 3000, otpSender: SOLE_PROP_OTP_SENDER, otpHours: 24, verifyWithinDays: 30 });
  assertEquals(SOLE_PROP_OTP_SENDER, "+19152782000");

  const waiting = { status: "brand_pending", brand_tier: "sole_proprietor", brand_sid: BRAND, brand_status: "APPROVED", brand_identity_status: "unverified", legal_business_name: "Pat Example" };
  const recent = new Date(Date.now() - 60_000).toISOString();
  const v = SP.soleProprietorView(waiting, { ...CTX, lastOtpResentAt: recent });
  assertEquals(v.identityStatus, "UNVERIFIED");
  assert(typeof v.otpResendAvailableAt === "string" && Date.parse(v.otpResendAvailableAt as string) > Date.now(), "inside the cooldown");
  assertEquals(SP.soleProprietorView({ ...waiting, brand_identity_status: "VERIFIED" }, { ...CTX, lastOtpResentAt: recent }).otpResendAvailableAt, null, "not waiting: null");
  // The suggestion (empty wording on the row) opens on the PERSON, the box's name in brackets.
  const s = v.suggestedCopy as { description: string; messageFlow: string; messageSamples: string[] };
  assert(s.description.startsWith("Pat Example (Example Sheds) texts customers"), s.description);
  for (const m of s.messageSamples) assert(m.startsWith("Pat Example (Example Sheds): Hi [Name],"), m);
  assert(s.messageFlow.includes('"') && s.messageFlow.includes("Example Sheds"), "the opt-in answer still quotes the box as customers see it");
  // Wording on the row: nothing suggested, for this tier as for every other.
  assertEquals(SP.soleProprietorView({ ...waiting, campaign_description: "Ours." }, CTX).suggestedCopy, null);
});

Deno.test("soleProprietorCopy: the person first; no person, no suggestion; the opt-in answer untouched", () => {
  const base = {
    description: "Example Sheds texts customers who request a quote.",
    messageFlow: 'It reads: "Example Sheds may text you."',
    messageSamples: ["Example Sheds: Hi [Name], your quote is ready. Reply STOP to opt out.", "Example Sheds: Hi [Name], delivery is [Date]. Reply STOP to opt out."],
  };
  assertEquals(SP.soleProprietorCopy(null, "Pat Example", "Example Sheds"), null);
  assertEquals(SP.soleProprietorCopy(base, "  ", "Example Sheds"), null);
  const c = SP.soleProprietorCopy(base, " Pat   Example ", "Example Sheds")!;
  assertEquals(c.description, "Pat Example (Example Sheds) texts customers who request a quote.");
  assertEquals(c.messageFlow, base.messageFlow);
  assertEquals(c.messageSamples[1], "Pat Example (Example Sheds): Hi [Name], delivery is [Date]. Reply STOP to opt out.");
  const same = SP.soleProprietorCopy({ ...base, description: "Pat Example texts customers.", messageSamples: ["Pat Example: Hi [Name]. Reply STOP to opt out."] }, "Pat Example", "Pat Example")!;
  assertEquals(same.description, "Pat Example texts customers.", "a business named after its owner is named once");
});

Deno.test("the compliance check leaves out the business-name match for a sole proprietor only", () => {
  const d: Declared = {
    websiteUrl: "https://example.test", privacyPolicyUrl: "https://example.test/privacy", termsUrl: "https://example.test/terms",
    settingsWebsite: "https://example.test", legalBusinessName: "Pat Example", consentCompanyName: "Ridgeline Sheds",
    messageSamples: ["Ridgeline Sheds: Hi [Name]. Reply STOP to opt out."], hasEmbeddedLinks: false,
  };
  const keys = (rows: { key: string }[]) => rows.map((r) => r.key);
  const lvs = consistencyChecks(d);
  assert(keys(lvs).includes("match.business_name"), "unchanged without a tier");
  assertEquals(lvs.find((r) => r.key === "match.business_name")?.verdict, "warn");
  assert(keys(consistencyChecks({ ...d, brandTier: "low_volume_standard" })).includes("match.business_name"));
  const sole = consistencyChecks({ ...d, brandTier: "sole_proprietor" });
  assert(!keys(sole).includes("match.business_name"), "not asked of a person's own name");
  assertEquals(keys(sole), keys(lvs).filter((k) => k !== "match.business_name"), "and nothing else moves");
});

Deno.test("the opt-in disclosure page calls a sole proprietor's name what it is", () => {
  assert(DISCLOSURE.includes('.select("legal_business_name, brand_tier, campaign_description, campaign_message_flow, privacy_policy_url, terms_url, campaign_message_samples")'));
  assert(/reg\?\.brand_tier === "sole_proprietor"\s*\? `Registered sole proprietor: \$\{legalName\}`\s*: `Registered business name: \$\{legalName\}`/.test(DISCLOSURE));
});

// ── portal-settings ──────────────────────────────────────────────────────────────────────────
Deno.test("textingServiceSid: null for a sole proprietor, so no second number ever joins its one-number campaign", () => {
  const svc = slice(SETTINGS, "const textingServiceSid = async ()", "\n  };\n", "textingServiceSid");
  assert(svc.includes('.select("status, messaging_service_sid, brand_tier")'));
  assert(svc.includes('if (!error && r?.brand_tier === "sole_proprietor") return null;'));
  before(svc, 'r?.brand_tier === "sole_proprietor") return null;', 'r?.status === "active"', "before the active answer");
  assert(/r\?\.status === "active"/.test(svc) && /\^MG\[0-9a-f\]\{32\}\$/.test(svc), "every other tier as before");
});

Deno.test("trustProfileFor / chooseTrustProfile: no business profile for a sole proprietor, and no Twilio read for one", async () => {
  for (const internal of [false, true]) {
    assertEquals(trustProfileFor({ secondaryProfileSid: STARTER, internal, primaryProfileSid: PRIMARY, brandTier: "sole_proprietor" }),
      { ok: false, code: SOLE_PROP_PROFILE_CODE, error: SOLE_PROP_PROFILE_SENTENCE });
  }
  assertEquals(trustProfileFor({ secondaryProfileSid: SECONDARY, internal: false, primaryProfileSid: PRIMARY, brandTier: "low_volume_standard" }),
    { ok: true, profileSid: SECONDARY, which: "secondary" }, "the EIN tier as before");
  assertEquals(trustProfileFor({ secondaryProfileSid: SECONDARY, internal: false, primaryProfileSid: PRIMARY }),
    { ok: true, profileSid: SECONDARY, which: "secondary" }, "a caller that passes no tier as before");
  let reads = 0;
  const out = await chooseTrustProfile(
    { secondaryProfileSid: STARTER, internal: true, primaryProfileSid: PRIMARY, numberSid: "PN" + "6".repeat(32), brandTier: "sole_proprietor" },
    { numberOnProfile: () => { reads++; return Promise.resolve(true); } },
  );
  assertEquals(out, { ok: false, kind: "refused", status: 409, error: SOLE_PROP_PROFILE_SENTENCE, code: SOLE_PROP_PROFILE_CODE });
  assertEquals(reads, 0);
  assert(!/\d{5}/.test(SOLE_PROP_PROFILE_SENTENCE) && (SOLE_PROP_PROFILE_CODE as string) !== NO_PROFILE_CODE, "its own code: the Phone tab must not offer the profile form");
});

Deno.test("runTrustProfile: a sole proprietor's registration is refused before the lock — its Starter profile is never finished or overwritten", async () => {
  const log: string[] = [];
  const lock: TrustLock = {
    claim: () => { log.push("claim"); return Promise.resolve({ ok: true as const }); },
    release: () => { log.push("release"); return Promise.resolve(); },
  };
  const deps = {
    lock,
    create: () => { log.push("create"); return Promise.resolve({ profileSid: SECONDARY }); },
    finish: () => { log.push("finish"); return Promise.resolve({ linked: false, submitted: false, status: "in-review" as const }); },
    write: () => { log.push("write"); return Promise.resolve({ ok: true as const }); },
  };
  for (const registration of [
    { status: "brand_pending", brand_tier: "sole_proprietor", customer_profile_sid: STARTER },
    { status: "none", brand_tier: "sole_proprietor" },
  ]) {
    const out = await runTrustProfile({ clientId: "example-builder", intake: SOLE_INTAKE, internal: false, registration, subAccountSid: null }, deps);
    assertEquals(out, { ok: false, kind: "refused", status: 409, error: TRUST_PROFILE_SOLE_PROP_SENTENCE });
  }
  assertEquals(log, [], "nothing claimed, made, finished or written");
});

// The guards above only fire if portal-settings hands them the tier: the row phone_trust_profile
// passes to runTrustProfile, and the one phone_trust_setup reads for chooseTrustProfile.
Deno.test("portal-settings passes the tier to both caller-ID guards (phone_trust_profile and phone_trust_setup)", () => {
  const cols = /const REG_PROFILE_COLUMNS = "([^"]*)";/.exec(SETTINGS);
  assert(cols && cols[1].split(",").map((c) => c.trim()).includes("brand_tier"), "registrationRow reads brand_tier");
  const setup = slice(SETTINGS, 'if (action === "phone_trust_setup") {', 'if (!prof.ok) {', "phone_trust_setup");
  assert(setup.includes('.select("customer_profile_sid, brand_tier")'), "phone_trust_setup reads brand_tier");
  assert(/const prof = await chooseTrustProfile\(\{[\s\S]*?brandTier: \(reg as \{ brand_tier\?: string \| null \} \| null\)\?\.brand_tier \?\? null,[\s\S]*?numberSid: sidRes\.sid,/.test(setup),
    "and passes it to chooseTrustProfile");
  const profile = slice(SETTINGS, 'if (action === "phone_trust_profile") {', "const out = await runTrustProfile({", "phone_trust_profile");
  assert(profile.includes("let reg = await registrationRow();"), "runTrustProfile's registration is registrationRow's");
});

// The review's last two gaps (2026-10-27, second pass): a LATE failure event must not undo a sole
// proprietor's Resubmit, and a Resubmit takes the replaced attempt's errors off the screen.
Deno.test("twilio-events: a sole proprietor's failure older than their last Resubmit is ignored; EIN rows never ask", () => {
  const fn = slice(EVENTS, "async function soleBrandFailureIsStale(", "\n}\n", "soleBrandFailureIsStale");
  assert(fn.includes('.eq("client_id", clientId).eq("event_type", "brand_resubmitted")'), "the row portal-sms's Resubmit writes");
  assert(fn.includes('.order("created_at", { ascending: false }).limit(1).maybeSingle();'), "the newest one");
  assert(fn.includes("return !!data && campaignVerdictPredatesResubmit(d, data.created_at);"), "the campaign's own comparison");
  assert(/catch \{\n\s+return false;/.test(fn), "a failed read is NOT stale: the event applies as before");
  assert(EVENTS.includes('const staleSoleFailure = soleProp && (s === "FAILED" || s === "SUSPENDED" || s === "REGISTRATION_FAILED")\n        && await soleBrandFailureIsStale(admin, reg.client_id, d);'),
    "asked only for a sole proprietor's failure, so an EIN row never reads the table");
  assert(EVENTS.includes("if (staleSoleFailure) delete patch.brand_status;"), "the row keeps the resubmitted attempt's status");
  // portal-sms writes the marker the guard reads, at the Resubmit.
  const failed = slice(SMS, 'case "brand_failed": {', "\n    default:", "advanceOne brand_failed");
  assert(failed.includes('await note("brand_resubmitted", { attempt: Number(reg.brand_update_count ?? 0) + 1 });'));
});

Deno.test("brand_failed Resubmit: a sole proprietor's old refusal reasons go; every other tier writes what it did", () => {
  const failed = slice(SMS, 'case "brand_failed": {', "\n    default:", "advanceOne brand_failed");
  assert(failed.includes('...(reg.brand_tier === "sole_proprietor" ? { last_errors: [] } : {}),'));
  const spread = (tier: string) => ({ ...(tier === "sole_proprietor" ? { last_errors: [] } : {}) });
  assertEquals(spread("sole_proprietor"), { last_errors: [] });
  assertEquals(spread("low_volume_standard"), {});
  assertEquals(spread("standard"), {});
});
