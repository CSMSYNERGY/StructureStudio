/**
 * Twilio TrustHub + A2P 10DLC registration transport — the ISV chain that turns a builder's
 * business details into a sender the carriers will accept.
 *
 * A leaf module: zero imports, every call takes its inputs explicitly, so preflight can
 * unit-test it offline with a stubbed fetch. Same shape as twilioSms.ts and for the same
 * reason — this is the path that spends real money, and it must be testable without doing so.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE: Twilio ISV "architecture #1" — ONE SUB-ACCOUNT PER BUILDER, billed to the
 * parent, each holding that builder's Secondary Customer Profile, Brand, Campaign, Messaging
 * Service and numbers (Workstream 2; until 2026-10 this was "architecture #4", everything on the
 * parent). structure-studio stays ON THE PARENT (the pilot number, the primary profile, its own
 * brand), with Verify, the setup-test app and NTS.
 *
 * ⚠️ EVERY CALL RUNS WITH ONE ACCOUNT'S OWN CREDENTIALS. Main-account API keys are denied on
 * sub-account resources, and every endpoint below except the /Accounts/{sid} ones lives on a
 * subdomain (trusthub. / messaging.) that only the account's own credentials reach. So each
 * export takes the account it runs as (TrustHubCreds: the SID for the path, the pair for the
 * header), resolved per tenant by _shared/twilioAccount.ts. Omitted, it is the parent from the
 * environment: exactly what every call did before, and all any call does while
 * TWILIO_SUBACCOUNTS is not "on". The secondary profile's EntityAssignment still names the
 * PARENT's primary profile (TWILIO_PRIMARY_PROFILE_SID), across accounts.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ EVERY BrandRegistration POST COSTS MONEY. Twilio: "This API request incurs fees on your
 * Twilio Account." Nothing in this file may be called speculatively, on a retry loop, or
 * without the caller having first taken the single-flight advance lock in sms_registrations.
 *
 * ⚠️ RATE LIMIT: Twilio asks for at most ONE request per second across brand and campaign
 * registration. throttle() below enforces it in-process; a caller looping over tenants must
 * still not run two invocations concurrently.
 *
 * ⚠️ NO TWILIO ERROR TEXT IS EVER PROPAGATED TO A BROWSER. Their bodies echo submitted
 * values — an EIN, a representative's mobile. Only codes and our own authored sentences
 * travel outward. Raw detail goes to app_errors.
 */

const TRUSTHUB = "https://trusthub.twilio.com/v1";
const MESSAGING = "https://messaging.twilio.com/v1";

/** The two TrustHub policies the ISV path is built on. These SIDs are Twilio's own and are
 *  stable across accounts — they identify the POLICY, not our tenant. */
export const POLICY_SECONDARY_CUSTOMER_PROFILE = "RNdfbf3fae0e1107f8aded0e7cead80bf5";
export const POLICY_A2P_TRUST_PRODUCT = "RNb0d4771c2c98518d916a3d4cd70a8f8b";

function accountSid(): string | null { return Deno.env.get("TWILIO_ACCOUNT_SID") || null; }
function apiKey(): string | null { return Deno.env.get("TWILIO_API_KEY") || null; }
function apiSecret(): string | null { return Deno.env.get("TWILIO_API_SECRET") || null; }
function authToken(): string | null { return Deno.env.get("TWILIO_AUTH_TOKEN") || null; }

function basicAuthPair(): { user: string; pass: string } | null {
  const k = apiKey(), s = apiSecret();
  if (k && s) return { user: k, pass: s };
  const a = accountSid(), t = authToken();
  if (a && t) return { user: a, pass: t };
  return null;
}

/**
 * The account a call runs as: its SID (the /Accounts/{sid} path) and the Basic pair every request
 * carries. Same shape as _shared/twilioAccount.ts's TwilioCreds (this file keeps zero imports), so
 * a resolved account is passed straight in. null / omitted = the parent from the environment.
 */
export type TrustHubCreds = { accountSid: string; user: string; pass: string };

/** The Basic pair for these credentials, or the environment's when there are none. */
function pairFor(creds: TrustHubCreds | null | undefined): { user: string; pass: string } | null {
  if (!creds) return basicAuthPair();
  return creds.user && creds.pass ? { user: creds.user, pass: creds.pass } : null;
}

/** The /Accounts/{sid} segment for these credentials, or the environment's. */
function acctOf(creds: TrustHubCreds | null | undefined): string | null {
  return creds ? (creds.accountSid || null) : accountSid();
}

export function trustHubConfigured(): boolean {
  return basicAuthPair() !== null && !!accountSid();
}

export class TrustHubError extends Error {
  readonly status: number;
  readonly code: number;
  /** True only on positive evidence that an identical retry fails identically. Claimed
   *  sparingly: a wrongly-permanent verdict strands a registration a retry would have
   *  completed, and that is the more expensive mistake. */
  readonly permanent: boolean;
  readonly detail: unknown;
  constructor(init: { message: string; status: number; code: number; permanent: boolean; detail?: unknown }) {
    super(init.message);
    this.name = "TrustHubError";
    this.status = init.status;
    this.code = init.code;
    this.permanent = init.permanent;
    this.detail = init.detail ?? null;
  }
}

/**
 * Codes where retrying the same payload is pointless:
 *   30915  Sole Proprietor classification invalid — the business HAS a tax ID. The fix is a
 *          different brand tier, not another attempt. This is THE most likely rejection for
 *          a shed builder, because almost all of them are LLCs.
 *   21724  brand update limit reached (three free resubmissions, then no more)
 *   20404  the object does not exist
 *   20003  authentication failed
 */
const PERMANENT_CODES = new Set([30915, 21724, 20404, 20003]);

let lastCallAt = 0;
/** Twilio asks for ≤1 request/second on brand and campaign registration. */
async function throttle(): Promise<void> {
  const since = Date.now() - lastCallAt;
  if (since < 1100) await new Promise((r) => setTimeout(r, 1100 - since));
  lastCallAt = Date.now();
}

