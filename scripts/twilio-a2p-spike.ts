// Workstream 2, phase 6: THE A2P SPIKE. Proves, on ONE TEST builder's Twilio sub-account, the three
// things texting inside a sub-account depends on and our account has never done:
//   1. a secondary customer profile made in the sub, linked ACROSS accounts to the parent's primary
//      profile (TWILIO_PRIMARY_PROFILE_SID), AND APPROVED by Twilio's review (the API taking the link
//      is not the verdict; the review is, and it is free);
//   2. a Low-Volume Standard brand registered on it, in the sub;
//   3. a campaign on that brand, in the sub.
// Through the production code (supabase/functions/_shared/twilioTrustHub.ts), with the sub's own
// credentials, exactly the calls portal-sms makes for a builder (SETUP.md 7f step 6.4).
//
// ⚠️ GET-ONLY BY DEFAULT. Without --create it reads (the database through PostgREST, Twilio with
// GETs), prints where the spike stands with every SID masked, and prints what --create would do
// next and what that costs. With --create it prints the same, and then does nothing more unless
// --yes-i-approve-the-cost is given too. Each run does only the steps that are due and stops at the
// first one that has to wait (the profile's review, then the brand's), so run it again later to
// carry on; every object is found again by name, so nothing is made twice.
//
// TWO MODES (review 2026-10-09):
//   MOCK, the default: the brand and the campaign are Twilio MOCK objects (Mock=true). "There are no
//     A2P 10DLC fees from The Campaign Registry (TCR) or billing events for creating mock Brands and
//     Campaigns" (Twilio's Mock Brand guide). It proves every API call in the sub for $0. Mock objects
//     send nothing; a mock brand deletes itself 30 days after it is made.
//   --real: a real Low-Volume Standard brand and a real campaign, for the carriers' verdict. Billed.
//
// WHAT IT COSTS (165's prices, checked against Twilio's live pricing 2026-06-15; the run prints the
// amounts for exactly the steps it is about to take):
//   profile, A2P trust product, Messaging Service   free
//   mock brand, mock campaign                       free
//   --real: Low-Volume Standard brand               $4.50 once (no secondary vetting: LVS skips it)
//   --real: campaign (use case LOW_VOLUME, "Low Volume Mixed") $15.00 vetting once (non-refundable)
//                                                   and $1.50 a month for as long as it exists
// So the real spike: $19.50 once, then $1.50 a month until the campaign is deleted (CLEANUP below)
// or the test sub-account is closed. Some providers bill a campaign's first three months up front;
// Twilio's pages do not say it does, so allow up to $3.00 more. It buys no number (the test builder
// already has one, SETUP 7f step 6.3) and sends no text. The brand waits for the profile to be
// APPROVED, so a profile Twilio rejects never costs a brand.
//
// REFUSES, before anything: a --tenant that is not the one named in TWILIO_SPIKE_TEST_TENANT (set by
// hand, so a typo can never reach a real builder); a tenant that pays for a subscription (a real
// builder); one without an ACTIVE sub-account of its own (so never the parent, the pilot or our
// internal account); an internal account; and a tenant whose texting registration already holds
// anything at Twilio (the spike must never sit beside a real one).
//
// WHOSE BUSINESS THE --intake FILE DESCRIBES: a REAL business, with its legal name and EIN exactly as
// on its IRS letter (CP 575 / 147C), and with its owner's agreement: the carriers vet the EIN, so a
// made-up one fails the real brand and wastes its $4.50 (a mock run vets nothing). Ahsan decides
// whose; never a builder's without their written OK. The file stays OUT of the repo (an EIN and a
// person's details).
//
// Run from the repo root (PowerShell 5.1: one command per line, no `&&`):
//   $env:SUPABASE_URL = "https://<project ref>.supabase.co"
//   $env:SUPABASE_SERVICE_ROLE_KEY = "<the service role key>"     (reads only)
//   $env:TWILIO_ACCOUNT_SID = "<the parent's AC…>"               (to refuse it)
//   $env:TWILIO_PRIMARY_PROFILE_SID = "<the parent's primary BU…>"
//   $env:TWILIO_SPIKE_TEST_TENANT = "<the test builder's id>"     (must equal --tenant)
//   deno run --allow-env --allow-read --allow-net scripts/twilio-a2p-spike.ts --tenant <test builder id>
//   deno run --allow-env --allow-read --allow-net scripts/twilio-a2p-spike.ts --tenant <id> --create --intake <file.json>
//   deno run --allow-env --allow-read --allow-net scripts/twilio-a2p-spike.ts --tenant <id> --create --intake <file.json> --yes-i-approve-the-cost
//   (add --real to the last two for the billed brand and campaign)
// --intake is a JSON file KEPT OUT OF THE REPO:
//   { "intake": { BuilderIntake: legalBusinessName, ein, businessType, businessIndustry, websiteUrl,
//                 street, city, region, postalCode, isoCountry, repFirstName, repLastName, repEmail,
//                 repPhone, repBusinessTitle, repJobPosition },
//     "copy": { "description", "messageFlow", "messageSamples": [two or more, one with STOP] },
//     "privacyPolicyUrl": "https://…", "termsUrl": "https://…" }
// Exit: 0 done (or nothing due), 2 refused, blocked or waiting for --yes-i-approve-the-cost, 1 failed.
//
// CLEANUP, once the spike has answered (in the TEST sub-account, Twilio Console; SETUP 7f step 6.4):
//   * a real campaign: delete it (Messaging, Services, "<tenant> — A2P spike", its campaign; or
//     DELETE /v1/Services/{MG}/Compliance/Usa2p/{QE}). That ends the $1.50 a month. A brand cannot be
//     deleted and has no monthly fee.
//   * a mock campaign: delete it the same way ("<tenant> — A2P spike (mock)"); a mock brand goes by
//     itself after 30 days.
//   * then delete the spike's Messaging Service(s). The profile and the A2P trust product cost
//     nothing and may stay.
//   * never register real texting for the test builder afterwards: it would make a second brand
//     beside the spike's. Close the test sub-account instead once it holds no number.
//
// Nothing secret is printed: SIDs are cut to their first 2 and last 4 characters, the EIN to its
// last 4, and Twilio's error bodies (which echo what was sent) never leave the error code.

