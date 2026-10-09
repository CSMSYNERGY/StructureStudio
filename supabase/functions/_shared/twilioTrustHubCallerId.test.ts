// twilioTrustHub.ts, the My Synergy Phone additions (plan §14 and phase 6):
//   * caller-ID trust — setupVoiceTrust (SHAKEN/STIR and Voice Integrity Trust Products),
//     fetchTrustProduct, fetchCustomerProfile, parseVoiceIntegrityInfo, trustProductStatus;
//   * the number helpers texting's ADOPTION of a calling-only number uses (portal-sms
//     buy_number) — attachNumberToService, numberInService, clearNumberSmsUrl,
//     findIncomingNumberSid.
//
// NOTHING HERE REACHES TWILIO. Every helper takes its transport as its last argument, and these
// tests hand it a stub that keeps Trust Hub's state the way Twilio does (profiles, trust
// products, their assignments, end users) and records every request: no network, no env and no
// throttle wait. The flow asserted is Twilio's two ISV guides, cited in the module. Fixtures are
// fake (SIDs of repeated digits, example.test).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  attachNumberToService,
  clearNumberSmsUrl,
  CNAM_INFO_REQUIRED,
  parseCnamDisplayName,
  POLICY_CNAM_TRUST_PRODUCT,
  fetchCustomerProfile,
  fetchTrustProduct,
  findIncomingNumberSid,
  numberInService,
  numberOnProfile,
  parseVoiceIntegrityInfo,
  POLICY_SHAKEN_STIR_TRUST_PRODUCT,
  POLICY_VOICE_INTEGRITY_TRUST_PRODUCT,
  setupVoiceTrust,
  TRUST_PRODUCT_STATUSES,
  TrustHubError,
  trustProductStatus,
  VOICE_INTEGRITY_INFO_REQUIRED,
  VOICE_INTEGRITY_USE_CASES,
  voiceTrustFriendlyName,
  type TrustHubHttp,
} from "./twilioTrustHub.ts";
// The two portal-settings pieces whose correctness depends on Twilio's rules (the single-flight
// claim and the fail-closed profile choice), driven here against the same stateful stub.
import { chooseTrustProfile, runTrustSetup } from "../portal-settings/phoneTrust.ts";

const PROFILE = "BU" + "1".repeat(32);
const NUMBER = "PN" + "2".repeat(32);
const SERVICE = "MG" + "3".repeat(32);
const ACCOUNT = "AC" + "4".repeat(32);

type Req = { method: string; path: string; query: Record<string, string>; form: Record<string, string> };
type Product = { sid: string; policy_sid: string; friendly_name: string; status: string; entities: string[]; numbers: string[] };
type EndUser = { sid: string; type: string; form: Record<string, string> };

// The two uniqueness rules the flow is built on, enforced the way Twilio would: a refusal, not
// a silent second copy (review BE-6: a stub that accepts anything cannot show a race or a wrong
// profile). HTTP 400 with code 0 — a STAND-IN: the real error codes are not documented, and
// nothing here matches on them.
//   * a number sits on ONE business profile (the module's own premise, numberOnProfile);
//   * a number sits on ONE Trust Product of a policy (a second SHAKEN/STIR product for the same
//     number is what two concurrent presses would make).
const STUB_RULE_CODE = 0;

