// Workstream 2, phase 6: the operator's A2P spike (scripts/twilio-a2p-spike.ts).
//
// What is pinned:
//   * without --create it is GET-only: no Twilio write, no create function called, and it still
//     prints where the spike stands, what --create would do next and what that costs;
//   * the cost is printed BEFORE anything is done, and --create without --yes-i-approve-the-cost
//     does nothing;
//   * it refuses a tenant without an ACTIVE sub-account of its own (the parent, a pinned or
//     internal tenant, a sub being set up), the parent's own SID, and a tenant whose texting
//     registration already holds anything at Twilio, before any Twilio request;
//   * the steps run in order and stop where Twilio has to answer first (the brand's review); a
//     campaign is only the LOW_VOLUME one ($1.50 a month), and a refused cross-account link stops
//     the run before anything billed;
//   * nothing it prints carries a whole SID;
//   * its live database reads are GETs (PostgREST, the service role key).
// No network: every dependency is a stub. Every SID below is made up.
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/a2pSpike_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  APPROVAL_FLAG, liveDeps, mask, parseArgs, runSpike, SPIKE_COST_CENTS, SPIKE_USE_CASE, spikeNames, spikePlan,
  type SpikeDeps, type SpikeState,
} from "../../scripts/twilio-a2p-spike.ts";
import { PrimaryProfileLinkError, TrustHubError } from "../../supabase/functions/_shared/twilioTrustHub.ts";

const TENANT = "spike-test-builder";
const PARENT = "AC" + "0".repeat(32);
const SUB = "AC" + "7".repeat(32);
const PRIMARY = "BU" + "0".repeat(32);
const PROFILE = "BU" + "7".repeat(32);
const A2P = "BU" + "8".repeat(32);
const BRAND = "BN" + "7".repeat(32);
const SERVICE = "MG" + "7".repeat(32);
const CAMPAIGN = "QE" + "7".repeat(32);
const SUB_TOKEN = "subauthtoken" + "q".repeat(20);
const ALL_SIDS = [PARENT, SUB, PRIMARY, PROFILE, A2P, BRAND, SERVICE, CAMPAIGN, SUB_TOKEN];

const INPUT = {
  intake: {
    legalBusinessName: "Example Spike Builder LLC", ein: "12-3456789", businessType: "Limited Liability Corporation",
    businessIndustry: "CONSTRUCTION", websiteUrl: "https://builder.example.test", street: "1 Test Way", city: "Testville",
    region: "MO", postalCode: "64101", isoCountry: "US", repFirstName: "Pat", repLastName: "Example",
    repEmail: "pat@builder.example.test", repPhone: "+15555550100", repBusinessTitle: "Owner", repJobPosition: "CEO",
  },
  copy: {
    description: "Example Spike Builder texts customers about their building orders, deliveries and appointments.",
    messageFlow: "Customers agree to texts by ticking an unticked box on the estimate form at builder.example.test before they submit it.",
    messageSamples: [
      "Example Spike Builder: your shed delivery is booked for Tuesday. Reply STOP to opt out.",
      "Example Spike Builder: your estimate is ready to review. Reply STOP to opt out.",
    ],
  },
  privacyPolicyUrl: "https://builder.example.test/privacy", termsUrl: "https://builder.example.test/terms",
};

type World = {
  creds: Record<string, unknown> | null; internal: boolean; registration: Record<string, unknown> | null;
  profile: boolean; linked: boolean; a2p: boolean; brand: string | null; service: boolean; campaign: boolean;
  useCases: string[]; refuseLink?: boolean;
};

