// Workstream 2, phase 6: the secondary customer profile's link to the parent's PRIMARY profile, the
// one EntityAssignment that crosses accounts once a builder's profile lives in their own sub-account.
//
// What is pinned:
//   * createSecondaryCustomerProfile in a SUB: every request on the sub's pair, the primary linked
//     onto the secondary by its BU SID, and a refusal of THAT step is a PrimaryProfileLinkError (a
//     TrustHubError still) carrying the profile it stopped on, crossAccount true and Twilio's code,
//     with nothing evaluated or submitted after it;
//   * finishSecondaryCustomerProfile: reads first; links only when the primary is missing; evaluates
//     and submits only a draft; a finished profile costs three reads and sends nothing; a refused link
//     is the typed error again and nothing after it is sent;
//   * primaryProfileLinked is a single GET.
// No network: fetch and the transport are stubs. Every SID is made up. createSecondaryCustomerProfile
// goes through call(), whose one-request-per-second throttle makes that test take ~8 seconds.
// Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/twilioTrustHubPrimaryLink.test.ts

import {
  createSecondaryCustomerProfile, finishSecondaryCustomerProfile, PRIMARY_LINK_REFUSED, PRIMARY_LINK_UNANSWERED, PrimaryProfileLinkError,
  primaryProfileLinked, TrustHubError, type BuilderIntake, type TrustHubCreds, type TrustHubHttp,
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
const SECONDARY = "BU" + "5".repeat(32);
const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;
const TH = "https://trusthub.twilio.com/v1";

const INTAKE: BuilderIntake = {
  legalBusinessName: "Example Test Builder LLC", ein: "12-3456789", businessType: "Limited Liability Corporation",
  businessIndustry: "CONSTRUCTION", websiteUrl: "https://builder.example.test", street: "1 Test Way", city: "Testville",
  region: "MO", postalCode: "64101", isoCountry: "US", repFirstName: "Pat", repLastName: "Example",
  repEmail: "pat@builder.example.test", repPhone: "+15555550100", repBusinessTitle: "Owner", repJobPosition: "CEO",
};

Deno.test("createSecondaryCustomerProfile in a sub: the primary link refused is a typed error carrying the profile, and nothing is submitted after it", async () => {
  const saved = Deno.env.get("TWILIO_ACCOUNT_SID");
  Deno.env.set("TWILIO_ACCOUNT_SID", PARENT);
  const seen: { method: string; url: string; auth: string | null; body: string }[] = [];
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = String(init?.body ?? "");
    seen.push({ method: String(init?.method ?? "GET"), url, auth: new Headers(init?.headers).get("authorization"), body });
    const json = (b: unknown, status = 201) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/EndUsers")) return json({ sid: "IT" + String(++n).repeat(32).slice(0, 32) });
    if (url.endsWith("/Addresses.json")) return json({ sid: "AD" + "1".repeat(32) });
    if (url.endsWith("/SupportingDocuments")) return json({ sid: "RD" + "1".repeat(32) });
    if (url.endsWith("/CustomerProfiles")) return json({ sid: SECONDARY, status: "draft" });
    if (url.endsWith(`/CustomerProfiles/${SECONDARY}/EntityAssignments`)) {
      // The three objects of its own are taken; the parent's primary is refused.
      return new URLSearchParams(body).get("ObjectSid") === PRIMARY
        ? json({ code: 20403, message: "echoes what was sent" }, 403)
        : json({ sid: "BV" + "1".repeat(32) });
    }
    return json({ message: `unexpected ${url}` }, 500);
  }) as typeof fetch;
  try {
    let caught: unknown = null;
    try {
      await createSecondaryCustomerProfile({ intake: INTAKE, primaryProfileSid: PRIMARY, friendlyName: "sub-builder — Example" }, SUB);
    } catch (e) { caught = e; }
    assert(caught instanceof PrimaryProfileLinkError, `a PrimaryProfileLinkError, got ${String(caught)}`);
    assert(caught instanceof TrustHubError, "and still a TrustHubError, so every existing catch handles it");
    const e = caught as PrimaryProfileLinkError;
    assertEquals([e.profileSid, e.crossAccount, e.code, e.status, e.permanent, e.refused], [SECONDARY, true, 20403, 403, true, true]);
    assert(e.message.startsWith(PRIMARY_LINK_REFUSED), e.message);
    assert(!/echoes what was sent/.test(e.message), "Twilio's body never reaches the message (it echoes what was submitted)");
    assert(seen.every((s) => s.auth === basic(SUB.user, SUB.pass)), "every request on the sub's own pair");
    assert(seen.some((s) => s.url === `https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/Addresses.json`), "the Address in the sub");
    const last = seen[seen.length - 1];
    assertEquals([last.url, new URLSearchParams(last.body).get("ObjectSid")], [`${TH}/CustomerProfiles/${SECONDARY}/EntityAssignments`, PRIMARY],
      "the refused link is the last request: no Evaluation, no submit after it");
    assert(!seen.some((s) => /\/Evaluations$/.test(s.url)), "nothing evaluated");
  } finally {
    globalThis.fetch = realFetch;
    saved === undefined ? Deno.env.delete("TWILIO_ACCOUNT_SID") : Deno.env.set("TWILIO_ACCOUNT_SID", saved);
  }
});