import {
  createA2pTrustProduct, createCampaign, createMessagingService, createSecondaryCustomerProfile,
  fetchCampaign, fetchEligibleUseCases, finishSecondaryCustomerProfile, POLICY_A2P_TRUST_PRODUCT,
  POLICY_SECONDARY_CUSTOMER_PROFILE, PrimaryProfileLinkError, primaryProfileLinked, registerBrand, TrustHubError,
  trustHubHttp, validateCampaignCopy, validateIntake, type BuilderIntake, type CampaignCopy, type TrustHubCreds,
} from "../supabase/functions/_shared/twilioTrustHub.ts";

/** Cents, so nothing rounds. 165_sms_registration.sql holds the same figures. */
export const SPIKE_COST_CENTS = { brand: 450, campaignVetting: 1500, campaignMonthly: 150 } as const;
/** The one use case the spike registers: Low Volume Mixed, the $1.50 a month campaign. */
export const SPIKE_USE_CASE = "LOW_VOLUME";
export const APPROVAL_FLAG = "--yes-i-approve-the-cost";
/** The environment variable that names the one tenant the spike may run on. */
export const TEST_TENANT_ENV = "TWILIO_SPIKE_TEST_TENANT";

const TRUSTHUB = "https://trusthub.twilio.com/v1";
const MESSAGING = "https://messaging.twilio.com/v1";
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SIDS = { ac: /^AC[0-9a-f]{32}$/i, bu: /^BU[0-9a-f]{32}$/i, it: /^IT[0-9a-f]{32}$/i, rd: /^RD[0-9a-f]{32}$/i };
/** A2P trust product statuses a brand may be registered on (submitted, and not rejected). */
const A2P_SUBMITTED = new Set(["pending-review", "in-review", "twilio-approved"]);

export function mask(sid: unknown): string {
  const s = String(sid ?? "");
  return s.length > 6 ? `${s.slice(0, 2)}…${s.slice(-4)}` : "(none)";
}
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export type Args = { tenant: string; create: boolean; approved: boolean; real: boolean; intakePath: string | null; help: boolean };

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Args = { tenant: "", create: false, approved: false, real: false, intakePath: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant") out.tenant = String(argv[++i] ?? "");
    else if (a === "--create") out.create = true;
    else if (a === APPROVAL_FLAG) out.approved = true;
    else if (a === "--real") out.real = true;
    else if (a === "--intake") out.intakePath = String(argv[++i] ?? "") || null;
    else if (a === "--help" || a === "-h") out.help = true;
    else return { error: `Unknown argument ${a}.` };
  }
  if (out.help) return out;
  if (!SLUG.test(out.tenant)) return { error: "--tenant <test builder id> is required (a slug)." };
  if (out.approved && !out.create) return { error: `${APPROVAL_FLAG} only goes with --create.` };
  if (out.create && !out.intakePath) return { error: "--create needs --intake <file.json> (kept out of the repo)." };
  return out;
}