function trustWorld(init: {
  /** Numbers already on PROFILE. */
  profileNumbers?: string[];
  /** Numbers already on OTHER business profiles (e.g. the platform's primary). */
  otherProfiles?: Record<string, string[]>;
  products?: Product[];
  endUsers?: EndUser[];
  fail?: (r: Req) => { status: number; code: number } | null;
} = {}) {
  const reqs: Req[] = [];
  const profiles: Record<string, string[]> = { [PROFILE]: [...(init.profileNumbers ?? [])] };
  for (const [k, v] of Object.entries(init.otherProfiles ?? {})) profiles[k] = [...v];
  const products: Product[] = (init.products ?? []).map((p) => ({ ...p, entities: [...p.entities], numbers: [...p.numbers] }));
  const endUsers: EndUser[] = (init.endUsers ?? []).map((e) => ({ ...e, form: { ...e.form } }));
  const endUserUpdates: { sid: string; form: Record<string, string> }[] = [];
  let seq = 0;
  const sid = (prefix: string) => prefix + (++seq).toString(16).padStart(32, "a");
  const notFound = () => new TrustHubError({ message: "Twilio refused (HTTP 404, code 20404).", status: 404, code: 20404, permanent: true });
  const rule = (what: string) => Promise.reject(new TrustHubError({ message: `Twilio refused: ${what} (HTTP 400, code ${STUB_RULE_CODE}).`, status: 400, code: STUB_RULE_CODE, permanent: true }));
  const http: TrustHubHttp = (method, url, form) => {
    const u = new URL(url);
    const r: Req = { method, path: u.pathname, query: Object.fromEntries(u.searchParams), form: form ?? {} };
    reqs.push(r);
    const f = init.fail?.(r);
    if (f) {
      return Promise.reject(new TrustHubError({ message: `Twilio refused ${method} ${u.pathname} (HTTP ${f.status}, code ${f.code}).`, status: f.status, code: f.code, permanent: false }));
    }
    const p = r.path.split("/").filter(Boolean); // ["v1", ...]
    const ok = (body: unknown) => Promise.resolve(body);
    if (p[1] === "CustomerProfiles" && p[3] === "ChannelEndpointAssignments") {
      const mine = (profiles[p[2]] ??= []);
      if (method === "GET") {
        return ok({ results: mine.filter((n) => !r.query.ChannelEndpointSid || n === r.query.ChannelEndpointSid).map((n) => ({ channel_endpoint_sid: n })) });
      }
      const n = r.form.ChannelEndpointSid;
      if (Object.values(profiles).some((list) => list.includes(n))) return rule("the number is already on a business profile");
      mine.push(n);
      return ok({ sid: sid("RA") });
    }
    if (p[1] === "CustomerProfiles" && p.length === 3) return ok({ sid: p[2], status: "twilio-approved", email: "owner@example.test" });
    if (p[1] === "TrustProducts" && p.length === 2) {
      if (method === "GET") {
        return ok({
          results: products.filter((t) => (!r.query.PolicySid || t.policy_sid === r.query.PolicySid)
            && (!r.query.FriendlyName || t.friendly_name === r.query.FriendlyName)),
        });
      }
      const t: Product = { sid: sid("BU"), policy_sid: r.form.PolicySid, friendly_name: r.form.FriendlyName, status: "draft", entities: [], numbers: [] };
      products.push(t);
      return ok({ ...t });
    }
    const t = p[1] === "TrustProducts" ? products.find((x) => x.sid === p[2]) : undefined;
    if (p[1] === "TrustProducts" && !t) return Promise.reject(notFound());
    if (t && p.length === 3) {
      if (method === "POST" && r.form.Status) t.status = r.form.Status;
      return ok({ ...t, errors: t.status === "twilio-rejected" ? [{ code: 22215, fields: ["business_name: Pat Example"] }] : null });
    }
    if (t && p[3] === "EntityAssignments") {
      if (method === "GET") return ok({ results: t.entities.map((o) => ({ object_sid: o })) });
      t.entities.push(r.form.ObjectSid);
      return ok({ sid: sid("BV") });
    }
    if (t && p[3] === "ChannelEndpointAssignments") {
      if (method === "GET") {
        return ok({ results: t.numbers.filter((n) => !r.query.ChannelEndpointSid || n === r.query.ChannelEndpointSid).map((n) => ({ channel_endpoint_sid: n })) });
      }
      const n = r.form.ChannelEndpointSid;
      if (products.some((x) => x.policy_sid === t.policy_sid && x.numbers.includes(n))) {
        return rule("the number is already on a Trust Product of this policy");
      }
      t.numbers.push(n);
      return ok({ sid: sid("RA") });
    }
    if (p[1] === "EndUsers" && p.length === 2 && method === "POST") {
      const e = { sid: sid("IT"), type: r.form.Type, form: { ...r.form } };
      endUsers.push(e);
      return ok({ sid: e.sid, type: r.form.Type });
    }
    if (p[1] === "EndUsers" && p.length === 3) {
      const e = endUsers.find((x) => x.sid === p[2]);
      if (!e) return Promise.reject(notFound());
      if (method === "POST") {
        // Update: FriendlyName / Attributes, each replaced only when sent.
        endUserUpdates.push({ sid: e.sid, form: { ...r.form } });
        if (r.form.FriendlyName !== undefined) e.form.FriendlyName = r.form.FriendlyName;
        if (r.form.Attributes !== undefined) e.form.Attributes = r.form.Attributes;
      }
      return ok({ sid: e.sid, type: e.type, friendly_name: e.form.FriendlyName ?? "", attributes: JSON.parse(e.form.Attributes ?? "{}") });
    }
    return Promise.reject(new Error(`stub: no route for ${method} ${r.path}`));
  };
  const writes = () => reqs.filter((q) => q.method !== "GET")
    .map((q) => `${q.method} ${q.path.replace(/[A-Z]{2}[0-9a-f]{32}/gi, (m) => m.slice(0, 2))}`);
  return { http, reqs, products, profiles, profileNumbers: profiles[PROFILE], endUsers, endUserUpdates, writes };
}

const VI = { useCase: "Customer Support" as const, employeeCount: 6, averageDailyCalls: 40, notes: "Quotes and deliveries" };
const base = (kind: "shaken_stir" | "voice_integrity") => ({
  kind, profileSid: PROFILE, numberSid: NUMBER, email: "owner@example.test",
  friendlyName: voiceTrustFriendlyName("demo-tenant", kind),
});
const product = (over: Partial<Product>): Product => ({
  sid: "BU" + "c".repeat(32), policy_sid: POLICY_SHAKEN_STIR_TRUST_PRODUCT, friendly_name: "demo-tenant — SHAKEN/STIR",
  status: "draft", entities: [], numbers: [], ...over,
});

Deno.test("caller ID: the policy SIDs are Twilio's published ones, and the names are '<client_id> — <product>'", () => {
  // From the two ISV guides ("Do not change the policy_sid ... a static value that will stay the
  // same across all accounts"). A typo here creates a Trust Product of the WRONG kind.
  assertEquals(POLICY_SHAKEN_STIR_TRUST_PRODUCT, "RN7a97559effdf62d00f4298208492a5ea");
  assertEquals(POLICY_VOICE_INTEGRITY_TRUST_PRODUCT, "RN5b3660f9598883b1df4e77f77acefba0");
  assertEquals(voiceTrustFriendlyName("demo-tenant", "shaken_stir"), "demo-tenant — SHAKEN/STIR");
  assertEquals(voiceTrustFriendlyName("demo-tenant", "voice_integrity"), "demo-tenant — Voice Integrity");
});