function harness(over: Partial<World> = {}) {
  const w: World = {
    creds: { client_id: TENANT, kind: "sub", status: "active", account_sid: SUB, auth_token: SUB_TOKEN, api_key_sid: null, api_secret: null },
    internal: false, registration: { status: "none" },
    profile: false, linked: false, a2p: false, brand: null, service: false, campaign: false, useCases: [SPIKE_USE_CASE, "MIXED"],
    ...over,
  };
  const lines: string[] = [];
  const twilio: string[] = [];
  const acts: string[] = [];
  const names = spikeNames(TENANT);
  const deps: SpikeDeps = {
    env: (k) => ({ TWILIO_ACCOUNT_SID: PARENT, TWILIO_PRIMARY_PROFILE_SID: PRIMARY } as Record<string, string>)[k],
    readJson: () => Promise.resolve(INPUT),
    db: {
      creds: () => Promise.resolve(w.creds),
      internal: () => Promise.resolve(w.internal),
      registration: () => Promise.resolve(w.registration),
    },
    http: (creds) => (method, url) => {
      twilio.push(`${method} ${url}`);
      assertEquals(creds.accountSid, SUB, "every Twilio request runs in the sub");
      assertEquals([creds.user, creds.pass], [SUB, SUB_TOKEN], "the sub's own SID and auth token (no API key in this world)");
      if (method !== "GET") throw new Error("the stub transport takes reads only; writes go through act");
      if (url.includes("/CustomerProfiles?")) return Promise.resolve({ results: w.profile ? [{ sid: PROFILE, friendly_name: names.profile, status: "pending-review" }] : [] });
      if (url.includes("/EntityAssignments")) return Promise.resolve({ results: w.linked ? [{ object_sid: PRIMARY }] : [] });
      if (url.includes("/TrustProducts?")) return Promise.resolve({ results: w.a2p ? [{ sid: A2P, friendly_name: names.a2p }] : [] });
      if (url.includes("/BrandRegistrations")) return Promise.resolve({ data: w.brand ? [{ sid: BRAND, customer_profile_bundle_sid: PROFILE, status: w.brand }] : [] });
      if (url.includes("/Services?")) return Promise.resolve({ services: w.service ? [{ sid: SERVICE, friendly_name: names.service }] : [] });
      return Promise.reject(new Error(`unexpected ${url}`));
    },
    act: {
      createProfile: (o) => {
        acts.push(`createProfile ${o.friendlyName} ${o.primaryProfileSid === PRIMARY}`);
        if (w.refuseLink) {
          return Promise.reject(new PrimaryProfileLinkError(new TrustHubError({ message: "x", status: 403, code: 20403, permanent: true }), PROFILE, true));
        }
        w.profile = true; w.linked = true;
        return Promise.resolve({ profileSid: PROFILE });
      },
      finishProfile: () => { acts.push("finishProfile"); w.linked = true; return Promise.resolve({ linked: true, submitted: false, status: "pending-review" }); },
      createA2p: (o) => { acts.push(`createA2p ${o.profileSid === PROFILE}`); w.a2p = true; return Promise.resolve({ a2pProfileSid: A2P }); },
      registerBrand: (o) => { acts.push(`registerBrand ${o.tier}`); w.brand = "PENDING"; return Promise.resolve({ brandSid: BRAND, status: "PENDING" }); },
      createService: () => { acts.push("createService"); w.service = true; return Promise.resolve({ serviceSid: SERVICE }); },
      useCases: () => { acts.push("useCases"); return Promise.resolve(w.useCases.map((code) => ({ code }))); },
      createCampaign: (o) => { acts.push(`createCampaign ${o.useCase}`); w.campaign = true; return Promise.resolve({ campaignSid: CAMPAIGN, status: "IN_PROGRESS" }); },
      fetchCampaign: () => Promise.resolve(w.campaign ? { sid: CAMPAIGN, status: "IN_PROGRESS" } : { sid: null, status: "" }),
    },
    out: (l) => lines.push(l),
  };
  const writes = () => acts.filter((a) => a !== "useCases");
  return { w, deps, lines, twilio, acts, writes, text: () => lines.join("\n") };
}

const leaksNoSid = (text: string) => {
  for (const s of ALL_SIDS) assert(!text.includes(s), `a whole SID or token was printed: ${mask(s)}`);
};

Deno.test("parseArgs: a tenant is required; the approval goes only with --create; --create needs an --intake file", () => {
  assert("error" in parseArgs([]));
  assert("error" in parseArgs(["--tenant", "Bad Slug"]));
  assert("error" in parseArgs(["--tenant", TENANT, APPROVAL_FLAG]));
  assert("error" in parseArgs(["--tenant", TENANT, "--create"]));
  assert("error" in parseArgs(["--tenant", TENANT, "--spend"]));
  assertEquals(parseArgs(["--tenant", TENANT]), { tenant: TENANT, create: false, approved: false, intakePath: null, help: false });
});

Deno.test("without --create: GETs only, nothing made, and the next steps and their cost are printed", async () => {
  const h = harness();
  assertEquals(await runSpike(["--tenant", TENANT], h.deps), 0);
  assertEquals(h.writes(), [], "no create function was called");
  assert(h.twilio.length > 0 && h.twilio.every((t) => t.startsWith("GET ")), h.twilio.join(" | "));
  const t = h.text();
  assert(/THIS RUN WOULD COST: \$4\.50 once/.test(t), t);
  assert(/whole spike: \$19\.50 once \+ \$1\.50 a month/.test(t), t);
  assert(/campaign comes after the brand is approved/.test(t), t);
  leaksNoSid(t);
});

Deno.test("refused before any Twilio request: no sub, a sub not active, the parent's SID, an internal account, a real registration", async () => {
  const cases: Array<[string, Partial<World>, RegExp]> = [
    ["no row", { creds: null }, /no sub-account of its own/],
    ["a parent pin", { creds: { kind: "parent", status: "active", account_sid: null } }, /no sub-account of its own/],
    ["provisioning", { creds: { kind: "sub", status: "provisioning", account_sid: SUB, auth_token: SUB_TOKEN } }, /not active/],
    ["the parent's SID", { creds: { kind: "sub", status: "active", account_sid: PARENT, auth_token: SUB_TOKEN } }, /never runs on the parent/],
    ["no token", { creds: { kind: "sub", status: "active", account_sid: SUB, auth_token: null } }, /no auth token/],
    ["internal", { internal: true }, /internal account/],
    ["a real registration", { registration: { status: "brand_pending", customer_profile_sid: PROFILE, brand_sid: BRAND } }, /already holds customer_profile_sid, brand_sid/],
  ];
  for (const [what, over, why] of cases) {
    const h = harness(over);
    assertEquals(await runSpike(["--tenant", TENANT, "--create", "--intake", "x.json", APPROVAL_FLAG], h.deps), 2, what);
    assert(why.test(h.text()), `${what}: ${h.text()}`);
    assertEquals([h.twilio.length, h.acts.length], [0, 0], `${what}: nothing asked of Twilio`);
  }
});

