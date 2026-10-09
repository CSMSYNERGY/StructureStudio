// Workstream 2, phase 6, portal-settings: CNAM beside SHAKEN/STIR and Voice Integrity, and the
// business profile an operator makes for a builder who only calls (phone_trust_profile).
//
// What is pinned:
//   * runTrustProfile (phoneTrust.ts), every branch against stubs: our internal account is refused;
//     a recorded profile makes nothing (it is finished under the lock, on the parent as in a sub, and
//     one Twilio rejected is a 409 that says so); the details are checked by texting's own rules
//     before the lock; the registration names its sub-account BEFORE the profile is made; the
//     profile is written where texting keeps it, with the echo only where the builder has none; a
//     failed cross-account link is written down IN A SUB only (on the parent nothing is written and
//     the next press starts over: review 2026-10-09), and a link Twilio never answered says "in a
//     minute", not "refused"; the lock is released however it ends; busy is a 409;
//   * the calling-only refusal carries a code the Phone tab answers with the profile form;
//   * runTrustSetup for CNAM records the name Twilio was sent; runTrustStatus reads CNAM only when its
//     columns were read;
//   * portal-settings, read from the SHIPPED source: phone_trust_profile is gated (GATES and the
//     operator gate), refuses a sub-account tenant while the switch is off, needs a live number, and
//     uses texting's own lock; CNAM is refused before 297; the Phone tab offers the name and the form
//     to an operator only.
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE. Every SID is made up.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  NO_PROFILE_CODE, runTrustProfile, runTrustSetup, runTrustStatus, trustProfileFor, TRUST_PROFILE_BUSY_SENTENCE,
  TRUST_PROFILE_INTERNAL_SENTENCE, TRUST_PROFILE_REJECTED_SENTENCE, type RegistrationRow, type TrustLock,
} from "../../supabase/functions/portal-settings/phoneTrust.ts";
import {
  BUSINESS_TYPES, JOB_POSITIONS, PrimaryProfileLinkError, TrustHubError, type BuilderIntake, type VoiceTrustResult, type VoiceTrustSetup,
} from "../../supabase/functions/_shared/twilioTrustHub.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SRC = await read("../../supabase/functions/portal-settings/index.ts");
const SMS = await read("../../portal/11-sms.jsx");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`trustProfileCnam_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const SUB = "AC" + "6".repeat(32);
const PROFILE = "BU" + "6".repeat(32);
const NUMBER = "PN" + "6".repeat(32);
const TP = "BU" + "a".repeat(32);
const INTAKE: BuilderIntake = {
  legalBusinessName: "Example Calls Only LLC", ein: "12-3456789", businessType: "Limited Liability Corporation",
  businessIndustry: "CONSTRUCTION", websiteUrl: "https://calls.example.test", street: "1 Test Way", city: "Testville",
  region: "MO", postalCode: "64101", isoCountry: "US", repFirstName: "Pat", repLastName: "Example",
  repEmail: "pat@calls.example.test", repPhone: "+15555550100", repBusinessTitle: "Owner", repJobPosition: "CEO",
};

function world(o: { busy?: boolean; createFails?: unknown; writeFails?: boolean; profileStatus?: string } = {}) {
  const log: string[] = [];
  const writes: Record<string, unknown>[] = [];
  const lock: TrustLock = {
    claim: () => { log.push("claim"); return Promise.resolve(o.busy ? { ok: false as const, busy: true as const } : { ok: true as const }); },
    release: () => { log.push("release"); return Promise.resolve(); },
  };
  return {
    log, writes,
    deps: {
      lock,
      create: (intake: BuilderIntake, friendlyName: string) => {
        log.push(`create ${friendlyName}`);
        return o.createFails ? Promise.reject(o.createFails) : Promise.resolve({ profileSid: PROFILE });
      },
      finish: (sid: string) => {
        log.push(`finish ${sid.slice(0, 2)}`);
        return Promise.resolve({ linked: true, submitted: false, status: (o.profileStatus ?? "pending-review") as "pending-review" });
      },
      write: (patch: Record<string, unknown>) => {
        log.push(`write ${Object.keys(patch).join(",")}`);
        writes.push(patch);
        return Promise.resolve(o.writeFails ? { ok: false as const, error: { code: "XX000" } } : { ok: true as const });
      },
    },
  };
}
const run = (w: ReturnType<typeof world>, over: Partial<{ internal: boolean; registration: RegistrationRow; subAccountSid: string | null; intake: Partial<BuilderIntake> }> = {}) =>
  runTrustProfile({ clientId: "calls-only", intake: INTAKE, internal: false, registration: { status: "none" }, subAccountSid: SUB, ...over }, w.deps);

Deno.test("runTrustProfile: made in the sub, the account named first, the profile and the echo written, the lock released", async () => {
  const w = world();
  assertEquals(await run(w), { ok: true, created: true, finished: false });
  assertEquals(w.log, ["claim", "write twilio_account_sid", "create calls-only — Example Calls Only LLC",
    "write customer_profile_sid,legal_business_name,ein_last4,rep_email_domain,website_url", "release"]);
  assertEquals(w.writes[0], { twilio_account_sid: SUB });
  assertEquals(w.writes[1], {
    customer_profile_sid: PROFILE, legal_business_name: "Example Calls Only LLC", ein_last4: "6789",
    rep_email_domain: "calls.example.test", website_url: "https://calls.example.test",
  });
  assert(!JSON.stringify(w.writes).includes("123456789") && !JSON.stringify(w.writes).includes("+1555"), "never the EIN or a mobile number");
});

Deno.test("runTrustProfile: on the parent nothing names an account; the builder's own echo is never overwritten", async () => {
  const w = world();
  await run(w, { subAccountSid: null, registration: { status: "intake", legal_business_name: "Their Own Name LLC", website_url: "https://theirs.example.test" } });
  assertEquals(w.log[1], "create calls-only — Example Calls Only LLC");
  assertEquals(w.writes, [{ customer_profile_sid: PROFILE, ein_last4: "6789", rep_email_domain: "calls.example.test" }]);
});

Deno.test("runTrustProfile: a recorded profile makes nothing; it is finished under the lock, on the parent as in a sub", async () => {
  const parent = world();
  assertEquals(await run(parent, { subAccountSid: null, registration: { status: "active", customer_profile_sid: PROFILE }, intake: {} }),
    { ok: true, created: false, finished: true, status: "pending-review" });
  assertEquals(parent.log, ["claim", "finish BU", "release"], "on the parent too (finish reads first: a finished profile is two reads)");
  const sub = world();
  assertEquals(await run(sub, { registration: { status: "none", customer_profile_sid: PROFILE, twilio_account_sid: SUB }, intake: {} }),
    { ok: true, created: false, finished: true, status: "pending-review" });
  assertEquals(sub.log, ["claim", "finish BU", "release"], "and its details are not asked for again");
});

Deno.test("runTrustProfile: a recorded profile Twilio rejected is a 409 that says so, nothing made (review 2026-10-09)", async () => {
  for (const subAccountSid of [SUB, null]) {
    const w = world({ profileStatus: "twilio-rejected" });
    assertEquals(await run(w, { subAccountSid, registration: { status: "none", customer_profile_sid: PROFILE }, intake: {} }),
      { ok: false, kind: "refused", status: 409, error: TRUST_PROFILE_REJECTED_SENTENCE });
    assertEquals(w.log, ["claim", "finish BU", "release"]);
    assertEquals(w.writes, []);
  }
});

Deno.test("runTrustProfile on the PARENT: a failed link writes nothing, and the next press starts over (review 2026-10-09)", async () => {
  const refused = new PrimaryProfileLinkError(new TrustHubError({ message: "x", status: 403, code: 20403, permanent: true }), PROFILE, false);
  const w = world({ createFails: refused });
  const out = await run(w, { subAccountSid: null });
  assert(!out.ok && out.kind === "twilio" && !out.recorded && out.code === 20403, JSON.stringify(out));
  assert(/refused to link .*\(error 20403\)\. Nothing was saved: press it again to start over\./.test(out.error), out.error);
  assertEquals(w.writes, [], "no customer_profile_sid: texting on the parent never builds on an unlinked draft");
  assertEquals(w.log.at(-1), "release");
  // The next press: no recorded profile, so a fresh one is made in full.
  const again = world();
  assertEquals(await run(again, { subAccountSid: null }), { ok: true, created: true, finished: false });
  assert(again.log.some((l) => l.startsWith("create ")), JSON.stringify(again.log));
});

Deno.test("runTrustProfile in a SUB: a link Twilio never answered is written down and says to try again in a minute, not refused", async () => {
  const unanswered = new PrimaryProfileLinkError(new TrustHubError({ message: "x", status: 503, code: 0, permanent: false }), PROFILE, true);
  const w = world({ createFails: unanswered });
  const out = await run(w);
  assert(!out.ok && out.kind === "twilio" && out.recorded, JSON.stringify(out));
  assert(/didn't answer .* It is saved here: press it again in a minute to retry just the link\./.test(out.error), out.error);
  assert(!/refused/.test(out.error), out.error);
  assertEquals(w.writes.at(-1), { customer_profile_sid: PROFILE });
});

Deno.test("runTrustProfile: refusals come before the lock; busy is a 409; Twilio failures are reported with the lock released", async () => {
  const internal = world();
  assertEquals(await run(internal, { internal: true }), { ok: false, kind: "refused", status: 409, error: TRUST_PROFILE_INTERNAL_SENTENCE });
  const bad = world();
  const r = await run(bad, { intake: { ...INTAKE, ein: "12", repEmail: "pat@gmail.com" } });
  assert(!r.ok && r.kind === "refused" && r.status === 400 && (r.problems ?? []).length === 2, JSON.stringify(r));
  assertEquals([internal.log, bad.log], [[], []]);
  const busy = world({ busy: true });
  assertEquals(await run(busy), { ok: false, kind: "refused", status: 409, error: TRUST_PROFILE_BUSY_SENTENCE });
  const refusedLink = world({ createFails: new PrimaryProfileLinkError(new TrustHubError({ message: "x", status: 403, code: 20403, permanent: true }), PROFILE, true) });
  const out = await run(refusedLink);
  assert(!out.ok && out.kind === "twilio" && out.recorded && out.code === 20403, JSON.stringify(out));
  assertEquals(refusedLink.writes.at(-1), { customer_profile_sid: PROFILE }, "the half-made profile is written down, so the next press finishes it");
  assertEquals(refusedLink.log.at(-1), "release");
  const down = world({ createFails: new TrustHubError({ message: "y", status: 400, code: 21608, permanent: true }) });
  const d = await run(down);
  assert(!d.ok && d.kind === "twilio" && !d.recorded && /didn't accept the business details \(error 21608\)/.test(d.error));
  assertEquals(down.log.at(-1), "release");
  assert(!JSON.stringify(d).includes("Example Calls Only"), "no submitted detail travels back");
});

Deno.test("a builder with no profile is refused with a code the Phone tab answers", () => {
  const r = trustProfileFor({ secondaryProfileSid: null, internal: false, primaryProfileSid: "BU" + "0".repeat(32) });
  assert(!r.ok && r.code === NO_PROFILE_CODE);
});

Deno.test("CNAM: the name Twilio was sent is recorded; status reads CNAM only when its columns were read", async () => {
  const writes: Record<string, unknown>[] = [];
  const setupSeen: VoiceTrustSetup[] = [];
  const result: VoiceTrustResult = {
    trustProductSid: TP, status: "pending-review", created: true, numberOnProfile: false, profileLinked: true,
    endUserCreated: true, endUserUpdated: false, numberLinked: true, submitted: true,
  };
  const out = await runTrustSetup(
    { kind: "cnam", clientId: "calls-only", numberSid: NUMBER, profileSid: PROFILE, existingSid: null, info: null, cnamName: "Calls Only" },
    {
      lock: { claim: () => Promise.resolve({ ok: true as const }), release: () => Promise.resolve() },
      fetchProfile: () => Promise.resolve({ status: "twilio-approved" as const, email: "pat@calls.example.test" }),
      setup: (s) => { setupSeen.push(s); return s.onTrustProduct!(TP, "draft").then(() => result); },
      write: (p) => { writes.push(p); return Promise.resolve({ ok: true as const }); },
      now: () => "2026-10-09T12:00:00.000Z",
    },
  );
  assert(out.ok);
  assertEquals(setupSeen[0].cnam, { displayName: "Calls Only" });
  assertEquals(setupSeen[0].friendlyName, "calls-only — CNAM");
  assertEquals(writes.at(-1), { cnam_trust_product_sid: TP, cnam_status: "pending-review", caller_id_checked_at: "2026-10-09T12:00:00.000Z", cnam_display_name: "Calls Only" });

  const asked: string[] = [];
  const st = await runTrustStatus({ id: "n1", cnam_trust_product_sid: TP, cnam_status: "pending-review", cnam_display_name: "Calls Only" }, {
    fetchTrustProduct: (sid) => { asked.push(sid); return Promise.resolve({ status: "twilio-approved" as const, errorCodes: [] }); },
    write: () => Promise.resolve({ ok: true as const }),
  });
  assert(st.ok && st.view.cnam.status === "twilio-approved" && st.view.cnam.displayName === "Calls Only" && st.view.cnam.available);
  assertEquals(asked, [TP]);
  const old = await runTrustStatus({ id: "n1", shaken_trust_product_sid: null }, {
    fetchTrustProduct: () => Promise.reject(new Error("must not be called")), write: () => Promise.reject(new Error("must not be called")),
  });
  assert(old.ok && !old.view.cnam.available, "a row read before 297: CNAM is not available, nothing asked");
});

Deno.test("portal-settings: phone_trust_profile's gates, its account rules and texting's own lock", () => {
  assert(/  phone_trust_profile: \{ area: "phone", level: "edit" \},/.test(SRC), "a GATES line");
  const b = slice(SRC, 'if (action === "phone_trust_profile") {', 'if (action === "phone_port_request") {', "phone_trust_profile branch");
  const order = ["phoneOperatorGate()", "subAccountWhileOff(", "tenantTwilio()", "phoneNumberRows()", "isInternalTenant(", "runTrustProfile("];
  let at = -1;
  for (const step of order) {
    const i = b.indexOf(step);
    assert(i > at, `${step} out of order`);
    at = i;
  }
  assert(/if \(offSub === "sub"\) return json\(\{ error: SUB_WHILE_OFF_SENTENCE, code: "twilio_sub_while_off" \}, 409\);/.test(b));
  assert(/if \(!\(numRes\.data \?\? \[\]\)\.length\) \{/.test(b), "a live number first");
  assert(/update\(\{ advance_lock_until: lockUntil \}\)/.test(b), "portal-sms advance's own lock");
  assert(/subAccountSid: onSub \? creds\.accountSid : null/.test(b));
  assert(/createSecondaryCustomerProfile\(\{ intake, primaryProfileSid: primary, friendlyName \}, creds\)/.test(b), "in the tenant's own account");
});

Deno.test("portal-settings: CNAM is phone_trust_setup's third product, refused before 297, its name checked first", () => {
  const b = slice(SRC, 'if (action === "phone_trust_setup") {', "\n  }\n", "phone_trust_setup branch");
  assert(/if \(kind === "cnam" && payload\?\.cnam\?\.displayName != null\) \{\s*const parsed = parseCnamDisplayName\(payload\.cnam\.displayName\);/.test(b));
  assert(/if \(kind === "cnam" && !\("cnam_trust_product_sid" in trustRow\)\) \{/.test(b));
  assert(b.indexOf("parseCnamDisplayName(") < b.indexOf("tenantTwilio()"), "a bad name is refused before anything is asked");
});

Deno.test("the Phone tab: the CNAM row and the business-profile form are an operator's only", () => {
  const card = slice(SMS, "const callerIdCard = ", ") : null;", "callerIdCard");
  assert(/trustRow\("cnam", "Caller name \(CNAM\)"/.test(card), "a third row");
  assert(/data\.canManageCallerId && cnamOpen &&/.test(card), "the name form for an operator only");
  assert(/data\.canManageCallerId && data\.businessProfile && !data\.businessProfile\.exists &&/.test(card), "the profile form for an operator only, while there is none");
  assert(/phoneAction\("phone_trust_profile", \{ intake: \{ \.\.\.bpForm, repPhone: smsE164\(bpForm\.repPhone\) \} \}\)/.test(SMS));
  assert(/product === "cnam" \? \{ cnam: \{ displayName: cnamName \} \} : \{\}/.test(SMS));
  // The form's lists are Twilio's (the server's validateIntake refuses anything else).
  const types = [...slice(SMS, "const PHONE_BP_TYPES = [", "];", "PHONE_BP_TYPES").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const roles = [...slice(SMS, "const PHONE_BP_ROLES = [", "];", "PHONE_BP_ROLES").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assertEquals([...types].sort(), [...BUSINESS_TYPES].sort());
  assertEquals([...roles].sort(), [...JOB_POSITIONS].sort());
});