Deno.test("SHAKEN/STIR from nothing: number on the profile, product created, profile + number assigned, submitted — in Twilio's order", async () => {
  const w = trustWorld();
  const seen: string[] = [];
  const out = await setupVoiceTrust({ ...base("shaken_stir"), onTrustProduct: (s, st) => { seen.push(`${s}:${st}:${w.reqs.length}`); return Promise.resolve(); } }, w.http);
  assertEquals(w.writes(), [
    "POST /v1/CustomerProfiles/BU/ChannelEndpointAssignments", // only numbers on the profile are eligible
    "POST /v1/TrustProducts",
    "POST /v1/TrustProducts/BU/EntityAssignments",
    "POST /v1/TrustProducts/BU/ChannelEndpointAssignments",
    "POST /v1/TrustProducts/BU",
  ]);
  const created = w.reqs.find((r) => r.method === "POST" && r.path === "/v1/TrustProducts")!;
  assertEquals(created.form, { FriendlyName: "demo-tenant — SHAKEN/STIR", Email: "owner@example.test", PolicySid: POLICY_SHAKEN_STIR_TRUST_PRODUCT });
  const cea = w.reqs.filter((r) => r.method === "POST" && r.path.endsWith("/ChannelEndpointAssignments")).map((r) => r.form);
  assertEquals(cea, [
    { ChannelEndpointType: "phone-number", ChannelEndpointSid: NUMBER },
    { ChannelEndpointType: "phone-number", ChannelEndpointSid: NUMBER },
  ]);
  assertEquals(w.reqs.find((r) => r.path.endsWith("/EntityAssignments") && r.method === "POST")!.form, { ObjectSid: PROFILE });
  assertEquals(w.reqs.at(-1)!.form, { Status: "pending-review" });
  assertEquals([out.created, out.numberOnProfile, out.profileLinked, out.numberLinked, out.submitted, out.endUserCreated], [true, true, true, true, true, false]);
  assertEquals(out.status, "pending-review");
  // The SID was handed back right after the create — before any assignment — so the caller writes
  // it down first.
  const createdAt = w.reqs.findIndex((r) => r.method === "POST" && r.path === "/v1/TrustProducts") + 1;
  assertEquals(seen, [`${out.trustProductSid}:draft:${createdAt}`]);
  assert(!w.reqs.some((r) => /Evaluations|EndUsers/.test(r.path)), "the SHAKEN/STIR guide runs no Evaluation and needs no EndUser");
});

Deno.test("SHAKEN/STIR again: everything already done is read, not redone — and a product under review is never resubmitted", async () => {
  const w = trustWorld();
  const first = await setupVoiceTrust(base("shaken_stir"), w.http);
  const before = w.writes().length;
  const again = await setupVoiceTrust({ ...base("shaken_stir"), existingSid: first.trustProductSid }, w.http);
  assertEquals(w.writes().length, before, `a second press wrote: ${w.writes().slice(before).join(", ")}`);
  assertEquals([again.created, again.numberOnProfile, again.profileLinked, again.numberLinked, again.submitted], [false, false, false, false, false]);
  assertEquals(again.trustProductSid, first.trustProductSid);
  assertEquals(w.products.length, 1);
});

Deno.test("a lost response is reconciled by FriendlyName — never a second Trust Product", async () => {
  const lost = product({});
  const w = trustWorld({ profileNumbers: [NUMBER], products: [lost] });
  const out = await setupVoiceTrust(base("shaken_stir"), w.http); // no existingSid: the row never heard back
  assertEquals(out.trustProductSid, lost.sid);
  assertEquals(out.created, false);
  assertEquals(w.products.length, 1);
  assert(w.reqs.some((r) => r.query.FriendlyName === "demo-tenant — SHAKEN/STIR" && r.query.PolicySid === POLICY_SHAKEN_STIR_TRUST_PRODUCT));
  assertEquals(out.submitted, true, "a draft is submitted");
});

Deno.test("one made in the Console under the same profile is reused; another builder's is never read", async () => {
  const consoleMade = product({ sid: "BU" + "d".repeat(32), friendly_name: "Our pilot line", status: "twilio-approved", entities: [PROFILE] });
  const other = product({ sid: "BU" + "e".repeat(32), friendly_name: "other-tenant — SHAKEN/STIR", status: "twilio-approved", entities: ["BU" + "f".repeat(32)] });
  const w = trustWorld({ products: [other, consoleMade] });
  const out = await setupVoiceTrust(base("shaken_stir"), w.http);
  assertEquals(out.trustProductSid, consoleMade.sid);
  assertEquals([out.created, out.submitted, out.profileLinked, out.numberLinked], [false, false, false, true], "approved: the number joins it, nothing is resubmitted");
  assert(!w.reqs.some((r) => r.path === `/v1/TrustProducts/${other.sid}/EntityAssignments`), "another builder's product (our own naming) is skipped");
});

Deno.test("a recorded SID of the wrong kind, or one deleted in the Console, is not used", async () => {
  const vi = product({ sid: "BU" + "7".repeat(32), policy_sid: POLICY_VOICE_INTEGRITY_TRUST_PRODUCT, friendly_name: "demo-tenant — Voice Integrity" });
  const w = trustWorld({ products: [vi] });
  const out = await setupVoiceTrust({ ...base("shaken_stir"), existingSid: vi.sid }, w.http);
  assert(out.trustProductSid !== vi.sid && out.created);
  const gone = trustWorld();
  const out2 = await setupVoiceTrust({ ...base("shaken_stir"), existingSid: "BU" + "9".repeat(32) }, gone.http);
  assertEquals(out2.created, true, "a 404 on the recorded SID builds a fresh one");
});

Deno.test("a rejected product is resubmitted; a status outside Twilio's enum is left alone", async () => {
  const rejected = product({ sid: "BU" + "8".repeat(32), status: "twilio-rejected", entities: [PROFILE], numbers: [NUMBER] });
  const w = trustWorld({ profileNumbers: [NUMBER], products: [rejected] });
  const out = await setupVoiceTrust({ ...base("shaken_stir"), existingSid: rejected.sid }, w.http);
  assertEquals([out.submitted, out.status], [true, "pending-review"]);
  const odd = { ...rejected, status: "something-new" };
  const w2 = trustWorld({ profileNumbers: [NUMBER], products: [odd] });
  const out2 = await setupVoiceTrust({ ...base("shaken_stir"), existingSid: odd.sid }, w2.http);
  assertEquals([out2.submitted, out2.status], [false, null], "never guessed at");
});