/** The spike's own objects in the sub, found again by these names on every run. The profile and the
 *  A2P trust product are real in both modes; a Messaging Service holds one campaign, so mock and real
 *  each have their own. */
export function spikeNames(tenant: string, mock = true) {
  return {
    profile: `${tenant} — A2P spike`, a2p: `${tenant} — A2P spike A2P`,
    service: mock ? `${tenant} — A2P spike (mock)` : `${tenant} — A2P spike`,
  };
}

/** What Twilio holds for the spike (null = not made yet). */
export type SpikeState = {
  profileSid: string | null;
  profileStatus: string | null;
  primaryLinked: boolean | null;
  /** The profile carries its business information, its representative and its address document
   *  (an earlier run that stopped half-way leaves one without them). null = no profile. */
  profileComplete?: boolean | null;
  a2pSid: string | null;
  a2pStatus?: string | null;
  brandSid: string | null;
  brandStatus: string | null;
  serviceSid: string | null;
  campaignSid: string | null;
  campaignStatus: string | null;
};

export type StepKind = "create_profile" | "finish_profile" | "create_a2p" | "register_brand" | "create_service" | "create_campaign";
export type Step = { kind: StepKind; what: string; costCents: number; monthlyCents: number };

/**
 * The steps due now, in order, where the spike waits, and why it cannot go on at all (`blocked`).
 * A billed step is only planned once everything it stands on exists AND has been judged:
 *   * the brand needs the secondary profile linked and APPROVED by Twilio's review (review
 *     2026-10-09: the review of a profile linked across accounts is the first real verdict, and it is
 *     free, so nothing is paid before it), and the A2P trust product submitted;
 *   * the campaign needs the brand APPROVED (Twilio answers 21717 before that) and the Service.
 * A profile Twilio REJECTED, an incomplete one from an earlier run, or a rejected A2P trust product
 * blocks the run: nothing is sent.
 */
export function spikePlan(s: SpikeState, mock = true): { steps: Step[]; waiting: string | null; blocked: string | null; done: boolean } {
  const none = (blocked: string) => ({ steps: [] as Step[], waiting: null, blocked, done: false });
  if (s.profileSid && s.profileComplete === false) {
    return none("The spike's secondary profile from an earlier run is incomplete (its business details, representative or address are not on it). Delete it in the sub's Console (Trust Hub, Customer profiles), then run this again.");
  }
  if (s.profileSid && s.profileStatus === "twilio-rejected") {
    return none("Twilio REJECTED the secondary profile linked across accounts. That is the finding: read its errors in the sub's Console (Trust Hub, Customer profiles). Nothing billed was attempted.");
  }
  if (s.a2pSid && s.a2pStatus === "twilio-rejected") {
    return none("Twilio rejected the spike's A2P trust product. Read its errors in the sub's Console (Trust Hub, Trust products). Nothing billed was attempted.");
  }
  const steps: Step[] = [];
  const free = (kind: StepKind, what: string) => steps.push({ kind, what, costCents: 0, monthlyCents: 0 });
  if (!s.profileSid) free("create_profile", "make the secondary customer profile in the sub, link it to the parent's primary profile (the cross-account step), submit it");
  else if (s.primaryLinked === false || s.profileStatus === "draft") free("finish_profile", "link the secondary profile to the parent's primary profile, and submit it if it is still a draft");
  if (!s.a2pSid) free("create_a2p", "make the A2P trust product on that profile and submit it");

  let waiting: string | null = null;
  const profileApproved = !!s.profileSid && s.profileStatus === "twilio-approved" && s.primaryLinked !== false;
  const a2pSubmitted = !!s.a2pSid && A2P_SUBMITTED.has(String(s.a2pStatus ?? ""));
  if (!s.brandSid) {
    if (profileApproved && a2pSubmitted) {
      steps.push({
        kind: "register_brand",
        what: mock ? "register a MOCK Low-Volume Standard brand in the sub (no fee)" : "register a Low-Volume Standard brand in the sub",
        costCents: mock ? 0 : SPIKE_COST_CENTS.brand, monthlyCents: 0,
      });
    } else {
      waiting = !profileApproved
        ? `the brand waits for Twilio to approve the secondary profile (status ${s.profileSid ? s.profileStatus ?? "unknown" : "not made yet"}); run this again once it reads twilio-approved, usually within a few days`
        : `the brand waits for the A2P trust product to be submitted (status ${s.a2pStatus ?? "not made yet"})`;
    }
  }
  if (!s.serviceSid && (s.brandSid || steps.some((x) => x.kind === "register_brand"))) {
    free("create_service", "make a Messaging Service in the sub (no number attached, no text sent)");
  }
  if (!s.campaignSid && !waiting) {
    const approved = String(s.brandStatus ?? "").toUpperCase() === "APPROVED";
    if (s.brandSid && approved && s.serviceSid) {
      steps.push({
        kind: "create_campaign", what: `register a ${mock ? "MOCK " : ""}${SPIKE_USE_CASE} campaign on the brand`,
        costCents: mock ? 0 : SPIKE_COST_CENTS.campaignVetting, monthlyCents: mock ? 0 : SPIKE_COST_CENTS.campaignMonthly,
      });
    } else {
      waiting = s.brandSid
        ? `the campaign waits for the brand's review (brand status ${s.brandStatus ?? "unknown"}); run this again once it reads APPROVED`
        : "the campaign comes after the brand is approved (a later run)";
    }
  }
  return { steps, waiting, blocked: null, done: !steps.length && !waiting };
}