async function call(
  method: "GET" | "POST" | "DELETE",
  url: string,
  form?: Record<string, string>,
  extraHeaders?: Record<string, string>,
  creds?: TrustHubCreds | null,
): Promise<any> {
  const pair = pairFor(creds);
  if (!pair) throw new TrustHubError({ message: "Twilio credentials are not configured.", status: 0, code: 0, permanent: true });
  await throttle();

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${pair.user}:${pair.pass}`)}`,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(extraHeaders ?? {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
  } catch (e) {
    // Never reached Twilio. Nothing about the request has been judged, so permanence
    // cannot be claimed — and for a POST that spends money, "did it happen?" is genuinely
    // unknown. The caller must reconcile by LISTING before it retries a create.
    throw new TrustHubError({
      message: `Could not reach Twilio: ${(e as Error).message}`,
      status: 0, code: 0, permanent: false,
    });
  }

  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const code = typeof body?.code === "number" ? body.code : 0;
    throw new TrustHubError({
      message: `Twilio refused ${method} ${url.replace(/https:\/\/[^/]+/, "")} (HTTP ${res.status}, code ${code}).`,
      status: res.status,
      code,
      permanent: PERMANENT_CODES.has(code) || (res.status >= 400 && res.status < 500 && res.status !== 429),
      detail: body,
    });
  }
  return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// The builder's compliance intake
// ─────────────────────────────────────────────────────────────────────────────

export type BuilderIntake = {
  legalBusinessName: string;      // EXACTLY as on the IRS CP 575 / 147C letter
  ein: string;                    // 00-0000000
  businessType: string;           // Corporation | Limited Liability Corporation | ...
  businessIndustry: string;       // CONSTRUCTION
  websiteUrl: string;
  street: string;
  city: string;
  region: string;                 // 2-letter
  postalCode: string;
  isoCountry: string;             // US
  repFirstName: string;
  repLastName: string;
  repEmail: string;               // ⚠️ must be on the company domain — gmail is a rejection
  repPhone: string;               // E.164
  repBusinessTitle: string;
  repJobPosition: string;         // Director | GM | VP | CEO | CFO | General Counsel | Other
};

/** Twilio's accepted job positions. A value outside this list is rejected at submission. */
export const JOB_POSITIONS = ["Director", "GM", "VP", "CEO", "CFO", "General Counsel", "Other"] as const;

/** Twilio's accepted business types for a Secondary Customer Profile. */
export const BUSINESS_TYPES = [
  "Co-operative", "Corporation", "Limited Liability Corporation",
  "Non-profit Corporation", "Partnership",
] as const;

/**
 * Does this builder hold a tax ID?
 *
 * ⚠️ THIS, NOT EXPECTED VOLUME, IS WHAT PICKS THE BRAND TIER. Sole Proprietor is an
 * ELIGIBILITY tier for businesses with NO EIN — Twilio rejects anyone holding one with
 * error 30915, and it triggers on a business name containing LLC / Inc. / Corp. among other
 * signals. Every US LLC has an EIN. Defaulting small builders to Sole Proprietor because
 * they are small routes almost all of them into a paid rejection.
 */
export function suggestBrandTier(hasEin: boolean): "low_volume_standard" | "sole_proprietor" {
  return hasEin ? "low_volume_standard" : "sole_proprietor";
}

/** Cheap pre-flight the UI runs before any money is spent. Every rule here is a documented
 *  Twilio rejection cause, and catching them locally is the difference between a form error
 *  and a $19.50 lesson a week later. */
export function validateIntake(intake: Partial<BuilderIntake>, hasEin: boolean): string[] {
  const problems: string[] = [];
  const name = String(intake.legalBusinessName ?? "").trim();
  if (!name) problems.push("The legal business name is required, exactly as it appears on the IRS letter.");

  if (hasEin) {
    if (!/^\d{2}-?\d{7}$/.test(String(intake.ein ?? "").trim())) {
      problems.push("The EIN must be nine digits, like 12-3456789.");
    }
  } else if (/\b(LLC|L\.L\.C\.|Inc\.?|Corp\.?|Corporation|Incorporated)\b/i.test(name)) {
    // Twilio error 30915 verbatim cause. Refuse it here rather than pay to be told.
    problems.push(
      "This business name looks like a registered company (LLC, Inc. or Corp.), which means it has an EIN. " +
      "Companies with a tax ID cannot register as a sole proprietor — go back and enter the EIN.");
  } else {
    // SOLE PROPRIETOR IS NOT BUILT, AND THIS REFUSAL IS WHAT STOPS SOMEBODY PAYING FOR IT.
    // Verified against Twilio's docs 2026-08-31: sole proprietor is a DIFFERENT CHAIN, not a
    // flag on this one. It needs a STARTER customer profile (we create a Secondary), the EIN
    // fields OMITTED (we hardcode business_registration_identifier "EIN"), and the mobile
    // number carried on the BRAND (we put it on the profile's authorized representative).
    // Only BrandType branches today, so a no-EIN builder would submit the standard-tier shape
    // and be rejected — after the registration fee had already been taken.
    //
    // The OTP everyone worries about is NOT the problem: Twilio texts the sole proprietor and
    // they reply within 24 hours, which needs no code from us at all. The chain above it does.
    //
    // Refused HERE rather than at the submit step because this function is the one choke point
    // that save_intake and the ready->submit path BOTH already call, so it cannot be routed
    // around by a third caller added later.
    problems.push(
      "Texting can only be set up for a business that has an EIN at the moment. Registering without " +
      "one goes through a different carrier process that we have not built yet — if that is your " +
      "situation, contact support and we will tell you where it stands.");
  }

  const site = String(intake.websiteUrl ?? "").trim();
  if (!/^https?:\/\/.+\..+/.test(site)) {
    problems.push("A public website address is required. A Facebook page or a coming-soon splash page will not pass.");
  }

  const email = String(intake.repEmail ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    problems.push("A contact email address is required.");
  } else if (/@(gmail|yahoo|hotmail|outlook|aol|icloud|proton(mail)?)\./.test(email)) {
    // Documented rejection cause: the representative's address must be on the company domain.
    problems.push(
      "Use an email address on the company's own domain. A free address (gmail, yahoo, outlook) " +
      "is a documented rejection reason for carrier registration.");
  }

  if (!/^\+1\d{10}$/.test(String(intake.repPhone ?? "").trim())) {
    problems.push("The contact mobile number must be a US number in +1XXXXXXXXXX form.");
  }
  if (intake.repJobPosition && !(JOB_POSITIONS as readonly string[]).includes(String(intake.repJobPosition))) {
    problems.push("Choose a job position from the list.");
  }
  if (hasEin && intake.businessType && !(BUSINESS_TYPES as readonly string[]).includes(String(intake.businessType))) {
    problems.push("Choose a business type from the list.");
  }
  for (const [label, v] of [["street", intake.street], ["city", intake.city], ["region", intake.region], ["postal code", intake.postalCode]] as const) {
    if (!String(v ?? "").trim()) problems.push(`The registered ${label} is required.`);
  }
  return problems;
}

/**
 * Cheap pre-flight on the campaign copy — the paragraphs the CARRIERS read. Every rule here is
 * either a hard Twilio limit or a documented TCR rejection cause, and each one caught here is a
 * vetting fee and a week not spent.
 *
 * ⚠️ THIS DID NOT EXIST UNTIL 2026-09-01, AND THE FIRST REAL REGISTRATION PROVED WHY IT HAD TO.
 * The submit button was `disabled={busy}` and nothing else, and the server read `p.copy` only in
 * a LATER branch. So the first live builder submitted with `messageFlow` EMPTY and BOTH sample
 * messages EMPTY — placeholders showing through untouched inputs — while the screen told her
 * "Everything is filled in."
 *
 * ⚠️ AN EMPTY MessageFlow IS A DOCUMENTED REJECTION, not a blank field. TCR reads it against the
 * consent language actually present on the builder's website, so "" is a refusal waiting to
 * happen rather than an unanswered question.
 *
 * ⚠️ ENFORCED SERVER-SIDE BECAUSE THE BROWSER IS NOT THE ONLY CALLER, and because the portal
 * artifact reaches production a week after this function does. The portal mirrors these rules to
 * grey the button out and say why; THIS is what makes them true.
 */
export function validateCampaignCopy(copy: Partial<CampaignCopy>): string[] {
  const problems: string[] = [];

  const desc = String(copy.description ?? "").trim();
  if (desc.length < 40) {
    problems.push("Say a bit more about what you will text customers about — the carriers want a full sentence, not a few words.");
  } else if (desc.length > 4096) {
    problems.push("That description is longer than the carriers accept. Keep it under about 4,000 characters.");
  }

  const flow = String(copy.messageFlow ?? "").trim();
  if (flow.length < 40) {
    problems.push("Describe where customers agree to be texted, in a full sentence. Leaving this out is one of the most common reasons the carriers reject a registration.");
  } else if (flow.length > 4096) {
    problems.push("That consent description is longer than the carriers accept. Keep it under about 4,000 characters.");
  }

  const samples = (Array.isArray(copy.messageSamples) ? copy.messageSamples : [])
    .map((s) => String(s ?? "").trim()).filter(Boolean);
  if (samples.length < 2) problems.push("Two example messages are required. Write ones you would really send.");
  if (samples.length > 5) problems.push("Five example messages is the most the carriers accept.");
  if (samples.some((s) => s.length < 20)) {
    problems.push("One of the example messages is too short — write it out the way you would actually send it.");
  }
  if (samples.some((s) => s.length > 1024)) {
    problems.push("One of the example messages is longer than a text message can be.");
  }
  // The single most-cited campaign rejection: no visible opt-out in the samples.
  if (samples.length && !samples.some((s) => /\bSTOP\b/i.test(s))) {
    problems.push("At least one example has to show people how to stop. Keep “Reply STOP to opt out” in it.");
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — Secondary Customer Profile
// ─────────────────────────────────────────────────────────────────────────────

/** Create the three EndUser/Address objects the profile is assembled from, then the
 *  profile itself, then attach everything and submit it for evaluation.
 *
 *  Returns the BU… SID of the SECONDARY CUSTOMER PROFILE. ⚠️ Not interchangeable with the
 *  A2P TrustProduct's BU… SID from stage 2 — they live at different paths and
 *  BrandRegistrations takes one of each. */
export async function createSecondaryCustomerProfile(opts: {
  intake: BuilderIntake;
  primaryProfileSid: string;   // OUR approved primary BU… (on the PARENT account, always)
  friendlyName: string;
}, creds?: TrustHubCreds | null): Promise<{ profileSid: string; endUserSid: string; addressSid: string; repSid: string }> {
  const { intake } = opts;
  const as = (method: "GET" | "POST", url: string, form?: Record<string, string>) => call(method, url, form, undefined, creds);

  const business = await as("POST", `${TRUSTHUB}/EndUsers`, {
    FriendlyName: `${opts.friendlyName} — business info`,
    Type: "customer_profile_business_information",
    "Attributes": JSON.stringify({
      business_name: intake.legalBusinessName,
      social_media_profile_urls: "",
      website_url: intake.websiteUrl,
      business_regions_of_operation: "USA_AND_CANADA",
      business_type: intake.businessType,
      business_registration_identifier: "EIN",
      business_identity: "direct_customer",   // ⚠️ never isv_reseller_or_partner — that is OURS
      business_industry: intake.businessIndustry,
      business_registration_number: intake.ein,
    }),
  });

  const rep = await as("POST", `${TRUSTHUB}/EndUsers`, {
    FriendlyName: `${opts.friendlyName} — authorized rep`,
    Type: "authorized_representative_1",
    "Attributes": JSON.stringify({
      job_position: intake.repJobPosition,
      last_name: intake.repLastName,
      phone_number: intake.repPhone,
      first_name: intake.repFirstName,
      email: intake.repEmail,
      business_title: intake.repBusinessTitle,
    }),
  });

  const acct = acctOf(creds);
  const address = await as("POST", `https://api.twilio.com/2010-04-01/Accounts/${acct}/Addresses.json`, {
    CustomerName: intake.legalBusinessName,
    Street: intake.street,
    City: intake.city,
    Region: intake.region,
    PostalCode: intake.postalCode,
    IsoCountry: intake.isoCountry || "US",
  });
  const addressSid = String(address?.sid ?? "");

  const doc = await as("POST", `${TRUSTHUB}/SupportingDocuments`, {
    FriendlyName: `${opts.friendlyName} — address`,
    Type: "customer_profile_address",
    "Attributes": JSON.stringify({ address_sids: addressSid }),
  });

  const profile = await as("POST", `${TRUSTHUB}/CustomerProfiles`, {
    FriendlyName: opts.friendlyName,
    Email: intake.repEmail,
    PolicySid: POLICY_SECONDARY_CUSTOMER_PROFILE,
  });
  const profileSid = String(profile?.sid ?? "");

  for (const objectSid of [business?.sid, rep?.sid, doc?.sid]) {
    if (!objectSid) continue;
    await as("POST", `${TRUSTHUB}/CustomerProfiles/${profileSid}/EntityAssignments`, {
      ObjectSid: String(objectSid),
    });
  }
  // ⚠️ The PRIMARY profile is assigned onto the secondary. This is the step that says
  // "this builder is a customer of ours" and it is what makes the ISV relationship real. In a
  // sub-account the primary is the PARENT's, so this assignment crosses accounts. Twilio's ISV
  // guide documents it (architecture #1), but it had not been tried on our account when this
  // was written: the phase 6 spike (scripts/twilio-a2p-spike.ts) proves it on a test sub before
  // any builder depends on it. A refusal here is a PrimaryProfileLinkError carrying the profile
  // it stopped on, so the caller can write that profile down and FINISH it on the next press
  // (finishSecondaryCustomerProfile) instead of making a second set of objects. Same request
  // as always: nothing new is sent on a profile that is created in one go.
  try {
    await as("POST", `${TRUSTHUB}/CustomerProfiles/${profileSid}/EntityAssignments`, {
      ObjectSid: opts.primaryProfileSid,
    });
  } catch (e) {
    if (e instanceof TrustHubError) throw new PrimaryProfileLinkError(e, profileSid, crossAccount(creds));
    throw e;
  }

  await as("POST", `${TRUSTHUB}/CustomerProfiles/${profileSid}/Evaluations`, {
    PolicySid: POLICY_SECONDARY_CUSTOMER_PROFILE,
  });
  await as("POST", `${TRUSTHUB}/CustomerProfiles/${profileSid}`, { Status: "pending-review" });

  return { profileSid, endUserSid: String(business?.sid ?? ""), addressSid, repSid: String(rep?.sid ?? "") };
}

/** The marker every PrimaryProfileLinkError's message starts with. */
export const PRIMARY_LINK_REFUSED = "primary_profile_link_refused";

/**
 * Twilio refused (or never answered) the EntityAssignment that puts the platform's PRIMARY
 * customer profile onto a builder's SECONDARY one: the ISV link. A TrustHubError, so every
 * existing catch still handles it; typed, so a caller can tell this one apart:
 *   profileSid    the secondary profile that WAS made and is now waiting for the link. Record it,
 *                 and the next press finishes it (finishSecondaryCustomerProfile) rather than
 *                 making a second profile.
 *   crossAccount  the secondary lives in a SUB-account (the primary is always the parent's), i.e.
 *                 the cross-account assignment phase 6's spike proves. false = both in one account
 *                 (today's flow, where this has never failed).
 * Codes only travel outward (this file's header rule); `detail` keeps Twilio's body for app_errors.
 */
export class PrimaryProfileLinkError extends TrustHubError {
  readonly profileSid: string;
  readonly crossAccount: boolean;
  constructor(cause: TrustHubError, profileSid: string, crossAccount: boolean) {
    super({
      message: `${PRIMARY_LINK_REFUSED}: Twilio did not link the primary customer profile to the secondary one${crossAccount ? " across accounts" : ""} (HTTP ${cause.status}, code ${cause.code}).`,
      status: cause.status, code: cause.code, permanent: cause.permanent, detail: cause.detail,
    });
    this.name = "PrimaryProfileLinkError";
    this.profileSid = profileSid;
    this.crossAccount = crossAccount;
  }
}

/** Do these credentials name an account other than the environment's own (the parent)? */
function crossAccount(creds: TrustHubCreds | null | undefined): boolean {
  if (!creds || !creds.accountSid) return false;
  let parent = "";
  try { parent = accountSid() ?? ""; } catch { parent = ""; }
  return creds.accountSid !== parent;
}

/** The objects assigned onto a customer profile (its EntityAssignments' object_sid), GET only. */
async function profileObjects(profileSid: string, http: TrustHubHttp): Promise<string[]> {
  const r = await http("GET", `${TRUSTHUB}/CustomerProfiles/${profileSid}/EntityAssignments?PageSize=50`);
  const rows = Array.isArray(r?.results) ? r.results : [];
  return rows.map((a: any) => String(a?.object_sid ?? "")).filter(Boolean);
}

/** Is the platform's primary profile assigned onto this secondary profile? GET only: what the
 *  phase 6 spike prints, and what finishSecondaryCustomerProfile asks before it links. */
export async function primaryProfileLinked(profileSid: string, primaryProfileSid: string, http: TrustHubHttp = viaCall): Promise<boolean> {
  if (!SID.bundle.test(profileSid) || !SID.bundle.test(primaryProfileSid)) throw badInput("A customer profile SID is malformed.");
  return (await profileObjects(profileSid, http)).includes(primaryProfileSid);
}

/**
 * Finish a secondary customer profile whose creation stopped at, or before, the primary link (a
 * PrimaryProfileLinkError, or a lost response): link the primary if it is not linked yet, then
 * evaluate and submit the profile if it is still a draft. Every step is read first, so pressing it
 * again on a finished profile sends nothing. A refused link is a PrimaryProfileLinkError again.
 * `crossAccount` only labels that error (see PrimaryProfileLinkError).
 */
export async function finishSecondaryCustomerProfile(
  profileSid: string, primaryProfileSid: string, http: TrustHubHttp = viaCall, opts: { crossAccount?: boolean } = {},
): Promise<{ linked: boolean; submitted: boolean; status: TrustProductStatus | null }> {
  if (!SID.bundle.test(profileSid) || !SID.bundle.test(primaryProfileSid)) throw badInput("A customer profile SID is malformed.");
  let linked = false;
  if (!(await profileObjects(profileSid, http)).includes(primaryProfileSid)) {
    try {
      await http("POST", `${TRUSTHUB}/CustomerProfiles/${profileSid}/EntityAssignments`, { ObjectSid: primaryProfileSid });
    } catch (e) {
      if (e instanceof TrustHubError) throw new PrimaryProfileLinkError(e, profileSid, opts.crossAccount === true);
      throw e;
    }
    linked = true;
  }
  const p = await http("GET", `${TRUSTHUB}/CustomerProfiles/${profileSid}`);
  let status = trustProductStatus(p?.status);
  let submitted = false;
  if (status === "draft") {
    await http("POST", `${TRUSTHUB}/CustomerProfiles/${profileSid}/Evaluations`, { PolicySid: POLICY_SECONDARY_CUSTOMER_PROFILE });
    const s = await http("POST", `${TRUSTHUB}/CustomerProfiles/${profileSid}`, { Status: "pending-review" });
    status = trustProductStatus(s?.status) ?? "pending-review";
    submitted = true;
  }
  return { linked, submitted, status };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — A2P TrustProduct
// ─────────────────────────────────────────────────────────────────────────────

export async function createA2pTrustProduct(opts: {
  profileSid: string;          // the SECONDARY customer profile from stage 1
  email: string;
  friendlyName: string;
  companyType?: "private" | "public" | "non-profit" | "government";
}, creds?: TrustHubCreds | null): Promise<{ a2pProfileSid: string }> {
  const as = (method: "GET" | "POST", url: string, form?: Record<string, string>) => call(method, url, form, undefined, creds);
  const messagingProfile = await as("POST", `${TRUSTHUB}/EndUsers`, {
    FriendlyName: `${opts.friendlyName} — A2P profile`,
    Type: "us_a2p_messaging_profile_information",
    "Attributes": JSON.stringify({
      // Essentially every shed builder is private. stock_ticker/stock_exchange are omitted
      // deliberately — sending them empty on a private company is itself a rejection cause.
      company_type: opts.companyType ?? "private",
    }),
  });

  const tp = await as("POST", `${TRUSTHUB}/TrustProducts`, {
    FriendlyName: opts.friendlyName,
    Email: opts.email,
    PolicySid: POLICY_A2P_TRUST_PRODUCT,
  });
  const a2pProfileSid = String(tp?.sid ?? "");

  await as("POST", `${TRUSTHUB}/TrustProducts/${a2pProfileSid}/EntityAssignments`, {
    ObjectSid: String(messagingProfile?.sid ?? ""),
  });
  await as("POST", `${TRUSTHUB}/TrustProducts/${a2pProfileSid}/EntityAssignments`, {
    ObjectSid: opts.profileSid,
  });

  await as("POST", `${TRUSTHUB}/TrustProducts/${a2pProfileSid}/Evaluations`, {
    PolicySid: POLICY_A2P_TRUST_PRODUCT,
  });
  await as("POST", `${TRUSTHUB}/TrustProducts/${a2pProfileSid}`, { Status: "pending-review" });

  return { a2pProfileSid };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — Brand
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ THIS SPENDS MONEY. Take the single-flight lock first.
 *
 * ⚠️ Neither bundle has to be APPROVED before this runs — Twilio's ISV guide says so
 * explicitly ("You don't need to wait for this TrustProduct's status to be approved"),
 * which removes a serialisation point worth days.
 */
export async function registerBrand(opts: {
  customerProfileBundleSid: string;   // BU… from stage 1
  a2pProfileBundleSid: string;        // BU… from stage 2
  tier: "low_volume_standard" | "standard" | "sole_proprietor";
  /** Register a MOCK brand: free, unvetted, cannot send, deleted by Twilio after 30 days.
   *  Only ever true for an internal account — the database trigger in migration 170 makes
   *  that an invariant rather than a convention. */
  mock?: boolean;
}, creds?: TrustHubCreds | null): Promise<{ brandSid: string; status: string; identityStatus: string | null; mock: boolean }> {
  const form: Record<string, string> = {
    CustomerProfileBundleSid: opts.customerProfileBundleSid,
    A2PProfileBundleSid: opts.a2pProfileBundleSid,
    // ⚠️ SENT EXPLICITLY. The docs give a default only for `mock`; BrandType carries no
    // documented default, so relying on one is relying on undocumented behaviour.
    BrandType: opts.tier === "sole_proprietor" ? "SOLE_PROPRIETOR" : "STANDARD",
  };
  // ⚠️ THIS BOOLEAN IS "Low-Volume Standard". LVS is not a BrandType — the enum has only
  // STANDARD and SOLE_PROPRIETOR. Skipping automatic secondary vetting is what makes the
  // brand $4.50 instead of $46, at the cost of a lower throughput ceiling (2,000 T-Mobile
  // segments/day), which is far above anything a shed builder sends.
  if (opts.tier === "low_volume_standard") form.SkipAutomaticSecVet = "true";
  // ⚠️ SENT ONLY WHEN TRUE. Twilio documents the default as false, and sending "false"
  // explicitly would be relying on it parsing the string the way we expect. Absent is the
  // safer way to say "real".
  if (opts.mock) form.Mock = "true";

  const b = await call("POST", `${MESSAGING}/a2p/BrandRegistrations`, form, undefined, creds);
  // ⚠️ TRUST TWILIO'S ANSWER, NOT OUR REQUEST. The response carries `mock`, so the row
  // records what was actually created rather than what we asked for. If the parameter were
  // ever ignored we would have registered a REAL brand while believing otherwise, and the
  // bill would be the first anyone heard of it.
  return {
    brandSid: String(b?.sid ?? ""),
    status: String(b?.status ?? "PENDING"),
    identityStatus: b?.identity_status ? String(b.identity_status) : null,
    mock: b?.mock === true,
  };
}

export async function fetchBrand(brandSid: string, creds?: TrustHubCreds | null): Promise<{
  status: string; identityStatus: string | null; tcrId: string | null; errors: unknown[];
}> {
  const b = await call("GET", `${MESSAGING}/a2p/BrandRegistrations/${brandSid}`, undefined, undefined, creds);
  return {
    status: String(b?.status ?? ""),
    identityStatus: b?.identity_status ? String(b.identity_status) : null,
    tcrId: b?.tcr_id ? String(b.tcr_id) : null,
    // ⚠️ errors[], NOT brand_feedback / failure_reason. Both of those are documented
    // DEPRECATED, so a rejection UI built on them silently goes blank.
    errors: Array.isArray(b?.errors) ? b.errors : [],
  };
}

/** Resubmit a failed brand. Twilio allows THREE free retries; the fourth returns HTTP 400
 *  with error 21724. Whatever is actually being fixed lives upstream in the bundle's
 *  EndUsers — PATCH those first; this call takes only the SID. */
export async function updateBrand(brandSid: string, creds?: TrustHubCreds | null): Promise<{ status: string }> {
  const b = await call("POST", `${MESSAGING}/a2p/BrandRegistrations/${brandSid}`, {}, undefined, creds);
  return { status: String(b?.status ?? "") };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stages 5–7 — Messaging Service and Campaign
// ─────────────────────────────────────────────────────────────────────────────

export async function createMessagingService(opts: {
  friendlyName: string;
  inboundWebhookUrl: string;
  statusCallbackUrl: string;
}, creds?: TrustHubCreds | null): Promise<{ serviceSid: string }> {
  const s = await call("POST", `${MESSAGING}/Services`, {
    FriendlyName: opts.friendlyName,
    InboundRequestUrl: opts.inboundWebhookUrl,
    StatusCallback: opts.statusCallbackUrl,
    // Twilio answers STOP/HELP itself on the service. Our own ledger still records it —
    // the carrier block and our block must agree, and ours is what the composer reads.
    UseInboundWebhookOnNumber: "false",
  }, undefined, creds);
  return { serviceSid: String(s?.sid ?? "") };
}

/** ⚠️ NEVER HARDCODE A USE CASE. What a brand may register depends on the brand, and the
 *  eligible list is only knowable after approval. */
export async function fetchEligibleUseCases(serviceSid: string, brandSid: string, creds?: TrustHubCreds | null): Promise<Array<{
  code: string; name: string; description: string; postApprovalRequired: boolean;
}>> {
  const r = await call("GET", `${MESSAGING}/Services/${serviceSid}/Compliance/Usa2p/Usecases?BrandRegistrationSid=${encodeURIComponent(brandSid)}`, undefined, undefined, creds);
  const list = Array.isArray(r?.us_app_to_person_usecases) ? r.us_app_to_person_usecases : [];
  return list.map((u: any) => ({
    code: String(u?.code ?? ""),
    name: String(u?.name ?? ""),
    description: String(u?.description ?? ""),
    postApprovalRequired: !!u?.post_approval_required,
  }));
}

export type CampaignCopy = {
  description: string;
  messageFlow: string;         // how consent is obtained, in words TCR will check against the site
  messageSamples: string[];    // 2–5, each 20–1024 chars, naming the BUILDER
  optInKeywords?: string;
  optOutKeywords?: string;
  helpKeywords?: string;
  optInMessage?: string;
  optOutMessage?: string;
  helpMessage?: string;
};

/** ⚠️ BOTH URLS ARE MANDATORY, AND OMITTING THEM IS A ONE-SECOND REJECTION.
 *
 *  TCR made `PrivacyPolicyUrl` and `TermsAndConditionsUrl` required on campaign registration on
 *  2026-06-30. We collected both from the builder, stored them, showed them back on the form —
 *  and never put them on the wire, so two live campaigns were refused 1.1 SECONDS after creation
 *  with 30908 (PRIVACY_POLICY_URL) + 30882 (TERMS_AND_CONDITIONS_URL). A verdict that fast is
 *  field validation, not a review: nothing had crawled anything. A whole day was lost to the
 *  theory that the marketing site was at fault, and the tell was hiding in plain sight —
 *  **the plain v1 GET omits both keys entirely**, so the resource looked complete. Ask for them
 *  with `X-Twilio-Api-Version: v1.2` and they read `null`.
 *
 *  Callers pass them explicitly rather than through `CampaignCopy`: they are intake fields the
 *  builder typed once on their details screen, not the paragraphs they author per campaign. */
/** The one POST both campaign writes share.
 *
 *  ⚠️ NOT `call()`, and this is deliberate: `MessageSamples` is a REPEATED key and a
 *  `Record<string,string>` cannot hold a duplicate, so the body has to be a URLSearchParams
 *  built by hand.
 *
 *  ⚠️ `X-Twilio-Api-Version: v1.2` is sent on purpose. It is what makes the two policy-URL
 *  fields visible on the Usa2p resource at all — the plain v1 view drops them, which is
 *  precisely how they stayed null and unnoticed through two rejections. Proven against the
 *  live API with this header on both the write and the read-back. */
async function campaignPost(url: string, params: URLSearchParams, creds?: TrustHubCreds | null): Promise<any> {
  // ⚠️ ASSERT THE WIRE, NOT THE ARGUMENTS — this is the check that would have caught the
  // 2026-09-02 rejection and `requirePolicyUrls` would not have. The arguments were correct
  // that day: both URLs were typed, validated, stored and echoed back on the form. What was
  // wrong was the gap between them and the request body, and every guard we had inspected
  // the wrong side of it. This is the last statement before the bytes leave, so a future
  // refactor that drops an `append` cannot be quiet about it.
  for (const key of ["PrivacyPolicyUrl", "TermsAndConditionsUrl"]) {
    if (!String(params.get(key) ?? "").trim()) {
      throw new TrustHubError({
        message: `The campaign request is missing ${key}. The carriers refuse a campaign without a privacy policy and terms URL.`,
        status: 400, code: 0, permanent: true,
      });
    }
  }
  const pair = pairFor(creds);
  if (!pair) throw new TrustHubError({ message: "Twilio credentials are not configured.", status: 0, code: 0, permanent: true });
  await throttle();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${pair.user}:${pair.pass}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Api-Version": "v1.2",
    },
    body: params.toString(),
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
  if (!res.ok) {
    const code = typeof body?.code === "number" ? body.code : 0;
    throw new TrustHubError({
      message: `Twilio refused the campaign (HTTP ${res.status}, code ${code}).`,
      status: res.status, code, permanent: PERMANENT_CODES.has(code), detail: body,
    });
  }
  return body;
}

function requirePolicyUrls(privacyPolicyUrl: string, termsUrl: string): void {
  if (!/^https?:\/\//i.test(privacyPolicyUrl) || !/^https?:\/\//i.test(termsUrl)) {
    throw new TrustHubError({
      message: "The carriers require a public privacy policy URL and a terms URL before a campaign can be registered.",
      status: 400, code: 0, permanent: true,
    });
  }
}

export async function createCampaign(opts: {
  serviceSid: string;
  brandSid: string;
  useCase: string;
  copy: CampaignCopy;
  privacyPolicyUrl: string;
  termsUrl: string;
  hasEmbeddedLinks?: boolean;
  hasEmbeddedPhone?: boolean;
}, creds?: TrustHubCreds | null): Promise<{ campaignSid: string; status: string; policyUrlsEchoed: boolean }> {
  requirePolicyUrls(opts.privacyPolicyUrl, opts.termsUrl);
  const form: Record<string, string> = {
    BrandRegistrationSid: opts.brandSid,
    Description: opts.copy.description,
    MessageFlow: opts.copy.messageFlow,
    UsAppToPersonUsecase: opts.useCase,
    HasEmbeddedLinks: String(!!opts.hasEmbeddedLinks),
    HasEmbeddedPhone: String(!!opts.hasEmbeddedPhone),
    PrivacyPolicyUrl: opts.privacyPolicyUrl,
    TermsAndConditionsUrl: opts.termsUrl,
  };
  // ⚠️ MessageSamples is a REPEATED key, not a comma-joined string — Twilio wants one
  // MessageSamples= parameter per sample. That is why this is built by hand rather than
  // through the Record above, which cannot hold a duplicate key.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) params.append(k, v);
  for (const sample of opts.copy.messageSamples.slice(0, 5)) params.append("MessageSamples", sample);
  if (opts.copy.optInKeywords) params.append("OptInKeywords", opts.copy.optInKeywords);
  if (opts.copy.optOutKeywords) params.append("OptOutKeywords", opts.copy.optOutKeywords);
  if (opts.copy.helpKeywords) params.append("HelpKeywords", opts.copy.helpKeywords);
  if (opts.copy.optInMessage) params.append("OptInMessage", opts.copy.optInMessage);
  if (opts.copy.optOutMessage) params.append("OptOutMessage", opts.copy.optOutMessage);
  if (opts.copy.helpMessage) params.append("HelpMessage", opts.copy.helpMessage);

  const body = await campaignPost(`${MESSAGING}/Services/${opts.serviceSid}/Compliance/Usa2p`, params, creds);
  return {
    campaignSid: String(body?.sid ?? ""),
    status: String(body?.campaign_status ?? body?.status ?? "PENDING"),
    policyUrlsEchoed: policyUrlsEchoed(body),
  };
}

/**
 * ✅ A REJECTED CAMPAIGN IS EDITED IN PLACE — IT IS NEVER DELETED AND RE-CREATED.
 *
 * `UpdateUsAppToPerson` is `POST` to the campaign's own path. Twilio's rule is that **the
 * vetting fee is assessed once per campaign**, so resubmitting the same resource is free and
 * unlimited, while delete-and-recreate buys a second vetting. This file asserted the exact
 * opposite for weeks ("THERE IS NO UPDATE OPERATION"), and that single false comment is what
 * made destruction look like the only road — it cost a live campaign on 2026-09-02.
 * Verified against Twilio's OpenAPI spec and then against the live API: a campaign already in
 * FAILED state accepts this call and goes back to IN_PROGRESS with its `errors` array cleared.
 *
 * ⚠️ The seven fields below are ALL REQUIRED by the update contract — this is not a patch, it
 * is a whole-resource write, so a caller that omits one gets a 400. `UsAppToPersonUsecase`,
 * the keywords and the opt-in/out/help messages are **create-only** and cannot be corrected
 * here; getting those wrong really does mean starting over.
 */
export async function updateCampaign(opts: {
  serviceSid: string;
  campaignSid: string;
  copy: CampaignCopy;
  privacyPolicyUrl: string;
  termsUrl: string;
  hasEmbeddedLinks?: boolean;
  hasEmbeddedPhone?: boolean;
}, creds?: TrustHubCreds | null): Promise<{ campaignSid: string; status: string; policyUrlsEchoed: boolean }> {
  requirePolicyUrls(opts.privacyPolicyUrl, opts.termsUrl);
  const params = new URLSearchParams();
  params.append("Description", opts.copy.description);
  params.append("MessageFlow", opts.copy.messageFlow);
  params.append("HasEmbeddedLinks", String(!!opts.hasEmbeddedLinks));
  params.append("HasEmbeddedPhone", String(!!opts.hasEmbeddedPhone));
  params.append("AgeGated", "false");
  params.append("DirectLending", "false");
  params.append("PrivacyPolicyUrl", opts.privacyPolicyUrl);
  params.append("TermsAndConditionsUrl", opts.termsUrl);
  for (const sample of opts.copy.messageSamples.slice(0, 5)) params.append("MessageSamples", sample);

  const body = await campaignPost(
    `${MESSAGING}/Services/${opts.serviceSid}/Compliance/Usa2p/${opts.campaignSid}`,
    params,
    creds,
  );
  return {
    campaignSid: String(body?.sid ?? opts.campaignSid),
    status: String(body?.campaign_status ?? body?.status ?? "PENDING"),
    policyUrlsEchoed: policyUrlsEchoed(body),
  };
}

/** Did the campaign Twilio just wrote come BACK carrying both policy URLs?
 *
 *  ⚠️ REPORTED, NEVER THROWN, and the distinction is load-bearing. By the time this can be
 *  answered the campaign EXISTS and has been vetted; throwing here would abandon a live,
 *  billed resource before its SID was written down — the orphan bug the Messaging Service
 *  comment in portal-sms already documents once. The caller records a false, which is how a
 *  silent regression of the 09-02 shape becomes a log row instead of another lost week. */
function policyUrlsEchoed(body: any): boolean {
  return !!String(body?.privacy_policy_url ?? "").trim()
    && !!String(body?.terms_and_conditions_url ?? "").trim();
}

/** ⚠️ READ THE ITEM, NOT THE COLLECTION. `GET …/Compliance/Usa2p` answers an ENVELOPE —
 *  `{ compliance: [ … ], meta: { … } }` — so `r.campaign_status` off the top level is
 *  ALWAYS `undefined`. `normalizeCampaignStatus("")` then returns "PENDING", which means
 *  this poller could never once report APPROVED or FAILED: for its whole life it answered
 *  "still waiting" no matter what the carriers had decided, and Event Streams was silently
 *  the only thing moving the state machine. Anything that depended on the poll as a backstop
 *  — a missed webhook, a sink that was never wired — simply never recovered. */
export async function fetchCampaign(
  serviceSid: string,
  creds?: TrustHubCreds | null,
): Promise<{
  status: string; sid: string | null; privacyPolicyUrl: string; termsUrl: string;
  errors: unknown[]; description: string; messageFlow: string; messageSamples: string[];
}> {
  // ⚠️ `X-Twilio-Api-Version: v1.2` OR THIS READ IS BLIND TO THE TWO FIELDS THE 09-02 OUTAGE
  // WAS ABOUT. The plain v1 view omits both keys entirely — not null, ABSENT — so a poller
  // without this header reports a campaign as complete while the carriers hold nothing. It
  // is the single cheapest way to prove what Twilio actually has, which is why the compliance
  // check reads them from here rather than from our own row.
  const r = await call("GET", `${MESSAGING}/Services/${serviceSid}/Compliance/Usa2p`, undefined, {
    "X-Twilio-Api-Version": "v1.2",
  }, creds);
  const one = Array.isArray(r?.compliance) ? r.compliance[0] : r;
  return {
    privacyPolicyUrl: String(one?.privacy_policy_url ?? ""),
    termsUrl: String(one?.terms_and_conditions_url ?? ""),
    // ⚠️ THE REASONS, READ FROM THE SOURCE. Relying on the Event Streams webhook to deliver
    // these is how the rejection card ended up rendering "They told us why" over an empty
    // list: one missed delivery and the builder never learns what was wrong. Twilio holds
    // the verdict either way, so read it.
    errors: Array.isArray(one?.errors) ? one.errors : [],
    // What the carriers ACTUALLY hold, which is not always what our row holds — an operator
    // editing the campaign through the API leaves the two out of step, and then the form
    // shows text that was never submitted.
    description: String(one?.description ?? ""),
    messageFlow: String(one?.message_flow ?? ""),
    messageSamples: Array.isArray(one?.message_samples) ? one.message_samples.map(String) : [],
    status: String(one?.campaign_status ?? one?.status ?? ""),
    sid: one?.sid ? String(one.sid) : null,
  };
}

/** The RELEASE path — stopping the monthly fee when a builder leaves. It is NOT the fix for a
 *  rejection: see `updateCampaign` above, which is free where this is destructive. */
/** ⚠️ THE CAMPAIGN SID BELONGS ON THE PATH. Without it Twilio answers 405 (code 20004,
 *  "does not support the attempted HTTP method DELETE"), which reads like a permissions or
 *  API-version problem rather than a missing path segment. Proven against the live API on
 *  2026-08-31 while clearing the step-1 test objects; this function had no callers, so the
 *  wrong URL had never been exercised.
 *
 *  Pass the QE… sid the REST API returns, NOT the CM… one from Event Streams — they are
 *  different SID spaces and the CM sid matches nothing here. */
export async function deleteCampaign(serviceSid: string, campaignSid: string, creds?: TrustHubCreds | null): Promise<void> {
  await call("DELETE", `${MESSAGING}/Services/${serviceSid}/Compliance/Usa2p/${campaignSid}`, undefined, undefined, creds);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 8 — Numbers
// ─────────────────────────────────────────────────────────────────────────────

export async function searchAvailableNumbers(opts: {
  areaCode?: string;
  contains?: string;
  inRegion?: string;
  limit?: number;
}, creds?: TrustHubCreds | null): Promise<Array<{ phoneNumber: string; friendlyName: string; locality: string | null; region: string | null }>> {
  const acct = acctOf(creds);
  const p = new URLSearchParams({
    SmsEnabled: "true",
    MmsEnabled: "true",
    VoiceEnabled: "true",
    // Numbers requiring a local address bring an extra compliance step per number; exclude
    // them so a builder cannot pick one that silently blocks their own activation.
    ExcludeAllAddressRequired: "true",
    PageSize: String(Math.min(Math.max(opts.limit ?? 10, 1), 30)),
  });
  if (opts.areaCode) p.append("AreaCode", opts.areaCode);
  if (opts.contains) p.append("Contains", opts.contains);
  if (opts.inRegion) p.append("InRegion", opts.inRegion);

  const r = await call("GET", `https://api.twilio.com/2010-04-01/Accounts/${acct}/AvailablePhoneNumbers/US/Local.json?${p.toString()}`, undefined, undefined, creds);
  const list = Array.isArray(r?.available_phone_numbers) ? r.available_phone_numbers : [];
  return list.map((n: any) => ({
    phoneNumber: String(n?.phone_number ?? ""),
    friendlyName: String(n?.friendly_name ?? ""),
    // ⚠️ locality comes back NULL on real results. Render a blank, never the string "null".
    locality: n?.locality ? String(n.locality) : null,
    region: n?.region ? String(n.region) : null,
  })).filter((n: { phoneNumber: string }) => n.phoneNumber);
}

/**
 * Buy a number.
 *
 * ⚠️ IDEMPOTENCY: FriendlyName is set to the client_id on purchase, so a lost response can
 * be reconciled by LISTING IncomingPhoneNumbers?FriendlyName={client_id} rather than buying
 * a second number nobody knows about. Always reconcile before retrying a purchase.
 */
export async function purchaseNumber(opts: {
  phoneNumber: string;
  clientId: string;
  messagingServiceSid?: string | null;
}, creds?: TrustHubCreds | null): Promise<{ sid: string; phoneNumber: string }> {
  const acct = acctOf(creds);
  const form: Record<string, string> = {
    PhoneNumber: opts.phoneNumber,
    FriendlyName: opts.clientId,
  };
  const r = await call("POST", `https://api.twilio.com/2010-04-01/Accounts/${acct}/IncomingPhoneNumbers.json`, form, undefined, creds);
  const sid = String(r?.sid ?? "");
  if (opts.messagingServiceSid && sid) {
    await attachNumberToService(opts.messagingServiceSid, sid, trustHubHttp(creds));
  }
  return { sid, phoneNumber: String(r?.phone_number ?? opts.phoneNumber) };
}

/**
 * The transport every helper below takes as its LAST argument, defaulting to `call` (the
 * credentials, the 1-per-second throttle and TrustHubError). Injectable so the unit tests drive
 * each flow against a stub that answers like Twilio, with no network, no env and no throttle
 * wait. Same contract as `call`: it resolves with the parsed JSON body or throws TrustHubError.
 */
export type TrustHubHttp = (
  method: "GET" | "POST" | "DELETE",
  url: string,
  form?: Record<string, string>,
) => Promise<any>;
const viaCall: TrustHubHttp = (method, url, form) => call(method, url, form);

/**
 * The transport bound to one account's credentials, for the helpers that take `http`: pass it with
 * that account's SID as `acct` where a helper also takes one. null / omitted = the environment's
 * (viaCall), today's behaviour.
 */
export function trustHubHttp(creds?: TrustHubCreds | null): TrustHubHttp {
  return creds ? (method, url, form) => call(method, url, form, undefined, creds) : viaCall;
}

const SID = {
  service: /^MG[0-9a-f]{32}$/i,
  number: /^PN[0-9a-f]{32}$/i,
  bundle: /^BU[0-9a-f]{32}$/i,
  account: /^AC[0-9a-f]{32}$/i,
  endUser: /^IT[0-9a-f]{32}$/i,
};
function badInput(message: string): TrustHubError {
  return new TrustHubError({ message, status: 400, code: 0, permanent: true });
}

/**
 * Put a number into a Messaging Service (POST Services/{MG}/PhoneNumbers {PhoneNumberSid}).
 * purchaseNumber's own attach step, and the adoption of a calling-only number (portal-sms
 * buy_number, My Synergy Phone plan phase 6). One copy, so both attach the same way.
 * https://www.twilio.com/docs/messaging/api/phonenumber-resource
 */
export async function attachNumberToService(serviceSid: string, numberSid: string, http: TrustHubHttp = viaCall): Promise<void> {
  if (!SID.service.test(serviceSid) || !SID.number.test(numberSid)) throw badInput("A Messaging Service or number SID is malformed.");
  await http("POST", `${MESSAGING}/Services/${serviceSid}/PhoneNumbers`, { PhoneNumberSid: numberSid });
}

/**
 * Is this number already in this Messaging Service? The service's PhoneNumber resource is keyed
 * by the number's own PN… SID (the docs' `sid` pattern is ^PN…), so a fetch answers 404 when it
 * is not there. Read before attaching, so a retry after a lost response (attached at Twilio,
 * not yet recorded here) does not POST a second time into an error.
 * https://www.twilio.com/docs/messaging/api/phonenumber-resource ("Fetch a PhoneNumber resource")
 */
export async function numberInService(serviceSid: string, numberSid: string, http: TrustHubHttp = viaCall): Promise<boolean> {
  if (!SID.service.test(serviceSid) || !SID.number.test(numberSid)) throw badInput("A Messaging Service or number SID is malformed.");
  try {
    await http("GET", `${MESSAGING}/Services/${serviceSid}/PhoneNumbers/${numberSid}`);
    return true;
  } catch (e) {
    if (e instanceof TrustHubError && e.status === 404) return false;
    throw e;
  }
}

/** A number's PN… SID by its E.164, for a row recorded without one. null = not on this account. */
export async function findIncomingNumberSid(e164: string, http: TrustHubHttp = viaCall, acct: string | null = accountSid()): Promise<string | null> {
  if (!acct || !SID.account.test(acct)) throw badInput("TWILIO_ACCOUNT_SID is not configured.");
  const r = await http("GET", `https://api.twilio.com/2010-04-01/Accounts/${acct}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}&PageSize=5`);
  const list = Array.isArray(r?.incoming_phone_numbers) ? r.incoming_phone_numbers : [];
  const hit = list.find((n: any) => String(n?.phone_number ?? "") === e164);
  return hit && SID.number.test(String(hit.sid ?? "")) ? String(hit.sid) : null;
}

/**
 * Clear a number's own SmsUrl (Twilio clears a URL given as ""). Used when a calling-only number
 * joins a Messaging Service: its texts were routed by the number's SmsUrl to sms-inbound
 * (portal-settings, review SSB-3); from now on the service's inbound URL, which is sms-inbound
 * too, takes them, and a stale per-number URL is one more place a secret lives.
 */
export async function clearNumberSmsUrl(numberSid: string, http: TrustHubHttp = viaCall, acct: string | null = accountSid()): Promise<void> {
  if (!acct || !SID.account.test(acct)) throw badInput("TWILIO_ACCOUNT_SID is not configured.");
  if (!SID.number.test(numberSid)) throw badInput("The number SID is malformed.");
  await http("POST", `https://api.twilio.com/2010-04-01/Accounts/${acct}/IncomingPhoneNumbers/${numberSid}.json`, { SmsUrl: "" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Caller ID trust — SHAKEN/STIR, Voice Integrity and CNAM (My Synergy Phone, plan §14, phase 6;
// CNAM is Workstream 2's phase 6, POLICY_CNAM_TRUST_PRODUCT below)
// ─────────────────────────────────────────────────────────────────────────────
//
// Two Trust Products per builder number (three with CNAM), all built on the business profile the texting
// registration already created (stage 1 above), and all OPERATOR-ONLY: portal-settings'
// phone_trust_setup is the one caller, behind an app_operators check, and nothing runs this on
// a timer or a webhook.
//
//   SHAKEN/STIR       Twilio signs the builder's outbound calls at attestation level A only
//                     when the number is on BOTH an approved business profile and an approved
//                     SHAKEN/STIR Trust Product.
//   Voice Integrity   registers the number with the carriers' spam engines (T-Mobile, Verizon,
//                     AT&T), which is what fights "Spam Likely". Level A alone does not.
//   CNAM              the business's name (up to 15 characters) on the called party's screen,
//                     where their carrier looks CNAM up; 48-72 hours after approval.
//
// The flow, verbatim from Twilio's ISV guides (checked 2026-09-29; the Voice Integrity one says
// "The API flow for Voice Integrity Private Beta is subject to change"):
//   https://www.twilio.com/docs/voice/trusted-calling-with-shakenstir/shakenstir-onboarding/shaken-stir-trust-hub-api-isvs-single-project
//   https://www.twilio.com/docs/voice/spam-monitoring-with-voiceintegrity/voice-integrity-onboarding/voice-integrity-trust-hub-api-isvs-single-project
//   1. POST CustomerProfiles/{BU}/ChannelEndpointAssignments {ChannelEndpointType: phone-number,
//      ChannelEndpointSid: PN…} — "Only those phone numbers already assigned to your Secondary
//      Business Profile are eligible" for the Trust Product.
//   2. POST TrustProducts {FriendlyName, Email, PolicySid} — the policy SID is "a static value
//      that will stay the same across all accounts".
//   3. Voice Integrity only: POST EndUsers {Type: voice_integrity_information, Attributes:
//      {use_case, business_employee_count, average_business_day_call_volume, notes}}, then
//      POST TrustProducts/{BU}/EntityAssignments {ObjectSid: IT…}.
//   4. POST TrustProducts/{BU}/EntityAssignments {ObjectSid: <the business profile's BU…>}.
//   5. POST TrustProducts/{BU}/ChannelEndpointAssignments {ChannelEndpointType: phone-number,
//      ChannelEndpointSid: PN…} — "before or after submitting".
//   6. POST TrustProducts/{BU} {Status: pending-review}.
// Neither guide runs an Evaluation for these two products, so neither does this.
//
// EVERY STEP IS READ FIRST (list, then create only what is missing), for the same reason the
// Messaging Service SID is written down before anything else can throw: a response lost after
// Twilio acted must not become a second Trust Product. The Trust Product is also FOUND by its
// FriendlyName (`<client_id> — SHAKEN/STIR`), the FriendlyName=client_id trick purchaseNumber
// uses, and one made in the Console under the same profile is found by its entity assignment.

/** Twilio's SHAKEN/STIR Trust Product policy (the ISV guide's step 1, "Do not change"). */
export const POLICY_SHAKEN_STIR_TRUST_PRODUCT = "RN7a97559effdf62d00f4298208492a5ea";
/** Twilio's Voice Integrity Trust Product policy (the Voice Integrity ISV guide, same wording). */
export const POLICY_VOICE_INTEGRITY_TRUST_PRODUCT = "RN5b3660f9598883b1df4e77f77acefba0";

/**
 * Twilio's CNAM Trust Product policy (Workstream 2, phase 6), "Do not change the policy_sid", from
 * "Brand your calls using CNAM" (https://www.twilio.com/docs/voice/brand-your-calls-using-cnam,
 * checked 2026-10-09). The same Trust Hub steps as SHAKEN/STIR, plus one EndUser of type
 * `cnam_information` carrying the display name, in that guide's order:
 *   the number on the business profile (ChannelEndpointAssignments) → POST TrustProducts
 *   {FriendlyName, Email, PolicySid} → assign the business profile → POST EndUsers {Type:
 *   cnam_information, Attributes: {cnam_display_name}} and assign it → assign the number → POST
 *   TrustProducts/{BU} {Status: pending-review}. No Evaluation.
 * What it needs: the business profile tied to an EIN or a DUNS number (ours carry the EIN), a US
 * local long-code number already on that profile (not Canadian, not toll-free), and a display name
 * (parseCnamDisplayName). After Twilio approves it, the name takes 48-72 hours to reach every US
 * carrier, and only carriers that look CNAM up show it. In a builder's sub-account it runs with the
 * sub's credentials like everything else here.
 */
export const POLICY_CNAM_TRUST_PRODUCT = "RNf3db3cd1fe25fcfd3c3ded065c8fea53";

export type VoiceTrustKind = "shaken_stir" | "voice_integrity" | "cnam";
export const VOICE_TRUST_POLICY: Record<VoiceTrustKind, string> = {
  shaken_stir: POLICY_SHAKEN_STIR_TRUST_PRODUCT,
  voice_integrity: POLICY_VOICE_INTEGRITY_TRUST_PRODUCT,
  cnam: POLICY_CNAM_TRUST_PRODUCT,
};
/** The FriendlyName suffix each product is created with, after the client_id. */
export const VOICE_TRUST_NAME: Record<VoiceTrustKind, string> = {
  shaken_stir: "SHAKEN/STIR",
  voice_integrity: "Voice Integrity",
  cnam: "CNAM",
};

/** The longest CNAM display name the carriers' databases hold (Twilio's guide: 15 characters). */
export const CNAM_MAX = 15;

/**
 * An operator's CNAM display name → what Twilio is sent, or a sentence. Twilio's rules: at most 15
 * characters; letters, numbers, periods, commas and spaces only; it should begin with a letter (we
 * require it); unique to the business, and never a generic City/State (the default when no name is
 * set). Spaces are collapsed, so what is checked is what is sent.
 */
export function parseCnamDisplayName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "Enter the name callers should see, up to 15 characters." };
  if (name.length > CNAM_MAX) return { ok: false, error: `That name is ${name.length} characters; the carriers keep at most ${CNAM_MAX}. Shorten it.` };
  if (!/^[A-Za-z]/.test(name)) return { ok: false, error: "The name has to start with a letter." };
  if (!/^[A-Za-z0-9., ]+$/.test(name)) return { ok: false, error: "Use only letters, numbers, spaces, periods and commas." };
  return { ok: true, name };
}

/** Thrown by setupVoiceTrust when a CNAM product still needs its EndUser and the caller sent no
 *  display name. Matched by message, like VOICE_INTEGRITY_INFO_REQUIRED. */
export const CNAM_INFO_REQUIRED = "cnam_display_name_required";

/** The EndUser type CNAM's policy asks for, verbatim ("must stay as cnam_information"). */
const CNAM_END_USER_TYPE = "cnam_information";
export function voiceTrustFriendlyName(clientId: string, kind: VoiceTrustKind): string {
  return `${clientId} — ${VOICE_TRUST_NAME[kind]}`;
}

/** The TrustProduct (and CustomerProfile) `status` enum, from the TrustProduct resource's
 *  OpenAPI definition (https://www.twilio.com/docs/trust-hub/trusthub-rest-api/trust-products). */
export const TRUST_PRODUCT_STATUSES = ["draft", "pending-review", "in-review", "twilio-rejected", "twilio-approved"] as const;
export type TrustProductStatus = typeof TRUST_PRODUCT_STATUSES[number];
/** A status Twilio sent, or null for anything outside the enum — never guessed into "approved". */
export function trustProductStatus(raw: unknown): TrustProductStatus | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return (TRUST_PRODUCT_STATUSES as readonly string[]).includes(v) ? v as TrustProductStatus : null;
}

/** voice_integrity_information `use_case`, the guide's "Possible Values", verbatim. */
export const VOICE_INTEGRITY_USE_CASES = [
  "Identify & Verification", "Asset Management", "Lead Generation", "Intelligent Routing",
  "Appointment Scheduling", "Customer Support", "Self-Service", "Automated Support",
  "Appointment Reminders", "Employee Notifications", "Delivery Notifications", "Emergency Notifications",
  "Contactless Delivery", "Order Notifications", "Service Alerts", "Purchase Confirmation", "Mass Alerts",
  "Fraud Alerts", "Contact Tracing", "Lead Management", "Lead Nurturing", "Telemarketing",
  "Marketing Events", "Rewards Program", "Lead Alerts", "Lead Distribution", "Abandoned Cart",
  "Call Tracking", "Outbound Dialer", "Click to Call", "Phone System", "Meetings/Collaboration",
  "Telehealth", "Distance Learning", "Shift Management", "Field Notifications", "Dating/Social",
  "Remote appointments", "Group Messaging", "Exam Proctoring", "Tutoring", "Therapy (Individual+Group)",
  "Pharmacy", "First Responder", "Survey/Research",
] as const;

export type VoiceIntegrityInfo = {
  useCase: typeof VOICE_INTEGRITY_USE_CASES[number];
  employeeCount: number;
  averageDailyCalls: number;
  notes: string;
};

/** The operator's Voice Integrity answers → the EndUser's fields, or a sentence. The numbers are
 *  whole and positive because Twilio reviews them against the business; a 0 reads as a typo. */
export function parseVoiceIntegrityInfo(raw: unknown): { ok: true; info: VoiceIntegrityInfo } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const useCase = String(r.useCase ?? "").trim();
  if (!(VOICE_INTEGRITY_USE_CASES as readonly string[]).includes(useCase)) {
    return { ok: false, error: "Choose what the business uses calls for from the list." };
  }
  const whole = (v: unknown) => {
    const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
    return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : null;
  };
  const employeeCount = whole(r.employeeCount);
  if (employeeCount === null) return { ok: false, error: "Enter how many people work for the business, as a whole number." };
  const averageDailyCalls = whole(r.averageDailyCalls);
  if (averageDailyCalls === null) return { ok: false, error: "Enter about how many calls the business makes on a working day, as a whole number." };
  const notes = String(r.notes ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  return { ok: true, info: { useCase: useCase as VoiceIntegrityInfo["useCase"], employeeCount, averageDailyCalls, notes } };
}

/** Thrown by setupVoiceTrust when a Voice Integrity product still needs its EndUser and the
 *  caller sent no answers for it. Matched by message, so it can be told apart from Twilio's. */
export const VOICE_INTEGRITY_INFO_REQUIRED = "voice_integrity_info_required";

/** The EndUser type Voice Integrity's policy asks for (the ISV guide's step 2). */
const VOICE_INTEGRITY_END_USER_TYPE = "voice_integrity_information";

/** The four attributes, as the guide names them. One copy, so creating the EndUser and
 *  correcting it on a resubmit send exactly the same shape. */
function voiceIntegrityAttributes(vi: VoiceIntegrityInfo): string {
  return JSON.stringify({
    use_case: vi.useCase,
    business_employee_count: String(vi.employeeCount),
    average_business_day_call_volume: String(vi.averageDailyCalls),
    notes: vi.notes,
  });
}

/** A Trust Product we may (re)submit: never sent, or sent back by Twilio. Under review or
 *  approved, nothing on it is changed and nothing is sent again. */
function resubmittable(status: TrustProductStatus | null): boolean {
  return status === "draft" || status === "twilio-rejected";
}

async function listResults(http: TrustHubHttp, url: string): Promise<any[]> {
  const r = await http("GET", url);
  return Array.isArray(r?.results) ? r.results : [];
}

/** Is this number already assigned to this business profile (its ChannelEndpointAssignments,
 *  filtered by ChannelEndpointSid)? A number sits on ONE business profile, so a number an
 *  operator put on the platform's primary profile by hand must stay there. */
export async function numberOnProfile(profileSid: string, numberSid: string, http: TrustHubHttp = viaCall): Promise<boolean> {
  if (!SID.bundle.test(profileSid) || !SID.number.test(numberSid)) throw badInput("A business profile or number SID is malformed.");
  const rows = await listResults(http,
    `${TRUSTHUB}/CustomerProfiles/${profileSid}/ChannelEndpointAssignments?ChannelEndpointSid=${numberSid}&PageSize=20`);
  return rows.some((a) => String(a?.channel_endpoint_sid ?? "") === numberSid);
}

/** A business profile's review state and notification email (GET CustomerProfiles/{BU}). */
export async function fetchCustomerProfile(profileSid: string, http: TrustHubHttp = viaCall):
  Promise<{ status: TrustProductStatus | null; email: string }> {
  if (!SID.bundle.test(profileSid)) throw badInput("The business profile SID is malformed.");
  const p = await http("GET", `${TRUSTHUB}/CustomerProfiles/${profileSid}`);
  return { status: trustProductStatus(p?.status), email: String(p?.email ?? "").trim() };
}

/** One Trust Product's review state. `errors` are Twilio's rejection CODES only: the objects can
 *  carry field values, and no Twilio text reaches a browser (this file's header rule). */
export async function fetchTrustProduct(trustProductSid: string, http: TrustHubHttp = viaCall):
  Promise<{ status: TrustProductStatus | null; policySid: string; errorCodes: number[] }> {
  if (!SID.bundle.test(trustProductSid)) throw badInput("The Trust Product SID is malformed.");
  const t = await http("GET", `${TRUSTHUB}/TrustProducts/${trustProductSid}`);
  const errorCodes = (Array.isArray(t?.errors) ? t.errors : [])
    .map((e: any) => Number(e?.code)).filter((n: number) => Number.isInteger(n) && n > 0);
  return { status: trustProductStatus(t?.status), policySid: String(t?.policy_sid ?? ""), errorCodes };
}

export type VoiceTrustSetup = {
  kind: VoiceTrustKind;
  /** The BU… business profile the number goes on: the builder's Secondary Customer Profile, or
   *  (the internal tenant only) the platform's primary profile. */
  profileSid: string;
  /** The number's PN… SID. */
  numberSid: string;
  /** Where Twilio sends status emails (TrustProducts' required Email). */
  email: string;
  friendlyName: string;
  /** The SID recorded on the number row by an earlier run, if any. */
  existingSid?: string | null;
  /** Voice Integrity's EndUser answers. Required when that EndUser does not exist yet. When it
   *  does and the product is draft or twilio-rejected, they REPLACE its attributes before the
   *  product is resubmitted (an operator's "Submit again" sends corrected answers). */
  voiceIntegrity?: VoiceIntegrityInfo | null;
  /** CNAM's display name (parseCnamDisplayName's). Required when the product has no
   *  cnam_information EndUser yet; on a draft or twilio-rejected product it REPLACES the name the
   *  EndUser carries before the resubmit, exactly like Voice Integrity's answers. */
  cnam?: { displayName: string } | null;
  /** Called with the Trust Product the moment it is known (found or created), BEFORE any later
   *  step can throw, so the caller writes it down and a retry reuses it. */
  onTrustProduct?: (sid: string, status: TrustProductStatus | null) => Promise<void>;
};

export type VoiceTrustResult = {
  trustProductSid: string;
  status: TrustProductStatus | null;
  /** What this run had to do; each false means it was already done. */
  created: boolean;
  numberOnProfile: boolean;
  profileLinked: boolean;
  endUserCreated: boolean;
  /** Voice Integrity and CNAM: the existing EndUser was given the answers this run sent. */
  endUserUpdated: boolean;
  numberLinked: boolean;
  submitted: boolean;
};

/** An existing Trust Product for this kind and this profile, or null. By FriendlyName first (an
 *  earlier run whose response was lost), then one made elsewhere (the Console) that already
 *  carries this business profile. Ours for OTHER builders carry the same suffix under their own
 *  client_id, so they are skipped rather than read one by one. */
async function findTrustProduct(o: VoiceTrustSetup, policy: string, http: TrustHubHttp):
  Promise<{ sid: string; status: TrustProductStatus | null } | null> {
  const named = await listResults(http,
    `${TRUSTHUB}/TrustProducts?PolicySid=${policy}&FriendlyName=${encodeURIComponent(o.friendlyName)}&PageSize=20`);
  const byName = named.find((t) => String(t?.policy_sid ?? "") === policy && String(t?.friendly_name ?? "") === o.friendlyName
    && SID.bundle.test(String(t?.sid ?? "")));
  if (byName) return { sid: String(byName.sid), status: trustProductStatus(byName.status) };

  const suffix = ` — ${VOICE_TRUST_NAME[o.kind]}`;
  const all = await listResults(http, `${TRUSTHUB}/TrustProducts?PolicySid=${policy}&PageSize=50`);
  const others = all.filter((t) => String(t?.policy_sid ?? "") === policy && SID.bundle.test(String(t?.sid ?? ""))
    && !String(t?.friendly_name ?? "").endsWith(suffix)).slice(0, 10);
  for (const t of others) {
    const ents = await listResults(http, `${TRUSTHUB}/TrustProducts/${t.sid}/EntityAssignments?PageSize=50`);
    if (ents.some((e) => String(e?.object_sid ?? "") === o.profileSid)) {
      return { sid: String(t.sid), status: trustProductStatus(t.status) };
    }
  }
  return null;
}

/**
 * Create (or finish, or reuse) one caller-ID Trust Product for one number, and submit it for
 * review. Idempotent: every assignment is listed before it is made, the Trust Product is found
 * before it is created, and a product already under review (or approved) is never resubmitted.
 * A `draft` or `twilio-rejected` one is (re)submitted, which is what an operator pressing the
 * button again after fixing a rejection wants. For Voice Integrity that press carries the
 * questions form again, and those answers are written onto the product's existing
 * voice_integrity_information EndUser (POST EndUsers/{IT} Attributes) BEFORE the resubmit, so
 * Twilio re-reviews what the operator just answered, not the first answers (review BE-1).
 */
export async function setupVoiceTrust(o: VoiceTrustSetup, http: TrustHubHttp = viaCall): Promise<VoiceTrustResult> {
  if (!SID.bundle.test(o.profileSid)) throw badInput("The business profile SID is malformed.");
  if (!SID.number.test(o.numberSid)) throw badInput("The number SID is malformed.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) throw badInput("The business profile has no notification email.");
  const policy = VOICE_TRUST_POLICY[o.kind];
  const out: VoiceTrustResult = {
    trustProductSid: "", status: null, created: false, numberOnProfile: false,
    profileLinked: false, endUserCreated: false, endUserUpdated: false, numberLinked: false, submitted: false,
  };

  // 1. The number on the business profile.
  if (!(await numberOnProfile(o.profileSid, o.numberSid, http))) {
    await http("POST", `${TRUSTHUB}/CustomerProfiles/${o.profileSid}/ChannelEndpointAssignments`, {
      ChannelEndpointType: "phone-number", ChannelEndpointSid: o.numberSid,
    });
    out.numberOnProfile = true;
  }

  // 2. The Trust Product: the recorded one (if it is really this kind), else found, else created.
  let tp: { sid: string; status: TrustProductStatus | null } | null = null;
  if (o.existingSid && SID.bundle.test(o.existingSid)) {
    try {
      const t = await fetchTrustProduct(o.existingSid, http);
      if (t.policySid === policy) tp = { sid: o.existingSid, status: t.status };
    } catch (e) {
      // Deleted in the Console since: find or create a fresh one. Anything else is a real fault.
      if (!(e instanceof TrustHubError && e.status === 404)) throw e;
    }
  }
  if (!tp) tp = await findTrustProduct(o, policy, http);
  if (!tp) {
    const made = await http("POST", `${TRUSTHUB}/TrustProducts`, {
      FriendlyName: o.friendlyName, Email: o.email, PolicySid: policy,
    });
    const sid = String(made?.sid ?? "");
    if (!SID.bundle.test(sid)) {
      throw new TrustHubError({ message: "Twilio created a Trust Product but returned no SID.", status: 502, code: 0, permanent: false });
    }
    tp = { sid, status: trustProductStatus(made?.status) ?? "draft" };
    out.created = true;
  }
  out.trustProductSid = tp.sid;
  out.status = tp.status;
  if (o.onTrustProduct) await o.onTrustProduct(tp.sid, tp.status);

  // 3 + 4. What the product carries: its EndUser (Voice Integrity's answers, CNAM's display name;
  //        SHAKEN/STIR has none), and the business profile.
  const ents = await listResults(http, `${TRUSTHUB}/TrustProducts/${tp.sid}/EntityAssignments?PageSize=50`);
  const objects = ents.map((e) => String(e?.object_sid ?? ""));
  const spec = o.kind === "voice_integrity"
    ? { type: VOICE_INTEGRITY_END_USER_TYPE, attributes: o.voiceIntegrity ? voiceIntegrityAttributes(o.voiceIntegrity) : null,
        required: VOICE_INTEGRITY_INFO_REQUIRED, friendlyName: `${o.friendlyName} information` }
    : o.kind === "cnam"
    ? { type: CNAM_END_USER_TYPE, attributes: o.cnam?.displayName ? JSON.stringify({ cnam_display_name: o.cnam.displayName }) : null,
        required: CNAM_INFO_REQUIRED, friendlyName: `${o.friendlyName} display name` }
    : null;
  if (spec) {
    const attributes = spec.attributes;
    const linked = objects.filter((s) => SID.endUser.test(s));
    // Answers sent for a product that already carries EndUsers, and that is going to be
    // (re)submitted: find ITS EndUser of this kind's type (read, so another kind of EndUser a
    // Console-made product may carry is never overwritten with these fields) and replace its
    // attributes. Under review or approved, nothing is changed: step 6 sends nothing either.
    let viEndUser: string | null = null;
    const correcting = !!attributes && linked.length > 0 && resubmittable(out.status);
    if (correcting) {
      for (const s of linked.slice(0, 5)) {
        const eu = await http("GET", `${TRUSTHUB}/EndUsers/${s}`);
        if (String(eu?.type ?? "") === spec.type) { viEndUser = s; break; }
      }
    }
    if (viEndUser) {
      await http("POST", `${TRUSTHUB}/EndUsers/${viEndUser}`, { Attributes: attributes! });
      out.endUserUpdated = true;
    } else if (!linked.length || correcting) {
      // None yet (or, correcting, none of the right type): create it and assign it.
      if (!attributes) throw badInput(spec.required);
      const eu = await http("POST", `${TRUSTHUB}/EndUsers`, {
        FriendlyName: spec.friendlyName,
        Type: spec.type,
        Attributes: attributes,
      });
      const euSid = String(eu?.sid ?? "");
      if (!SID.endUser.test(euSid)) {
        throw new TrustHubError({ message: "Twilio created an EndUser but returned no SID.", status: 502, code: 0, permanent: false });
      }
      await http("POST", `${TRUSTHUB}/TrustProducts/${tp.sid}/EntityAssignments`, { ObjectSid: euSid });
      out.endUserCreated = true;
    }
  }
  if (!objects.includes(o.profileSid)) {
    await http("POST", `${TRUSTHUB}/TrustProducts/${tp.sid}/EntityAssignments`, { ObjectSid: o.profileSid });
    out.profileLinked = true;
  }

  // 5. The number on the Trust Product.
  const onProduct = await listResults(http,
    `${TRUSTHUB}/TrustProducts/${tp.sid}/ChannelEndpointAssignments?ChannelEndpointSid=${o.numberSid}&PageSize=20`);
  if (!onProduct.some((a) => String(a?.channel_endpoint_sid ?? "") === o.numberSid)) {
    await http("POST", `${TRUSTHUB}/TrustProducts/${tp.sid}/ChannelEndpointAssignments`, {
      ChannelEndpointType: "phone-number", ChannelEndpointSid: o.numberSid,
    });
    out.numberLinked = true;
  }

  // 6. Submit, unless it is already with Twilio or approved. A status outside Twilio's enum is
  //    left alone: submitting something we cannot read is a guess.
  if (resubmittable(out.status)) {
    const sub = await http("POST", `${TRUSTHUB}/TrustProducts/${tp.sid}`, { Status: "pending-review" });
    out.status = trustProductStatus(sub?.status) ?? "pending-review";
    out.submitted = true;
  }
  return out;
}

/** Reconcile a purchase whose response we never saw. */
export async function findPurchasedNumbers(clientId: string, creds?: TrustHubCreds | null): Promise<Array<{ sid: string; phoneNumber: string }>> {
  const acct = acctOf(creds);
  const r = await call("GET", `https://api.twilio.com/2010-04-01/Accounts/${acct}/IncomingPhoneNumbers.json?FriendlyName=${encodeURIComponent(clientId)}&PageSize=50`, undefined, undefined, creds);
  const list = Array.isArray(r?.incoming_phone_numbers) ? r.incoming_phone_numbers : [];
  return list.map((n: any) => ({ sid: String(n?.sid ?? ""), phoneNumber: String(n?.phone_number ?? "") }));
}

export async function releaseNumber(numberSid: string, creds?: TrustHubCreds | null): Promise<void> {
  const acct = acctOf(creds);
  await call("DELETE", `https://api.twilio.com/2010-04-01/Accounts/${acct}/IncomingPhoneNumbers/${numberSid}.json`, undefined, undefined, creds);
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Event Streams and the REST API describe the same states in DIFFERENT vocabularies, and
 * writing both into one column produces a field whose meaning depends on which code path
 * wrote it last.
 *
 *   REST:   PENDING | APPROVED | FAILED | IN_REVIEW | SUSPENDED | DELETION_PENDING | ...
 *   Events: lowercase and disjoint — "registered", "vetting_failed", "pending"
 *
 * Everything is normalised to the REST vocabulary before it is stored.
 */
export function normalizeBrandStatus(raw: string): string {
  const v = String(raw ?? "").trim().toUpperCase();
  switch (v) {
    case "REGISTERED": return "APPROVED";
    case "VETTING_FAILED": return "FAILED";
    case "PENDING": case "APPROVED": case "FAILED": case "IN_REVIEW":
    case "SUSPENDED": case "DELETION_PENDING": case "DELETION_FAILED":
      return v;
    default: return v || "PENDING";
  }
}

export function normalizeCampaignStatus(raw: string): string {
  const v = String(raw ?? "").trim().toUpperCase();
  switch (v) {
    // ⚠️ TWO VOCABULARIES, AND MISSING ONE STALLS A BUILDER SILENTLY. The REST resource says
    // VERIFIED / REJECTED; **Event Streams says `success` / `failure`**, and the whole point of
    // this function is to flatten that difference. `failure` was missing until 2026-09-01, so
    // it fell through `default` and was stored VERBATIM as "FAILURE" — which is not "FAILED",
    // so twilio-events never set status='campaign_failed', never set needs_attention, and
    // never cleared next_poll_at.
    //
    // The real cost: TCR rejected the first live campaign 0.1s after submission, the rejection
    // arrived and was recorded, and the builder's screen still read "Final review — the
    // carriers are reviewing how you plan to use texting… Nothing for you to do." It would have
    // said that forever. Exactly the shape of the Monday webhook bug in CLAUDE.md: the
    // subscription's vocabulary is not the payload's vocabulary.
    case "VERIFIED": case "APPROVED": case "SUCCESS": return "APPROVED";
    case "FAILED": case "REJECTED": case "FAILURE": return "FAILED";
    case "PENDING": case "IN_PROGRESS": return "PENDING";
    default: return v || "PENDING";
  }
}