Deno.test("Voice Integrity: the EndUser carries the guide's four attributes and is assigned before the profile", async () => {
  const w = trustWorld({ profileNumbers: [NUMBER] });
  const out = await setupVoiceTrust({ ...base("voice_integrity"), voiceIntegrity: VI }, w.http);
  assertEquals(w.writes(), [
    "POST /v1/TrustProducts",
    "POST /v1/EndUsers",
    "POST /v1/TrustProducts/BU/EntityAssignments",
    "POST /v1/TrustProducts/BU/EntityAssignments",
    "POST /v1/TrustProducts/BU/ChannelEndpointAssignments",
    "POST /v1/TrustProducts/BU",
  ]);
  assertEquals(w.reqs.find((r) => r.path === "/v1/TrustProducts" && r.method === "POST")!.form.PolicySid, POLICY_VOICE_INTEGRITY_TRUST_PRODUCT);
  const eu = w.endUsers[0].form;
  assertEquals(eu.Type, "voice_integrity_information");
  assertEquals(JSON.parse(eu.Attributes), {
    use_case: "Customer Support", business_employee_count: "6", average_business_day_call_volume: "40", notes: "Quotes and deliveries",
  });
  const assigned = w.reqs.filter((r) => r.path.endsWith("/EntityAssignments") && r.method === "POST").map((r) => r.form.ObjectSid);
  assertEquals(assigned, [w.endUsers[0].sid, PROFILE]);
  assertEquals(out.endUserCreated, true);
  // A second press finds the EndUser already on it and makes no other.
  await setupVoiceTrust({ ...base("voice_integrity"), existingSid: out.trustProductSid }, w.http);
  assertEquals(w.endUsers.length, 1);
});

Deno.test("Voice Integrity with no answers stops before its EndUser, with the product already handed back", async () => {
  const w = trustWorld({ profileNumbers: [NUMBER] });
  let recorded = "";
  let err: unknown = null;
  try {
    await setupVoiceTrust({ ...base("voice_integrity"), onTrustProduct: (s) => { recorded = s; return Promise.resolve(); } }, w.http);
  } catch (e) { err = e; }
  assert(err instanceof TrustHubError && err.message === VOICE_INTEGRITY_INFO_REQUIRED);
  assert(recorded.startsWith("BU"), "the created product was handed back first, so the retry reuses it");
  assert(!w.reqs.some((r) => r.form.Status), "nothing was submitted");
});

// ── Review BE-1: "Submit again" on a Voice Integrity product carries the operator's NEW answers ──
const VI_POLICY_PRODUCT = (over: Partial<Product>) => product({
  sid: "BU" + "8".repeat(32), policy_sid: POLICY_VOICE_INTEGRITY_TRUST_PRODUCT, friendly_name: "demo-tenant — Voice Integrity", ...over,
});
const IT_VI = "IT" + "5".repeat(32);
const IT_OTHER = "IT" + "6".repeat(32);
const OLD_ANSWERS = { use_case: "Customer Support", business_employee_count: "2", average_business_day_call_volume: "5", notes: "" };
const viEndUser = (sid = IT_VI): EndUser => ({ sid, type: "voice_integrity_information", form: { Type: "voice_integrity_information", Attributes: JSON.stringify(OLD_ANSWERS) } });
const FIXED = { useCase: "Phone System" as const, employeeCount: 12, averageDailyCalls: 80, notes: "Quotes and deliveries" };
const FIXED_ATTRS = { use_case: "Phone System", business_employee_count: "12", average_business_day_call_volume: "80", notes: "Quotes and deliveries" };

Deno.test("Voice Integrity, rejected, answers sent again: the EndUser gets the NEW answers BEFORE the product is resubmitted", async () => {
  const rejected = VI_POLICY_PRODUCT({ status: "twilio-rejected", entities: [IT_VI, PROFILE], numbers: [NUMBER] });
  const w = trustWorld({ profileNumbers: [NUMBER], products: [rejected], endUsers: [viEndUser()] });
  const out = await setupVoiceTrust({ ...base("voice_integrity"), existingSid: rejected.sid, voiceIntegrity: FIXED }, w.http);
  assertEquals(w.writes(), ["POST /v1/EndUsers/IT", "POST /v1/TrustProducts/BU"], "the correction, then the resubmit; nothing else");
  assertEquals(w.endUserUpdates.map((u) => u.sid), [IT_VI]);
  assertEquals(JSON.parse(w.endUsers[0].form.Attributes), FIXED_ATTRS, "what Twilio re-reviews is what the operator just answered");
  const updatedAt = w.reqs.findIndex((r) => r.method === "POST" && r.path === `/v1/EndUsers/${IT_VI}`);
  const submittedAt = w.reqs.findIndex((r) => r.method === "POST" && r.form.Status === "pending-review");
  assert(updatedAt >= 0 && updatedAt < submittedAt, `updated at ${updatedAt}, submitted at ${submittedAt}`);
  assertEquals([out.endUserUpdated, out.endUserCreated, out.submitted, out.status], [true, false, true, "pending-review"]);
  assertEquals(w.endUsers.length, 1, "corrected in place, never a second EndUser");
});

Deno.test("Voice Integrity, draft with its EndUser: new answers are written before the first submit too", async () => {
  const draft = VI_POLICY_PRODUCT({ status: "draft", entities: [IT_VI, PROFILE], numbers: [NUMBER] });
  const w = trustWorld({ profileNumbers: [NUMBER], products: [draft], endUsers: [viEndUser()] });
  const out = await setupVoiceTrust({ ...base("voice_integrity"), voiceIntegrity: FIXED }, w.http); // found by FriendlyName
  assertEquals(JSON.parse(w.endUsers[0].form.Attributes), FIXED_ATTRS);
  assertEquals([out.endUserUpdated, out.submitted], [true, true]);
});