export function planCost(steps: Step[]): { onceCents: number; monthlyCents: number } {
  return steps.reduce((t, s) => ({ onceCents: t.onceCents + s.costCents, monthlyCents: t.monthlyCents + s.monthlyCents }), { onceCents: 0, monthlyCents: 0 });
}

export type SpikeInput = { intake: BuilderIntake; copy: CampaignCopy; privacyPolicyUrl: string; termsUrl: string };

/** The --intake file's problems, in words (validateIntake / validateCampaignCopy, the same rules the
 *  portal's server runs), or the input. */
export function parseSpikeInput(raw: unknown): { ok: true; input: SpikeInput } | { ok: false; problems: string[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const intake = (r.intake && typeof r.intake === "object" ? r.intake : {}) as BuilderIntake;
  const copy = (r.copy && typeof r.copy === "object" ? r.copy : {}) as CampaignCopy;
  const problems = [...validateIntake(intake, true), ...validateCampaignCopy(copy)];
  const privacyPolicyUrl = String(r.privacyPolicyUrl ?? "").trim(), termsUrl = String(r.termsUrl ?? "").trim();
  if (!/^https:\/\/\S+$/.test(privacyPolicyUrl) || !/^https:\/\/\S+$/.test(termsUrl)) problems.push("privacyPolicyUrl and termsUrl must be https addresses.");
  return problems.length ? { ok: false, problems } : { ok: true, input: { intake, copy, privacyPolicyUrl, termsUrl } };
}

/** Why the spike must not run on this tenant, or null. */
export function tenantRefusal(o: {
  creds: { kind?: string | null; status?: string | null; account_sid?: string | null; auth_token?: string | null } | null;
  parentSid: string; internal: boolean;
  registration: Record<string, unknown> | null;
  /** Live (active, past_due or paused) subscriptions the tenant pays for. */
  paidSubscriptions?: number;
}): string | null {
  const c = o.creds;
  if ((o.paidSubscriptions ?? 0) > 0) return "This tenant pays for a subscription, so it is a real builder. The spike runs only on a TEST builder.";
  if (!c || c.kind !== "sub") return "This tenant has no sub-account of its own (no twilio_accounts row of kind 'sub'). The spike runs only inside a test builder's sub-account; make one in Admin, Account, Twilio account first.";
  if (c.status !== "active") return `This tenant's sub-account is "${c.status ?? "unknown"}", not active. Finish it in Admin, Account, Twilio account first.`;
  if (!SIDS.ac.test(String(c.account_sid ?? "")) || String(c.account_sid) === o.parentSid) return "This tenant's account SID is missing or is the parent's. The spike never runs on the parent.";
  if (!String(c.auth_token ?? "")) return "This tenant's sub-account has no auth token in Vault. Press Check token on its console card.";
  if (o.internal) return "This is an internal account. The spike runs only on a TEST builder.";
  const reg = o.registration ?? {};
  const held = ["customer_profile_sid", "a2p_profile_sid", "brand_sid", "messaging_service_sid", "campaign_sid"].filter((k) => reg[k]);
  if (held.length) return `This tenant's own texting registration already holds ${held.join(", ")} at Twilio. The spike must never run beside a real registration: pick a test builder that has none.`;
  return null;
}

export type Http = (method: "GET" | "POST" | "DELETE", url: string, form?: Record<string, string>) => Promise<any>;

/** What a run needs from outside, injectable so tests/phone/a2pSpike_test.ts drives every branch. */
export type SpikeDeps = {
  env: (k: string) => string | undefined;
  readJson: (path: string) => Promise<unknown>;
  db: {
    creds: (tenant: string) => Promise<Record<string, unknown> | null>;
    internal: (tenant: string) => Promise<boolean>;
    registration: (tenant: string) => Promise<Record<string, unknown> | null>;
    /** How many live subscriptions the tenant pays for (a real builder has at least one). */
    paidSubscriptions: (tenant: string) => Promise<number>;
  };
  /** The sub's transport (its own credentials): GETs, and the creates below. */
  http: (creds: TrustHubCreds) => Http;
  act: {
    createProfile: (o: { intake: BuilderIntake; primaryProfileSid: string; friendlyName: string }, creds: TrustHubCreds) => Promise<{ profileSid: string }>;
    finishProfile: (profileSid: string, primary: string, http: Http) => Promise<{ linked: boolean; submitted: boolean; status: string | null }>;
    createA2p: (o: { profileSid: string; email: string; friendlyName: string }, creds: TrustHubCreds) => Promise<{ a2pProfileSid: string }>;
    registerBrand: (o: { customerProfileBundleSid: string; a2pProfileBundleSid: string; tier: "low_volume_standard"; mock: boolean }, creds: TrustHubCreds) => Promise<{ brandSid: string; status: string; mock?: boolean }>;
    createService: (o: { friendlyName: string; inboundWebhookUrl: string; statusCallbackUrl: string }, creds: TrustHubCreds) => Promise<{ serviceSid: string }>;
    useCases: (serviceSid: string, brandSid: string, creds: TrustHubCreds) => Promise<Array<{ code: string }>>;
    createCampaign: (o: { serviceSid: string; brandSid: string; useCase: string; copy: CampaignCopy; privacyPolicyUrl: string; termsUrl: string }, creds: TrustHubCreds) => Promise<{ campaignSid: string; status: string }>;
    fetchCampaign: (serviceSid: string, creds: TrustHubCreds) => Promise<{ sid: string | null; status: string }>;
  };
  out: (line: string) => void;
};

const list = async (http: Http, url: string, key = "results"): Promise<any[]> => {
  const r = await http("GET", url);
  return Array.isArray(r?.[key]) ? r[key] : [];
};

/** Where the spike stands at Twilio, read with GETs only. `mock` picks which brand and Service are
 *  the spike's (a mock brand is never taken for a real one, nor the reverse). */
export async function readState(http: Http, deps: SpikeDeps, creds: TrustHubCreds, tenant: string, primary: string, mock = true): Promise<SpikeState> {
  const names = spikeNames(tenant, mock);
  const profiles = await list(http, `${TRUSTHUB}/CustomerProfiles?PolicySid=${POLICY_SECONDARY_CUSTOMER_PROFILE}&PageSize=50`);
  const prof = profiles.find((p) => String(p?.friendly_name ?? "") === names.profile && SIDS.bu.test(String(p?.sid ?? "")));
  // What is assigned onto the profile: the primary (the cross-account link), and its own business
  // information and representative (EndUsers, IT…) and address document (RD…).
  const objects = prof
    ? (await list(http, `${TRUSTHUB}/CustomerProfiles/${String(prof.sid)}/EntityAssignments?PageSize=50`)).map((a) => String(a?.object_sid ?? ""))
    : null;
  const products = await list(http, `${TRUSTHUB}/TrustProducts?PolicySid=${POLICY_A2P_TRUST_PRODUCT}&PageSize=50`);
  const a2p = products.find((t) => String(t?.friendly_name ?? "") === names.a2p && SIDS.bu.test(String(t?.sid ?? "")));
  const brands = prof ? await list(http, `${MESSAGING}/a2p/BrandRegistrations?PageSize=50`, "data") : [];
  const brand = brands.find((b) => String(b?.customer_profile_bundle_sid ?? "") === String(prof?.sid ?? "") && (b?.mock === true) === mock);
  const services = await list(http, `${MESSAGING}/Services?PageSize=50`, "services");
  const svc = services.find((s) => String(s?.friendly_name ?? "") === names.service);
  const campaign = svc ? await deps.act.fetchCampaign(String(svc.sid), creds) : null;
  return {
    profileSid: prof ? String(prof.sid) : null,
    profileStatus: prof ? String(prof.status ?? "") || null : null,
    primaryLinked: objects && SIDS.bu.test(primary) ? objects.includes(primary) : null,
    profileComplete: objects ? objects.filter((s) => SIDS.it.test(s)).length >= 2 && objects.some((s) => SIDS.rd.test(s)) : null,
    a2pSid: a2p ? String(a2p.sid) : null,
    a2pStatus: a2p ? String(a2p.status ?? "") || null : null,
    brandSid: brand ? String(brand.sid) : null,
    brandStatus: brand ? String(brand.status ?? "") || null : null,
    serviceSid: svc ? String(svc.sid) : null,
    campaignSid: campaign?.sid ?? null,
    campaignStatus: campaign?.sid ? campaign.status : null,
  };
}

function printState(out: (l: string) => void, s: SpikeState, mock: boolean) {
  out(`Where the spike stands (in the test builder's sub-account; ${mock ? "MOCK brand and campaign" : "REAL brand and campaign"}):`);
  out(`  secondary profile   ${mask(s.profileSid)}  ${s.profileStatus ?? ""}${s.profileComplete === false ? "  (incomplete)" : ""}`);
  out(`  linked to primary   ${s.primaryLinked === null ? "n/a" : s.primaryLinked ? "YES (the cross-account assignment holds)" : "no"}`);
  out(`  A2P trust product   ${mask(s.a2pSid)}  ${s.a2pStatus ?? ""}`);
  out(`  ${mock ? "mock" : "LVS "} brand          ${mask(s.brandSid)}  ${s.brandStatus ?? ""}`);
  out(`  Messaging Service   ${mask(s.serviceSid)}`);
  out(`  campaign            ${mask(s.campaignSid)}  ${s.campaignStatus ?? ""}`);
}

/** One run. Returns the exit code. */
export async function runSpike(argv: string[], deps: SpikeDeps): Promise<number> {
  const out = deps.out;
  const args = parseArgs(argv);
  if ("error" in args) { out(args.error); return 2; }
  if (args.help) { out("See the header of scripts/twilio-a2p-spike.ts."); return 0; }
  const mock = !args.real;
  const parentSid = String(deps.env("TWILIO_ACCOUNT_SID") ?? "").trim();
  const primary = String(deps.env("TWILIO_PRIMARY_PROFILE_SID") ?? "").trim();
  if (!SIDS.ac.test(parentSid) || !SIDS.bu.test(primary)) {
    out("Set TWILIO_ACCOUNT_SID (the parent) and TWILIO_PRIMARY_PROFILE_SID (its primary profile) first.");
    return 2;
  }
  // The deliberate second naming of the test builder: nothing is read, let alone sent, for a tenant
  // the operator did not set aside by hand (review 2026-10-09).
  if (String(deps.env(TEST_TENANT_ENV) ?? "").trim() !== args.tenant) {
    out(`REFUSED: set ${TEST_TENANT_ENV} to the test builder's id first (it must equal --tenant). The spike runs only on the builder named there, so a typo in --tenant can never reach a real builder.`);
    return 2;
  }

  // ── The tenant, from the database (reads only) ───────────────────────────────────────────
  const [row, internal, registration, paidSubscriptions] = await Promise.all([
    deps.db.creds(args.tenant), deps.db.internal(args.tenant), deps.db.registration(args.tenant), deps.db.paidSubscriptions(args.tenant),
  ]);
  const why = tenantRefusal({ creds: row as never, parentSid, internal, registration, paidSubscriptions });
  if (why) { out(`REFUSED: ${why}`); return 2; }
  const r = row as Record<string, unknown>;
  const accountSid = String(r.account_sid);
  // The sub's OWN credentials (its subdomains refuse the parent's): its API key pair, else its
  // account SID and auth token, the order every other caller uses (twilioAccount.ts).
  const creds: TrustHubCreds = r.api_key_sid && r.api_secret
    ? { accountSid, user: String(r.api_key_sid), pass: String(r.api_secret) }
    : { accountSid, user: accountSid, pass: String(r.auth_token) };
  const http = deps.http(creds);
  out(`Test builder ${args.tenant}, sub-account ${mask(accountSid)} (active); parent ${mask(parentSid)}, primary profile ${mask(primary)}.`);

  let state: SpikeState;
  try {
    state = await readState(http, deps, creds, args.tenant, primary, mock);
  } catch (e) {
    out(`Reading Twilio failed${e instanceof TrustHubError ? ` (HTTP ${e.status}, code ${e.code})` : ""}. Nothing was changed.`);
    return 1;
  }
  printState(out, state, mock);
  const plan = spikePlan(state, mock);
  if (plan.blocked) { out(`STOPPED: ${plan.blocked}`); return 2; }
  const cost = planCost(plan.steps);
  if (plan.done) {
    out(`The spike is complete${mock ? " in MOCK mode" : ""}: profile linked across accounts and approved, brand and campaign registered in the sub.${mock ? " Run it with --real for the carriers' own verdict." : ""}`);
    return 0;
  }
  out(plan.steps.length ? "Next, with --create:" : "Nothing to do on this run.");
  for (const s of plan.steps) out(`  - ${s.what}: ${s.costCents ? `${dollars(s.costCents)} once` : "free"}${s.monthlyCents ? ` + ${dollars(s.monthlyCents)} a month while it exists` : ""}`);
  if (plan.waiting) out(`  (then ${plan.waiting})`);
  out(`THIS RUN WOULD COST: ${dollars(cost.onceCents)} once${cost.monthlyCents ? ` + ${dollars(cost.monthlyCents)} a month` : ""}, billed to the parent account.`);
  out(mock
    ? `The whole MOCK spike: $0.00 (mock brands and campaigns carry no A2P 10DLC fees). With --real: ${dollars(SPIKE_COST_CENTS.brand + SPIKE_COST_CENTS.campaignVetting)} once + ${dollars(SPIKE_COST_CENTS.campaignMonthly)} a month until the campaign is deleted or the test sub-account is closed.`
    : `The whole REAL spike: ${dollars(SPIKE_COST_CENTS.brand + SPIKE_COST_CENTS.campaignVetting)} once + ${dollars(SPIKE_COST_CENTS.campaignMonthly)} a month until the campaign is deleted or the test sub-account is closed.`);
  if (!args.create || !plan.steps.length) return 0;

  let input: SpikeInput;
  try {
    const parsed = parseSpikeInput(await deps.readJson(String(args.intakePath)));
    if (!parsed.ok) { out("REFUSED: the --intake file has problems:"); for (const p of parsed.problems) out(`  - ${p}`); return 2; }
    input = parsed.input;
  } catch {
    out("REFUSED: the --intake file could not be read as JSON.");
    return 2;
  }
  if (!args.approved) {
    out(`Nothing was done. To spend the amount above, run it again with ${APPROVAL_FLAG}.`);
    return 2;
  }

  // ── The steps due, in order; stop at the first failure ──────────────────────────────────
  const names = spikeNames(args.tenant, mock);
  try {
    for (const step of plan.steps) {
      out(`> ${step.what}`);
      if (step.kind === "create_profile") {
        const p = await deps.act.createProfile({ intake: input.intake, primaryProfileSid: primary, friendlyName: names.profile }, creds);
        state.profileSid = p.profileSid;
        state.primaryLinked = await primaryProfileLinked(p.profileSid, primary, http);
        out(`  profile ${mask(p.profileSid)}; linked to the parent's primary: ${state.primaryLinked ? "YES" : "NO"}`);
        if (!state.primaryLinked) {
          out("  STOPPED: Twilio took the link but does not list it. Nothing billed was attempted; look at the profile in the sub's Console, and do not let a builder depend on this until Twilio explains it.");
          return 1;
        }
      } else if (step.kind === "finish_profile") {
        const f = await deps.act.finishProfile(String(state.profileSid), primary, http);
        out(`  linked now: ${f.linked ? "yes" : "already"}; submitted: ${f.submitted ? "yes" : "no"}; status ${f.status ?? "unknown"}`);
      } else if (step.kind === "create_a2p") {
        const a = await deps.act.createA2p({ profileSid: String(state.profileSid), email: input.intake.repEmail, friendlyName: names.a2p }, creds);
        state.a2pSid = a.a2pProfileSid;
        out(`  A2P trust product ${mask(a.a2pProfileSid)}`);
      } else if (step.kind === "register_brand") {
        const b = await deps.act.registerBrand({ customerProfileBundleSid: String(state.profileSid), a2pProfileBundleSid: String(state.a2pSid), tier: "low_volume_standard", mock }, creds);
        state.brandSid = b.brandSid;
        // Asked for a mock and got a real one: say so loudly, the way portal-sms does.
        if (mock && b.mock === false) out(`  ⚠ Twilio made a REAL brand although a mock was asked for: ${dollars(SPIKE_COST_CENTS.brand)} billed.`);
        out(`  ${mock ? "mock " : ""}brand ${mask(b.brandSid)} ${b.status} (${mock && b.mock !== false ? "no fee" : `${dollars(SPIKE_COST_CENTS.brand)} billed`})`);
      } else if (step.kind === "create_service") {
        const s = await deps.act.createService({ friendlyName: names.service, inboundWebhookUrl: "", statusCallbackUrl: "" }, creds);
        state.serviceSid = s.serviceSid;
        out(`  Messaging Service ${mask(s.serviceSid)}`);
      } else if (step.kind === "create_campaign") {
        const eligible = await deps.act.useCases(String(state.serviceSid), String(state.brandSid), creds);
        if (!eligible.some((u) => u.code === SPIKE_USE_CASE)) {
          out(`  STOPPED: ${SPIKE_USE_CASE} is not among the brand's eligible use cases (${eligible.map((u) => u.code).join(", ") || "none"}). No campaign was made; another use case costs more a month, so that is a decision, not a retry.`);
          return 2;
        }
        const c = await deps.act.createCampaign({
          serviceSid: String(state.serviceSid), brandSid: String(state.brandSid), useCase: SPIKE_USE_CASE,
          copy: input.copy, privacyPolicyUrl: input.privacyPolicyUrl, termsUrl: input.termsUrl,
        }, creds);
        out(`  ${mock ? "mock " : ""}campaign ${mask(c.campaignSid)} ${c.status} (${mock ? "no fee" : `${dollars(SPIKE_COST_CENTS.campaignVetting)} billed, then ${dollars(SPIKE_COST_CENTS.campaignMonthly)} a month`})`);
      }
    }
  } catch (e) {
    if (e instanceof PrimaryProfileLinkError) {
      if (e.refused) {
        out(`RESULT: Twilio REFUSED the cross-account link of the secondary profile ${mask(e.profileSid)} to the parent's primary (HTTP ${e.status}, code ${e.code}).`);
        out("  This is the finding the spike exists for: texting inside sub-accounts cannot go ahead as designed until Twilio support explains it. Nothing billed was attempted.");
      } else {
        // A timeout, a 5xx or a 429 says nothing about the cross-account link (review 2026-10-09).
        out(`Twilio did not answer the cross-account link of the secondary profile ${mask(e.profileSid)} (HTTP ${e.status}, code ${e.code}). That is not a refusal: run it again in a few minutes. The profile is found by name and only the link is retried. Nothing billed was attempted.`);
      }
      return 1;
    }
    out(`FAILED${e instanceof TrustHubError ? ` (HTTP ${e.status}, code ${e.code})` : `: ${(e as Error)?.message ?? "unknown"}`}. Run it again to carry on: what was made is found again by name.`);
    return 1;
  }
  if (plan.waiting) out(`Done for now: ${plan.waiting}.`);
  return 0;
}

/** The production wiring: PostgREST GETs with the service role key, and twilioTrustHub.ts. */
export function liveDeps(): SpikeDeps {
  const env = (k: string) => Deno.env.get(k) ?? undefined;
  const base = String(env("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  const key = String(env("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const rest = async (path: string): Promise<any> => {
    if (!/^https:\/\/\S+$/.test(base) || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
    // GET only: twilio_account_creds is a STABLE function, so PostgREST answers it on GET too.
    const res = await fetch(`${base}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" } });
    if (!res.ok) throw new Error(`The database read ${path.split("?")[0]} failed (HTTP ${res.status}).`);
    return await res.json();
  };
  const first = (v: unknown) => (Array.isArray(v) ? v[0] ?? null : v ?? null) as Record<string, unknown> | null;
  const q = encodeURIComponent;
  return {
    env,
    readJson: async (p) => JSON.parse(await Deno.readTextFile(p)),
    db: {
      creds: async (t) => first(await rest(`rpc/twilio_account_creds?p_client_id=${q(t)}`)),
      internal: async (t) => first(await rest(`client_settings?client_id=eq.${q(t)}&select=internal_account`))?.internal_account === true,
      registration: async (t) => first(await rest(`sms_registrations?client_id=eq.${q(t)}&select=status,customer_profile_sid,a2p_profile_sid,brand_sid,messaging_service_sid,campaign_sid`)),
      paidSubscriptions: async (t) => {
        const rows = await rest(`billing_subscriptions?client_id=eq.${q(t)}&status=in.(active,past_due,paused)&select=id`);
        return Array.isArray(rows) ? rows.length : 0;
      },
    },
    http: (creds) => trustHubHttp(creds),
    act: {
      createProfile: (o, c) => createSecondaryCustomerProfile(o, c),
      finishProfile: (p, pri, h) => finishSecondaryCustomerProfile(p, pri, h, { crossAccount: true }),
      createA2p: (o, c) => createA2pTrustProduct(o, c),
      registerBrand: (o, c) => registerBrand(o, c),
      createService: (o, c) => createMessagingService(o, c),
      useCases: (s, b, c) => fetchEligibleUseCases(s, b, c),
      createCampaign: (o, c) => createCampaign(o, c),
      fetchCampaign: (s, c) => fetchCampaign(s, c),
    },
    out: (l) => console.log(l),
  };
}

if (import.meta.main) {
  Deno.exit(await runSpike(Deno.args, liveDeps()));
}