/** A stub transport over one profile's state. */
function profileStub(o: { linked: boolean; status: string; refuseLink?: boolean; linkUnanswered?: boolean }) {
  const calls: string[] = [];
  const state = { ...o };
  const http: TrustHubHttp = (method, url, form) => {
    calls.push(`${method} ${url.replace(TH, "")}${form ? " " + JSON.stringify(form) : ""}`);
    if (method === "GET" && url.includes("/EntityAssignments")) {
      return Promise.resolve({ results: [{ object_sid: "IT" + "1".repeat(32) }, ...(state.linked ? [{ object_sid: PRIMARY }] : [])] });
    }
    if (method === "POST" && url.endsWith("/EntityAssignments")) {
      if (state.refuseLink) return Promise.reject(new TrustHubError({ message: "refused", status: 400, code: 70002, permanent: true }));
      // call()'s verdict on a 5xx (and on no answer at all): not permanent.
      if (state.linkUnanswered) return Promise.reject(new TrustHubError({ message: "unanswered", status: 503, code: 0, permanent: false }));
      state.linked = true;
      return Promise.resolve({ sid: "BV" + "2".repeat(32) });
    }
    if (method === "GET") return Promise.resolve({ sid: SECONDARY, status: state.status });
    if (url.endsWith("/Evaluations")) return Promise.resolve({ sid: "EL" + "1".repeat(32), status: "compliant" });
    state.status = "pending-review";
    return Promise.resolve({ sid: SECONDARY, status: "pending-review" });
  };
  return { http, calls };
}

Deno.test("finishSecondaryCustomerProfile: links a missing primary, then evaluates and submits a draft", async () => {
  const s = profileStub({ linked: false, status: "draft" });
  assertEquals(await finishSecondaryCustomerProfile(SECONDARY, PRIMARY, s.http, { crossAccount: true }),
    { linked: true, submitted: true, status: "pending-review" });
  assertEquals(s.calls, [
    `GET /CustomerProfiles/${SECONDARY}/EntityAssignments?PageSize=50`,
    `POST /CustomerProfiles/${SECONDARY}/EntityAssignments {"ObjectSid":"${PRIMARY}"}`,
    `GET /CustomerProfiles/${SECONDARY}`,
    `POST /CustomerProfiles/${SECONDARY}/Evaluations {"PolicySid":"RNdfbf3fae0e1107f8aded0e7cead80bf5"}`,
    `POST /CustomerProfiles/${SECONDARY} {"Status":"pending-review"}`,
  ]);
});

Deno.test("finishSecondaryCustomerProfile: a finished profile is read and nothing is sent", async () => {
  for (const status of ["pending-review", "in-review", "twilio-approved", "twilio-rejected"]) {
    const s = profileStub({ linked: true, status });
    assertEquals(await finishSecondaryCustomerProfile(SECONDARY, PRIMARY, s.http), { linked: false, submitted: false, status });
    assert(s.calls.every((c) => c.startsWith("GET ")), `${status}: reads only, got ${s.calls.join(" | ")}`);
  }
});

Deno.test("finishSecondaryCustomerProfile: a refused link is the typed error again, and nothing after it is sent", async () => {
  const s = profileStub({ linked: false, status: "draft", refuseLink: true });
  let caught: unknown = null;
  try { await finishSecondaryCustomerProfile(SECONDARY, PRIMARY, s.http, { crossAccount: true }); } catch (e) { caught = e; }
  assert(caught instanceof PrimaryProfileLinkError, String(caught));
  assertEquals([(caught as PrimaryProfileLinkError).profileSid, (caught as PrimaryProfileLinkError).crossAccount, (caught as PrimaryProfileLinkError).code],
    [SECONDARY, true, 70002]);
  assertEquals(s.calls.length, 2, "the read and the refused link, then nothing");
  assert((caught as PrimaryProfileLinkError).refused, "Twilio said no: refused");
  assert((caught as PrimaryProfileLinkError).message.startsWith(PRIMARY_LINK_REFUSED), (caught as Error).message);
});

Deno.test("a link Twilio never answered (5xx, 429, no response) is the typed error with refused false, not a refusal (review 2026-10-09)", async () => {
  const s = profileStub({ linked: false, status: "draft", linkUnanswered: true });
  let caught: unknown = null;
  try { await finishSecondaryCustomerProfile(SECONDARY, PRIMARY, s.http, { crossAccount: true }); } catch (e) { caught = e; }
  assert(caught instanceof PrimaryProfileLinkError, String(caught));
  const e = caught as PrimaryProfileLinkError;
  assertEquals([e.profileSid, e.refused, e.permanent, e.status], [SECONDARY, false, false, 503]);
  assert(e.message.startsWith(PRIMARY_LINK_UNANSWERED), e.message);
  assert(!e.message.includes("refused"), `an unanswered link never says refused: ${e.message}`);
  assertEquals(s.calls.length, 2, "the read and the unanswered link, then nothing");
});

Deno.test("primaryProfileLinked is one GET; malformed SIDs are refused before any request", async () => {
  const s = profileStub({ linked: true, status: "draft" });
  assertEquals(await primaryProfileLinked(SECONDARY, PRIMARY, s.http), true);
  assertEquals(s.calls, [`GET /CustomerProfiles/${SECONDARY}/EntityAssignments?PageSize=50`]);
  const none = profileStub({ linked: false, status: "draft" });
  assertEquals(await primaryProfileLinked(SECONDARY, PRIMARY, none.http), false);
  let threw = false;
  try { await primaryProfileLinked("BUnope", PRIMARY, none.http); } catch { threw = true; }
  assert(threw && none.calls.length === 1, "a malformed SID never reaches Twilio");
});