Deno.test("Voice Integrity under review or approved: answers change NOTHING and nothing is sent", async () => {
  for (const status of ["pending-review", "in-review", "twilio-approved"]) {
    const p = VI_POLICY_PRODUCT({ status, entities: [IT_VI, PROFILE], numbers: [NUMBER] });
    const w = trustWorld({ profileNumbers: [NUMBER], products: [p], endUsers: [viEndUser()] });
    const out = await setupVoiceTrust({ ...base("voice_integrity"), existingSid: p.sid, voiceIntegrity: FIXED }, w.http);
    assertEquals(w.writes(), [], `${status}: wrote ${w.writes().join(", ")}`);
    assertEquals(JSON.parse(w.endUsers[0].form.Attributes), OLD_ANSWERS, status);
    assertEquals([out.endUserUpdated, out.submitted], [false, false], status);
  }
});

Deno.test("Voice Integrity correction: only the voice_integrity_information EndUser is touched; with none of that type one is made", async () => {
  const other: EndUser = { sid: IT_OTHER, type: "authorized_representative_1", form: { Type: "authorized_representative_1", Attributes: JSON.stringify({ first_name: "Pat" }) } };
  const both = VI_POLICY_PRODUCT({ status: "twilio-rejected", entities: [IT_OTHER, IT_VI, PROFILE], numbers: [NUMBER] });
  const w = trustWorld({ profileNumbers: [NUMBER], products: [both], endUsers: [other, viEndUser()] });
  await setupVoiceTrust({ ...base("voice_integrity"), existingSid: both.sid, voiceIntegrity: FIXED }, w.http);
  assertEquals(w.endUserUpdates.map((u) => u.sid), [IT_VI]);
  assertEquals(JSON.parse(w.endUsers[0].form.Attributes), { first_name: "Pat" }, "another kind of EndUser is never overwritten");

  const wrongKind = VI_POLICY_PRODUCT({ status: "twilio-rejected", entities: [IT_OTHER, PROFILE], numbers: [NUMBER] });
  const w2 = trustWorld({ profileNumbers: [NUMBER], products: [wrongKind], endUsers: [other] });
  const out2 = await setupVoiceTrust({ ...base("voice_integrity"), existingSid: wrongKind.sid, voiceIntegrity: FIXED }, w2.http);
  assertEquals(w2.writes(), ["POST /v1/EndUsers", "POST /v1/TrustProducts/BU/EntityAssignments", "POST /v1/TrustProducts/BU"]);
  assertEquals([out2.endUserCreated, out2.endUserUpdated, out2.submitted], [true, false, true]);
  assertEquals(w2.endUserUpdates.length, 0);
});

Deno.test("Voice Integrity, rejected, NO answers sent: resubmitted as it stands (the Console-fix path), no EndUser read", async () => {
  const rejected = VI_POLICY_PRODUCT({ status: "twilio-rejected", entities: [IT_VI, PROFILE], numbers: [NUMBER] });
  const w = trustWorld({ profileNumbers: [NUMBER], products: [rejected], endUsers: [viEndUser()] });
  const out = await setupVoiceTrust({ ...base("voice_integrity"), existingSid: rejected.sid }, w.http);
  assertEquals(w.writes(), ["POST /v1/TrustProducts/BU"]);
  assert(!w.reqs.some((r) => r.path.startsWith("/v1/EndUsers")));
  assertEquals([out.submitted, out.endUserUpdated], [true, false]);
});

// ── The stub keeps Twilio's uniqueness rules (review BE-6), so the flow can be shown to fail ─────
Deno.test("the stub refuses a number on a SECOND business profile, and a second Trust Product of one policy", async () => {
  const PRIMARY = "BU" + "0".repeat(32);
  const w = trustWorld({ otherProfiles: { [PRIMARY]: [NUMBER] } });
  let err: unknown = null;
  try { await setupVoiceTrust(base("shaken_stir"), w.http); } catch (e) { err = e; }
  assert(err instanceof TrustHubError && err.status === 400, "assigning a number already on the primary to the secondary is refused");
  assertEquals(w.products.length, 0, "and it stopped at step 1: no Trust Product");

  const first = product({ sid: "BU" + "d".repeat(32), friendly_name: "Our pilot line", status: "twilio-approved", entities: ["BU" + "f".repeat(32)], numbers: [NUMBER] });
  const w2 = trustWorld({ profileNumbers: [NUMBER], products: [first] });
  let err2: unknown = null;
  try { await setupVoiceTrust(base("shaken_stir"), w2.http); } catch (e) { err2 = e; }
  assert(err2 instanceof TrustHubError && err2.status === 400, "the number is on another SHAKEN/STIR product already");
  assert(!w2.reqs.some((r) => r.form.Status), "not submitted");
});

// ── Review BE-2 end to end: two presses at once, through runTrustSetup, against the stub ───────
function memoryLock() {
  let held = false;
  const lock = {
    claim: () => {
      // One synchronous step, like the single conditional UPDATE it stands for.
      if (held) return Promise.resolve({ ok: false as const, busy: true as const });
      held = true;
      return Promise.resolve({ ok: true as const });
    },
    release: () => { held = false; return Promise.resolve(); },
  };
  return lock;
}