Deno.test("--create without the approval flag prints the cost and does nothing", async () => {
  const h = harness();
  assertEquals(await runSpike(["--tenant", TENANT, "--create", "--intake", "x.json"], h.deps), 2);
  assertEquals(h.writes(), []);
  assert(new RegExp(`run it again with ${APPROVAL_FLAG}`).test(h.text()), h.text());
});

Deno.test("--create with approval: the free steps and the brand, in order, after the cost; the campaign waits for the brand", async () => {
  const h = harness();
  assertEquals(await runSpike(["--tenant", TENANT, "--create", "--intake", "x.json", APPROVAL_FLAG], h.deps), 0);
  assertEquals(h.writes(), [
    `createProfile ${spikeNames(TENANT).profile} true`, "createA2p true", "registerBrand low_volume_standard", "createService",
  ]);
  const costAt = h.lines.findIndex((l) => l.startsWith("THIS RUN WOULD COST"));
  const firstStep = h.lines.findIndex((l) => l.startsWith("> "));
  assert(costAt >= 0 && firstStep > costAt, "the cost is printed before the first step");
  assert(/linked to the parent's primary: YES/.test(h.text()), h.text());
  assert(/waits for the brand's review|after the brand is approved/.test(h.text()), h.text());
  leaksNoSid(h.text());
});

Deno.test("the brand approved: only the LOW_VOLUME campaign, $15 + $1.50 a month; not eligible stops before it", async () => {
  const ready = { profile: true, linked: true, a2p: true, brand: "APPROVED", service: true };
  const plan = spikePlan({ profileSid: PROFILE, profileStatus: "twilio-approved", primaryLinked: true, a2pSid: A2P, brandSid: BRAND, brandStatus: "APPROVED", serviceSid: SERVICE, campaignSid: null, campaignStatus: null } as SpikeState);
  assertEquals(plan.steps.map((s) => [s.kind, s.costCents, s.monthlyCents]), [["create_campaign", SPIKE_COST_CENTS.campaignVetting, SPIKE_COST_CENTS.campaignMonthly]]);
  const h = harness(ready);
  assertEquals(await runSpike(["--tenant", TENANT, "--create", "--intake", "x.json", APPROVAL_FLAG], h.deps), 0);
  assert(/THIS RUN WOULD COST: \$15\.00 once \+ \$1\.50 a month/.test(h.text()), h.text());
  assertEquals(h.writes(), [`createCampaign ${SPIKE_USE_CASE}`]);
  const no = harness({ ...ready, useCases: ["MIXED", "MARKETING"] });
  assertEquals(await runSpike(["--tenant", TENANT, "--create", "--intake", "x.json", APPROVAL_FLAG], no.deps), 2);
  assertEquals(no.writes(), [], "no campaign of another (dearer) use case");
});

Deno.test("a refused cross-account link stops the run before anything billed", async () => {
  const h = harness({ refuseLink: true });
  assertEquals(await runSpike(["--tenant", TENANT, "--create", "--intake", "x.json", APPROVAL_FLAG], h.deps), 1);
  assertEquals(h.writes(), [`createProfile ${spikeNames(TENANT).profile} true`]);
  assert(/REFUSED the cross-account link/.test(h.text()) && /code 20403/.test(h.text()), h.text());
  leaksNoSid(h.text());
});

Deno.test("a profile that stopped at the link is FINISHED, not made again", async () => {
  const h = harness({ profile: true, linked: false });
  assertEquals(await runSpike(["--tenant", TENANT, "--create", "--intake", "x.json", APPROVAL_FLAG], h.deps), 0);
  assertEquals(h.writes()[0], "finishProfile");
  assert(!h.writes().some((a) => a.startsWith("createProfile")));
});

Deno.test("the live database reads are GETs with the service role key", async () => {
  const saved = { u: Deno.env.get("SUPABASE_URL"), k: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") };
  Deno.env.set("SUPABASE_URL", "https://example.supabase.test");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  const seen: { method: string; url: string; auth: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    seen.push({ method: String(init?.method ?? "GET"), url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return Promise.resolve(new Response("[]", { status: 200 }));
  }) as typeof fetch;
  try {
    const d = liveDeps();
    await d.db.creds(TENANT);
    await d.db.internal(TENANT);
    await d.db.registration(TENANT);
    assertEquals(seen.map((s) => s.method), ["GET", "GET", "GET"]);
    assert(seen[0].url.endsWith(`/rest/v1/rpc/twilio_account_creds?p_client_id=${TENANT}`), seen[0].url);
    assert(seen.every((s) => s.auth === "Bearer service-role-test-key"));
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["SUPABASE_URL", saved.u], ["SUPABASE_SERVICE_ROLE_KEY", saved.k]] as const) {
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  }
});