Deno.test("two presses at once make ONE SHAKEN/STIR product: the second is refused 409 while the first holds the number", async () => {
  const w = trustWorld({ profileNumbers: [NUMBER] });
  const lock = memoryLock();
  const rows: Record<string, unknown>[] = [];
  const press = () => runTrustSetup(
    { kind: "shaken_stir", clientId: "demo-tenant", numberSid: NUMBER, profileSid: PROFILE, existingSid: null, info: null },
    {
      lock,
      fetchProfile: (sid) => fetchCustomerProfile(sid, w.http),
      setup: (s) => setupVoiceTrust(s, w.http),
      write: (patch) => { rows.push(patch); return Promise.resolve({ ok: true as const }); },
    },
  );
  const [a, b] = await Promise.all([press(), press()]);
  assertEquals(w.products.length, 1, `made ${w.products.length} Trust Products`);
  const outcomes = [a, b].map((o) => (o.ok ? "ok" : `${o.kind}:${o.kind === "refused" ? o.status : ""}`)).sort();
  assertEquals(outcomes, ["ok", "refused:409"]);
  assert(rows.every((r) => r.shaken_trust_product_sid === w.products[0].sid), "only the one product is ever written to the row");
  // Released: the next press goes through and reuses it.
  const again = await press();
  assert(again.ok && again.result.trustProductSid === w.products[0].sid && !again.result.created);
});

// ── Review BE-4 end to end: an internal tenant's number on the primary, and the read failing ──
Deno.test("internal tenant, number on the primary: the choice follows Twilio; a failed read sends NOTHING", async () => {
  const PRIMARY = "BU" + "0".repeat(32);
  const onPrimary = trustWorld({ otherProfiles: { [PRIMARY]: [NUMBER] } });
  const chosen = await chooseTrustProfile(
    { secondaryProfileSid: PROFILE, internal: true, primaryProfileSid: PRIMARY, numberSid: NUMBER },
    { numberOnProfile: (p, n) => numberOnProfile(p, n, onPrimary.http) },
  );
  assert(chosen.ok && chosen.which === "primary");
  const out = await setupVoiceTrust({ ...base("shaken_stir"), profileSid: chosen.ok ? chosen.profileSid : "" }, onPrimary.http);
  assert(out.submitted && !out.numberOnProfile, "the number stays where it is and the product is built on the primary");

  const down = trustWorld({
    otherProfiles: { [PRIMARY]: [NUMBER] },
    fail: (r) => (r.method === "GET" && r.path.includes(`/CustomerProfiles/${PRIMARY}/`) ? { status: 503, code: 0 } : null),
  });
  const refused = await chooseTrustProfile(
    { secondaryProfileSid: PROFILE, internal: true, primaryProfileSid: PRIMARY, numberSid: NUMBER },
    { numberOnProfile: (p, n) => numberOnProfile(p, n, down.http) },
  );
  assert(!refused.ok && refused.kind === "twilio" && refused.status === 502, JSON.stringify(refused));
  assertEquals(down.writes(), [], "no guess: nothing is assigned to the secondary");
});

Deno.test("a Twilio refusal stops the flow where it happened, and bad input never reaches Twilio", async () => {
  const w = trustWorld({
    fail: (r) => (r.method === "POST" && r.path.startsWith("/v1/TrustProducts/") && r.path.endsWith("/ChannelEndpointAssignments") ? { status: 400, code: 22210 } : null),
  });
  let err: unknown = null;
  try { await setupVoiceTrust(base("shaken_stir"), w.http); } catch (e) { err = e; }
  assert(err instanceof TrustHubError && err.code === 22210);
  assert(!w.reqs.some((r) => r.form.Status), "not submitted after a failed step");
  for (const bad of [{ profileSid: "BUshort" }, { numberSid: "XX" + "2".repeat(32) }, { email: "" }]) {
    const w2 = trustWorld();
    let e2: unknown = null;
    try { await setupVoiceTrust({ ...base("shaken_stir"), ...bad }, w2.http); } catch (e) { e2 = e; }
    assert(e2 instanceof TrustHubError && e2.status === 400, JSON.stringify(bad));
    assertEquals(w2.reqs.length, 0, `${JSON.stringify(bad)} reached Twilio`);
  }
});

Deno.test("fetchTrustProduct gives Twilio's status and rejection CODES only; fetchCustomerProfile its status and email", async () => {
  const t = product({ sid: "BU" + "6".repeat(32), friendly_name: "x", status: "twilio-rejected" });
  const w = trustWorld({ products: [t] });
  const got = await fetchTrustProduct(t.sid, w.http);
  assertEquals(got, { status: "twilio-rejected", policySid: POLICY_SHAKEN_STIR_TRUST_PRODUCT, errorCodes: [22215] });
  assert(!JSON.stringify(got).includes("Pat Example"), "no field text from Twilio's error objects");
  assertEquals(await fetchCustomerProfile(PROFILE, w.http), { status: "twilio-approved", email: "owner@example.test" });
});

Deno.test("numberOnProfile reads the profile's assignments for that number only", async () => {
  const w = trustWorld({ profileNumbers: ["PN" + "9".repeat(32)] });
  assertEquals(await numberOnProfile(PROFILE, NUMBER, w.http), false);
  assertEquals(w.reqs[0].query, { ChannelEndpointSid: NUMBER, PageSize: "20" });
  const w2 = trustWorld({ profileNumbers: [NUMBER] });
  assertEquals(await numberOnProfile(PROFILE, NUMBER, w2.http), true);
  assert(w.reqs.every((r) => r.method === "GET"), "a read, nothing else");
});

Deno.test("trustProductStatus keeps Twilio's enum and nothing else", () => {
  assertEquals([...TRUST_PRODUCT_STATUSES], ["draft", "pending-review", "in-review", "twilio-rejected", "twilio-approved"]);
  assertEquals(trustProductStatus("TWILIO-APPROVED"), "twilio-approved");
  assertEquals(trustProductStatus("approved"), null);
  assertEquals(trustProductStatus(undefined), null);
});

Deno.test("parseVoiceIntegrityInfo: one of Twilio's use cases, whole positive counts, short notes", () => {
  const good = parseVoiceIntegrityInfo({ useCase: "Phone System", employeeCount: "12", averageDailyCalls: "1,200", notes: "  quotes \n and deliveries " });
  assertEquals(good, { ok: true, info: { useCase: "Phone System", employeeCount: 12, averageDailyCalls: 1200, notes: "quotes and deliveries" } });
  assert(VOICE_INTEGRITY_USE_CASES.length === 45 && VOICE_INTEGRITY_USE_CASES.includes("Customer Support"));
  for (const bad of [
    { useCase: "Sheds", employeeCount: 3, averageDailyCalls: 3 },
    { useCase: "Customer Support", employeeCount: 0, averageDailyCalls: 3 },
    { useCase: "Customer Support", employeeCount: 2.5, averageDailyCalls: 3 },
    { useCase: "Customer Support", employeeCount: 3, averageDailyCalls: "" },
    null,
  ]) assert(!parseVoiceIntegrityInfo(bad).ok, JSON.stringify(bad));
  const long = parseVoiceIntegrityInfo({ useCase: "Customer Support", employeeCount: 1, averageDailyCalls: 1, notes: "x".repeat(900) });
  assert(long.ok && long.info.notes.length === 500);
});

// ── The number helpers the texting ADOPTION uses (portal-sms buy_number, My Synergy Phone phase 6) ───
Deno.test("attachNumberToService / numberInService / clearNumberSmsUrl / findIncomingNumberSid speak the Messaging and numbers APIs", async () => {
  const seen: { method: string; url: string; form?: Record<string, string> }[] = [];
  let attached = false;
  const http: TrustHubHttp = (method, url, form) => {
    seen.push({ method, url, form });
    if (url.includes("/PhoneNumbers/")) {
      return attached ? Promise.resolve({ sid: NUMBER }) : Promise.reject(new TrustHubError({ message: "404", status: 404, code: 20404, permanent: true }));
    }
    if (url.endsWith("/PhoneNumbers")) { attached = true; return Promise.resolve({ sid: NUMBER }); }
    if (url.includes("IncomingPhoneNumbers.json?")) return Promise.resolve({ incoming_phone_numbers: [{ sid: NUMBER, phone_number: "+15555550142" }] });
    return Promise.resolve({ sid: NUMBER });
  };
  assertEquals(await numberInService(SERVICE, NUMBER, http), false, "a 404 is 'not in the service', not an error");
  await attachNumberToService(SERVICE, NUMBER, http);
  assertEquals(await numberInService(SERVICE, NUMBER, http), true);
  await clearNumberSmsUrl(NUMBER, http, ACCOUNT);
  assertEquals(await findIncomingNumberSid("+15555550142", http, ACCOUNT), NUMBER);
  assertEquals(await findIncomingNumberSid("+15555550199", http, ACCOUNT), null);
  assertEquals(seen.map((s) => `${s.method} ${s.url.replace(/[A-Z]{2}[0-9a-f]{32}/gi, (m) => m.slice(0, 2))}`), [
    "GET https://messaging.twilio.com/v1/Services/MG/PhoneNumbers/PN",
    "POST https://messaging.twilio.com/v1/Services/MG/PhoneNumbers",
    "GET https://messaging.twilio.com/v1/Services/MG/PhoneNumbers/PN",
    "POST https://api.twilio.com/2010-04-01/Accounts/AC/IncomingPhoneNumbers/PN.json",
    "GET https://api.twilio.com/2010-04-01/Accounts/AC/IncomingPhoneNumbers.json?PhoneNumber=%2B15555550142&PageSize=5",
    "GET https://api.twilio.com/2010-04-01/Accounts/AC/IncomingPhoneNumbers.json?PhoneNumber=%2B15555550199&PageSize=5",
  ]);
  assertEquals(seen[1].form, { PhoneNumberSid: NUMBER });
  assertEquals(seen[3].form, { SmsUrl: "" }, "Twilio clears a URL given as an empty string");
  // Anything else from the Messaging API is a real fault, not "not attached".
  const down: TrustHubHttp = () => Promise.reject(new TrustHubError({ message: "503", status: 503, code: 0, permanent: false }));
  let err: unknown = null;
  try { await numberInService(SERVICE, NUMBER, down); } catch (e) { err = e; }
  assert(err instanceof TrustHubError && err.status === 503);
  // Malformed SIDs never reach Twilio.
  const none: TrustHubHttp = () => Promise.reject(new Error("must not be called"));
  for (const f of [
    () => attachNumberToService("MG1", NUMBER, none),
    () => numberInService(SERVICE, "PNx", none),
    () => clearNumberSmsUrl("PNx", none, ACCOUNT),
    () => findIncomingNumberSid("+15555550142", none, null),
  ]) {
    let e2: unknown = null;
    try { await f(); } catch (e) { e2 = e; }
    assert(e2 instanceof TrustHubError && e2.status === 400);
  }
});

// ── CNAM (Workstream 2, phase 6) ─────────────────────────────────────────────────────────────
// "Brand your calls using CNAM": the SHAKEN/STIR steps plus one EndUser of type cnam_information
// carrying cnam_display_name, assigned before the profile, under Twilio's CNAM policy.
const cnamBase = () => ({
  kind: "cnam" as const, profileSid: PROFILE, numberSid: NUMBER, email: "owner@example.test",
  friendlyName: voiceTrustFriendlyName("demo-tenant", "cnam"),
});

Deno.test("CNAM: Twilio's policy, its EndUser with the display name, assigned before the profile, then submitted", async () => {
  assertEquals(POLICY_CNAM_TRUST_PRODUCT, "RNf3db3cd1fe25fcfd3c3ded065c8fea53");
  assertEquals(voiceTrustFriendlyName("demo-tenant", "cnam"), "demo-tenant — CNAM");
  const w = trustWorld({ profileNumbers: [NUMBER] });
  const out = await setupVoiceTrust({ ...cnamBase(), cnam: { displayName: "Demo Barns" } }, w.http);
  assertEquals(w.writes(), [
    "POST /v1/TrustProducts",
    "POST /v1/EndUsers",
    "POST /v1/TrustProducts/BU/EntityAssignments",
    "POST /v1/TrustProducts/BU/EntityAssignments",
    "POST /v1/TrustProducts/BU/ChannelEndpointAssignments",
    "POST /v1/TrustProducts/BU",
  ]);
  assertEquals(w.reqs.find((r) => r.path === "/v1/TrustProducts" && r.method === "POST")!.form,
    { FriendlyName: "demo-tenant — CNAM", Email: "owner@example.test", PolicySid: POLICY_CNAM_TRUST_PRODUCT });
  assertEquals(w.endUsers[0].form.Type, "cnam_information");
  assertEquals(w.endUsers[0].form.FriendlyName, "demo-tenant — CNAM display name");
  assertEquals(JSON.parse(w.endUsers[0].form.Attributes), { cnam_display_name: "Demo Barns" });
  const assigned = w.reqs.filter((r) => r.path.endsWith("/EntityAssignments") && r.method === "POST").map((r) => r.form.ObjectSid);
  assertEquals(assigned, [w.endUsers[0].sid, PROFILE]);
  assertEquals([out.created, out.endUserCreated, out.submitted, out.status], [true, true, true, "pending-review"]);
  assert(!w.reqs.some((r) => /Evaluations/.test(r.path)), "the CNAM guide runs no Evaluation");
});

Deno.test("CNAM with no name stops before its EndUser; a rejected one is resubmitted with the NEW name on its EndUser", async () => {
  const w = trustWorld({ profileNumbers: [NUMBER] });
  let caught: unknown = null;
  try { await setupVoiceTrust(cnamBase(), w.http); } catch (e) { caught = e; }
  assert(caught instanceof TrustHubError && caught.message === CNAM_INFO_REQUIRED, String(caught));
  assertEquals(w.endUsers.length, 0);
  // Rejected (the name, say), the operator sends a corrected one: the SAME EndUser is updated, not a second.
  const made = w.products[0];
  const first = trustWorld({ profileNumbers: [NUMBER] });
  const out = await setupVoiceTrust({ ...cnamBase(), cnam: { displayName: "Demo Barns" } }, first.http);
  first.products[0].status = "twilio-rejected";
  const again = await setupVoiceTrust({ ...cnamBase(), existingSid: out.trustProductSid, cnam: { displayName: "Demo Barns LLC" } }, first.http);
  assertEquals(first.endUsers.length, 1);
  assertEquals(first.endUserUpdates.map((u) => JSON.parse(u.form.Attributes)), [{ cnam_display_name: "Demo Barns LLC" }]);
  assertEquals([again.endUserUpdated, again.submitted, again.status], [true, true, "pending-review"]);
  assert(made && made.policy_sid === POLICY_CNAM_TRUST_PRODUCT, "the product was handed back before the refusal");
});

Deno.test("parseCnamDisplayName: Twilio's rules, checked before anything is sent", () => {
  assertEquals(parseCnamDisplayName("  Demo   Barns  "), { ok: true, name: "Demo Barns" });
  assertEquals(parseCnamDisplayName("J.R. Sheds, LLC"), { ok: true, name: "J.R. Sheds, LLC" });
  for (const bad of ["", "   ", "Sixteen chars xx", "9 Barns", "Barns & Sheds", "Barns!", "Bärns"]) {
    const r = parseCnamDisplayName(bad);
    assert(!r.ok, `accepted ${JSON.stringify(bad)}`);
  }
});

// The default transport is the module's own `call` (credentials, TrustHubError). Driven once with
// a stubbed fetch, so the composed request — URL, method, Basic auth from the API key pair — is
// proven without a network. Needs --allow-env (the credentials); ignored, not passed, without it.
const ENV_OK = Deno.permissions.querySync({ name: "env" }).state === "granted";
Deno.test({ name: "the default transport sends the Trust Hub request with the API key pair (stubbed fetch)", ignore: !ENV_OK, fn: async () => {
  const had = { sid: Deno.env.get("TWILIO_ACCOUNT_SID"), key: Deno.env.get("TWILIO_API_KEY"), secret: Deno.env.get("TWILIO_API_SECRET") };
  const realFetch = globalThis.fetch;
  const seen: { url: string; init?: RequestInit }[] = [];
  Deno.env.set("TWILIO_ACCOUNT_SID", ACCOUNT);
  Deno.env.set("TWILIO_API_KEY", "SK" + "5".repeat(32));
  Deno.env.set("TWILIO_API_SECRET", "not-a-real-secret");
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return Promise.resolve(new Response(JSON.stringify({ sid: PROFILE, status: "in-review", email: "owner@example.test" }), { status: 200 }));
  }) as typeof fetch;
  try {
    assertEquals(await fetchCustomerProfile(PROFILE), { status: "in-review", email: "owner@example.test" });
    assertEquals(seen.length, 1);
    assertEquals(seen[0].url, `https://trusthub.twilio.com/v1/CustomerProfiles/${PROFILE}`);
    assertEquals(seen[0].init?.method, "GET");
    assertEquals((seen[0].init?.headers as Record<string, string>).Authorization, `Basic ${btoa(`SK${"5".repeat(32)}:not-a-real-secret`)}`);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["TWILIO_ACCOUNT_SID", had.sid], ["TWILIO_API_KEY", had.key], ["TWILIO_API_SECRET", had.secret]] as const) {
      if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    }
  }
} });
