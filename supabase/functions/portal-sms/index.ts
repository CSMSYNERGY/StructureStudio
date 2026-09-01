import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import type { GateTable } from "../_shared/access.ts";
import {
  trustHubConfigured,
  validateIntake,
  suggestBrandTier,
  createSecondaryCustomerProfile,
  createA2pTrustProduct,
  registerBrand,
  fetchBrand,
  updateBrand,
  createMessagingService,
  fetchEligibleUseCases,
  createCampaign,
  fetchCampaign,
  searchAvailableNumbers,
  purchaseNumber,
  findPurchasedNumbers,
  normalizeBrandStatus,
  normalizeCampaignStatus,
  validateCampaignCopy,
  TrustHubError,
  BUSINESS_TYPES,
  JOB_POSITIONS,
  type BuilderIntake,
} from "../_shared/twilioTrustHub.ts";

// Self-serve SMS onboarding: the builder's own A2P 10DLC registration and their own number.
//
// A NEW function rather than more branches on portal-settings, which is already ~6,000
// lines. Everything here is one concern — getting one builder from "I want texting" to a
// number the carriers will accept.
//
// ⚠️ THE EXPENSIVE INVARIANT. `advance` is the only action that spends money (a brand
// registration is billed per POST) and it is guarded three ways, all of which must hold:
//   1. the single-flight lock in sms_registrations, taken as ONE conditional UPDATE
//   2. an explicit state machine — each state performs exactly one stage and then stops
//   3. reconciliation before any create: if a previous attempt died after Twilio acted but
//      before we recorded it, we FIND the object rather than making a second one.
// Two brand registrations for one builder is two real charges and a support ticket.
//
// ⚠️ NO TWILIO ERROR TEXT REACHES THE BROWSER. Their bodies echo submitted values — an EIN,
// a representative's mobile. Codes and our own sentences travel; raw detail goes to
// app_errors, matching portal-settings' dbFail contract.

/** A billing refusal raised inside the staged advance. advanceOne is called behind the
 *  single-flight lock and its thrown errors are caught by the handler's generic 502 — which
 *  would turn "your wallet is short $49" into "something went wrong". This carries the real
 *  status and the authored sentence out intact. */
class BillingRefusal extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body?.error ?? "billing refused"));
    this.name = "BillingRefusal";
    this.status = status;
    this.body = body;
  }
}

// ⚠️ WITHOUT THESE THE WHOLE FEATURE IS DEAD IN A BROWSER, and silently. This function was
// the ONLY portal-* function that never declared them, so every call from the portal — the
// preflight included — was blocked by CORS and the Text Messaging panel rendered an empty
// skeleton forever. Nothing errored server-side, and curl could not see it: curl sends no
// Origin, so it never triggers a preflight and every hand-test passed. Same values as every
// sibling; each function declares its own (there is no shared helper to import).
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// WHAT EACH ACTION REQUIRES. Texting is a customer-communication feature, so it sits under
// the `contacts` area rather than inventing a new one — the people who talk to customers
// are exactly the people who should see this. Registration itself is a commitment of the
// business's legal identity and real money, so it is settings_billing:'edit', which by
// default only an owner holds (and an admin only when an owner has granted it).
const GATES: GateTable = {
  // Read the current state — anyone who can see contacts.
  status:          { area: "contacts", level: "view" },
  // Save the compliance intake. Not yet a submission and spends nothing, but it collects
  // the business's legal identity, so it is held to the same bar as submitting it.
  save_intake:     { area: "settings_billing", level: "edit" },
  accept_aup:      { area: "settings_billing", level: "edit" },
  // The text the CARRIERS read, published under the business's name. Spends nothing and is
  // not a submission, but it is the same material save_intake collects, so it is held to the
  // same bar. ⚠️ preflight does NOT cross-check this file's GATES against its `case` labels
  // (it discovers `action === "x"`, not `switch`), so omitting a line here is a runtime 403
  // that reads like a broken feature, with no push-time warning at all.
  save_copy:       { area: "settings_billing", level: "edit" },
  // ⚠️ SPENDS MONEY.
  advance:         { area: "settings_billing", level: "edit" },
  search_numbers:  { area: "settings_billing", level: "edit" },
  // ⚠️ SPENDS MONEY (a number is billed monthly from purchase).
  buy_number:      { area: "settings_billing", level: "edit" },
  // Consent management — the people who talk to customers.
  opt_outs:        { area: "contacts", level: "view" },
  set_opt_out:     { area: "contacts", level: "edit" },
  // Diagnostic: is TWILIO_AUTH_TOKEN the real account auth token? See the branch below for
  // why this cannot be answered any other way.
  check_auth_token: { area: "settings_billing", level: "edit" },
  // Testing rig. Same bar as submitting, because it changes what submitting DOES.
  set_mock:        { area: "settings_billing", level: "edit" },
};

/** Everything the browser might send, clipped to what a column and Twilio will hold. */
function normalizeCopy(raw: unknown): { description: string; messageFlow: string; messageSamples: string[] } {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    description: String(c.description ?? "").trim().slice(0, 4096),
    messageFlow: String(c.messageFlow ?? "").trim().slice(0, 4096),
    messageSamples: (Array.isArray(c.messageSamples) ? c.messageSamples : [])
      .map((s) => String(s ?? "").trim().slice(0, 1024)).slice(0, 5),
  };
}

/** The copy that will ACTUALLY be submitted: what the caller sent, falling back FIELD BY FIELD
 *  to what we stored.
 *
 *  ⚠️ FIELD BY FIELD, NOT OBJECT BY OBJECT, and that distinction is the whole bug fix. The
 *  portal ALWAYS posts a `copy` object — the brand_approved card posts
 *  {description:"", messageFlow:"", messageSamples:["",""]} from a freshly-mounted React state,
 *  because the carriers take days and a page reload by then is certain. So "did they send one?"
 *  is the wrong question, and answering it was the deterministic 400 that left a builder staring
 *  at a refusal with no form on screen to fix it.
 *
 *  ⚠️ THIS IS ALSO THE FORWARD-COMPAT SEAM. Edge functions go live for beta AND production the
 *  moment they deploy, while the portal artifact only reaches production on the Monday
 *  promotion. With this merge in place the CURRENTLY DEPLOYED portal — the one whose
 *  brand_approved card has no form at all — stops 400ing as soon as a row has stored copy. */
function mergeCopy(reg: any, posted: unknown) {
  const p = normalizeCopy(posted);
  const stored = normalizeCopy({
    description: reg?.campaign_description,
    messageFlow: reg?.campaign_message_flow,
    messageSamples: Array.isArray(reg?.campaign_message_samples) ? reg.campaign_message_samples : [],
  });
  return {
    description: p.description || stored.description,
    messageFlow: p.messageFlow || stored.messageFlow,
    messageSamples: p.messageSamples.filter(Boolean).length >= 2 ? p.messageSamples : stored.messageSamples,
  };
}

const AUP_TEXT =
  "I confirm that this business will only text people who have given us permission to text " +
  "them, that we will stop when someone asks us to stop, and that we are responsible for " +
  "what we send. I understand our messages are sent under our own business's carrier " +
  "registration and that false information here can get our texting shut off.";

/**
 * Take a wallet hold before spending, and hand back how to settle it.
 *
 * Mirrors the video_3d_generation path in portal-settings — same RPCs, same error names,
 * same verdicts — because a second, subtly different money path is how two charging
 * behaviours end up in one product.
 *
 * ⚠️ `meter_inactive` IS NOT A FAILURE. It is the ARMING RAIL: migration 169 seeds these
 * meters inactive so this code can deploy and be watched running FREE, and then one boolean
 * turns the money on. An inactive meter returns `{ ok: true, holdId: null }` and the caller
 * proceeds unbilled. Treating it as an error would make arming a code change instead of a
 * data change, which is the whole point of the rail.
 *
 * ⚠️ IDEMPOTENCY IS NOT OPTIONAL HERE. Both callers can be retried — a builder pressing
 * Submit twice, a lost response on a number purchase — and a hold without an idempotency key
 * charges twice for one thing. The key is derived from the tenant and the specific act, never
 * from a timestamp.
 */
// deno-lint-ignore no-explicit-any
async function takeHold(admin: any, clientId: string, kind: string, idem: string, userId: string | null): Promise<
  { ok: true; holdId: number | null } | { ok: false; status: number; body: Record<string, unknown> }
> {
  const { data: hold, error } = await admin
    .rpc("wallet_hold", { p_client_id: clientId, p_kind: kind, p_idem: idem.slice(0, 120), p_user: userId })
    .maybeSingle() as { data: any; error: any };

  if (error) {
    // The meter is unreachable. REFUSE rather than proceed — the alternative is spending real
    // money at Twilio with no record that we ever intended to charge for it.
    await logEdgeError({
      fn: "portal-sms", clientId, code: "wallet_hold_failed",
      message: `Wallet hold failed, refusing: ${error.message}`, context: { kind },
    }).catch(() => {});
    return { ok: false, status: 503, body: { error: "The billing meter is unavailable right now — please try again shortly." } };
  }

  const err = hold?.err ?? null;
  if (err === "insufficient_funds") {
    const price = hold?.price_cents ?? 0;
    const bal = hold?.balance_after ?? 0;
    return {
      ok: false, status: 402,
      body: {
        error: `This costs $${(price / 100).toFixed(2)} and your wallet has $${(bal / 100).toFixed(2)}. Add funds in Settings → Billing, then try again.`,
        code: "insufficient_funds", priceCents: price, balanceCents: bal,
      },
    };
  }
  if (err === "hold_in_flight") {
    return { ok: false, status: 409, body: { error: "A charge for this account is already being processed — give it a moment." } };
  }
  if (err === "meter_unknown") {
    await logEdgeError({
      fn: "portal-sms", clientId, code: "wallet_meter_missing",
      message: `usage_prices has no ${kind} row`,
    }).catch(() => {});
    return { ok: false, status: 503, body: { error: "The billing meter is unavailable right now — please try again shortly." } };
  }
  // No error, or `meter_inactive` (the arming rail) — proceed. holdId null means unbilled.
  return { ok: true, holdId: err ? null : (hold?.hold_id ?? null) };
}

Deno.serve(withErrorLog("portal-sms", async (req: Request) => {
  // A table-free warm ping, answered BEFORE auth and before the body is read, so it costs
  // one isolate boot and nothing else. Same shape as portal-schedule's.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });
  if (req.method === "OPTIONS") return json({ ok: true });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const r = await resolveTenant(req, admin, { gates: GATES, readActions: new Set(), defaultAction: "status" });
  if (!r.ok) return json(r.body, r.status);
  const { clientId, payload, action, userId, audit } = r.ctx;
  if (r.ctx.operator) audit(`operator_sms_${action}`).catch(() => {});

  const p = (payload ?? {}) as Record<string, any>;

  /** Load the row, creating the empty one on first sight so every later write can assume it. */
  const load = async () => {
    const { data } = await admin.from("sms_registrations").select("*").eq("client_id", clientId).maybeSingle();
    if (data) return data;
    const { data: made } = await admin.from("sms_registrations")
      .insert({ client_id: clientId, status: "none" }).select("*").single();
    return made;
  };

  /** What the portal renders. Deliberately a PROJECTION: Twilio's vocabulary stays in the
   *  row, and the builder sees a sentence about their own business. */
  const view = (reg: any, numbers: any[]) => ({
    status: reg?.status ?? "none",
    brandTier: reg?.brand_tier ?? "low_volume_standard",
    needsAttention: !!reg?.needs_attention,
    attentionNote: reg?.attention_note ?? null,
    // The raw vendor statuses, for the operator console only.
    brandStatus: reg?.brand_status ?? null,
    campaignStatus: reg?.campaign_status ?? null,
    errors: Array.isArray(reg?.last_errors) ? reg.last_errors : [],
    brandUpdatesLeft: Math.max(0, 3 - Number(reg?.brand_update_count ?? 0)),
    // ⚠️ ALWAYS PROJECTED, never hidden behind a debug flag. A mock registration looks
    // identical to a real one right up until a text does not arrive, so the screen has to
    // say which one it is.
    mockBrand: !!reg?.mock_brand,
    intake: {
      legalBusinessName: reg?.legal_business_name ?? "",
      einLast4: reg?.ein_last4 ?? "",
      websiteUrl: reg?.website_url ?? "",
      privacyPolicyUrl: reg?.privacy_policy_url ?? "",
      termsUrl: reg?.terms_url ?? "",
    },
    // The campaign copy, so the form can PRE-FILL. Until 2026-09-01 this was never stored and
    // never returned, so the brand_approved card — reached days later, after a certain reload —
    // rendered no form and posted two empty strings into a guaranteed refusal.
    // Always two slots, so the form always has two boxes to draw.
    copy: {
      description: reg?.campaign_description ?? "",
      messageFlow: reg?.campaign_message_flow ?? "",
      messageSamples: (Array.isArray(reg?.campaign_message_samples) && reg.campaign_message_samples.length >= 2)
        ? reg.campaign_message_samples.map((s: unknown) => String(s ?? ""))
        : ["", ""],
    },
    aupAcceptedAt: reg?.aup_accepted_at ?? null,
    aupText: AUP_TEXT,
    numbers: (numbers ?? []).map((n) => ({
      phoneNumber: n.phone_number,
      registrationStatus: n.registration_status,
      purchasedAt: n.purchased_at,
    })),
    businessTypes: BUSINESS_TYPES,
    jobPositions: JOB_POSITIONS,
    configured: trustHubConfigured(),
  });

  const numbersOf = async () => {
    const { data } = await admin.from("sms_numbers")
      .select("phone_number, registration_status, purchased_at")
      .eq("client_id", clientId).is("released_at", null).order("purchased_at");
    return data ?? [];
  };

  const note = async (type: string, detail: unknown) => {
    await admin.from("sms_registration_events")
      .insert({ client_id: clientId, event_type: type, detail: detail ?? {} })
      .then(() => {}, () => {});
  };

  try {
    switch (action) {
      case "status": {
        let reg = await load();

        // ── LAZY SWEEP ───────────────────────────────────────────────────────────────
        // There is no pg_cron on this project and no scheduler that reliably runs against
        // this branch, so a registration that is waiting on a carrier is moved forward by
        // somebody LOOKING at it. The builder's page polls once a minute while pending, so
        // in practice this runs itself.
        //
        // ⚠️ ONLY THE STATES WHOSE ADVANCE IS A PURE READ. brand_pending and
        // campaign_pending just fetch a status from Twilio. `profile_pending` is excluded
        // deliberately and must stay excluded: its advance REGISTERS A BRAND, which is
        // billed per call — and `status` is gated contacts:'view', so anyone who can see
        // the Contacts tab could otherwise spend the tenant's money by refreshing a page.
        // Submitting stays an explicit act by someone with settings_billing:'edit'.
        const sweepable = reg && ["brand_pending", "campaign_pending"].includes(reg.status);
        const due = reg?.next_poll_at && new Date(reg.next_poll_at).getTime() <= Date.now();
        if (sweepable && due && trustHubConfigured()) {
          const nowIso = new Date().toISOString();
          const { data: locked } = await admin.from("sms_registrations")
            .update({ advance_lock_until: new Date(Date.now() + 5 * 60_000).toISOString() })
            .eq("client_id", clientId)
            .or(`advance_lock_until.is.null,advance_lock_until.lt.${nowIso}`)
            .select("*").maybeSingle();
          if (locked) {
            try {
              reg = await advanceOne(admin, clientId, locked, {}, Deno.env.get("TWILIO_PRIMARY_PROFILE_SID") ?? "", note, null);
            } catch (e) {
              // A sweep failure must never break the page it was riding on. The builder
              // still gets their status; the next look tries again.
              await logEdgeError({
                fn: "portal-sms", clientId, code: "sms_sweep_failed",
                message: `lazy sweep failed: ${(e as Error).message}`,
                severity: "info",
              }).catch(() => {});
              reg = await load();
            } finally {
              await admin.from("sms_registrations")
                .update({ advance_lock_until: null }).eq("client_id", clientId);
            }
          }
        }

        return json({ ok: true, ...view(reg, await numbersOf()) });
      }

      case "save_intake": {
        const hasEin = !!p.hasEin;
        const intake = (p.intake ?? {}) as Partial<BuilderIntake>;
        const problems = validateIntake(intake, hasEin);
        if (problems.length) return json({ error: problems[0], problems }, 400);

        const reg = await load();
        // ⚠️ Refuse to edit an intake that has already been SUBMITTED. Past 'ready' the
        // authoritative copy lives in Twilio's EndUser objects; letting the form overwrite
        // our echo would make the portal disagree with what the carriers actually reviewed.
        if (!["none", "intake", "aup_pending", "ready", "brand_failed"].includes(reg.status)) {
          return json({ error: "This registration has already been submitted, so its details cannot be edited here. Ask support to change them." }, 409);
        }

        const ein = String(intake.ein ?? "").replace(/\D/g, "");
        await admin.from("sms_registrations").update({
          // ⚠️ ECHO ONLY. The EIN, the rep's mobile and the street address are NOT stored
          // here — they go to Twilio and are referenced by SID. A support ticket must never
          // be answerable by reading our database.
          legal_business_name: intake.legalBusinessName ?? null,
          ein_last4: ein ? ein.slice(-4) : null,
          rep_email_domain: String(intake.repEmail ?? "").split("@")[1] ?? null,
          website_url: intake.websiteUrl ?? null,
          privacy_policy_url: p.privacyPolicyUrl ?? null,
          terms_url: p.termsUrl ?? null,
          brand_tier: suggestBrandTier(hasEin),
          status: reg.aup_accepted_at ? "ready" : "aup_pending",
          updated_at: new Date().toISOString(),
        }).eq("client_id", clientId);

        // The full intake is held in memory only for the duration of `advance`, which the
        // builder triggers next. It is passed back in on that call rather than stored.
        await note("intake_saved", { hasEin, tier: suggestBrandTier(hasEin) });
        const fresh = await load();
        return json({ ok: true, ...view(fresh, await numbersOf()) });
      }

      case "accept_aup": {
        const reg = await load();
        if (reg.aup_accepted_at) return json({ ok: true, ...view(reg, await numbersOf()) });
        await admin.from("sms_registrations").update({
          // The sentence VERBATIM, not a version number — the wording will change, and what
          // matters later is what this person actually agreed to. Same rule the quote
          // acceptance follows.
          aup_text: AUP_TEXT,
          aup_accepted_at: new Date().toISOString(),
          aup_accepted_by: userId ?? null,
          aup_accepted_ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
          status: reg.legal_business_name ? "ready" : "intake",
          updated_at: new Date().toISOString(),
        }).eq("client_id", clientId);
        await note("aup_accepted", {});
        return json({ ok: true, ...view(await load(), await numbersOf()) });
      }

      case "save_copy": {
        const reg = await load();
        // Editable right up to the moment the campaign is submitted, and never after: the Usa2p
        // resource has NO update operation, so past this point our stored text would silently
        // disagree with what the carriers actually hold. Same reasoning as save_intake's 409.
        if (!["none", "intake", "aup_pending", "ready", "profile_pending", "brand_pending",
              "brand_failed", "brand_approved"].includes(reg.status)) {
          return json({ error: "The carriers already have this description and it cannot be changed here. Contact support." }, 409);
        }
        // ⚠️ CAPS ONLY, NOT THE FULL RULES. A hard validation here would make a half-typed draft
        // unsaveable, which is the exact thing this action exists to allow. The full rules run at
        // submit, where the form is on screen to answer them.
        const c = normalizeCopy(p.copy);
        await admin.from("sms_registrations").update({
          campaign_description: c.description || null,
          campaign_message_flow: c.messageFlow || null,
          campaign_message_samples: c.messageSamples,
          campaign_copy_updated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("client_id", clientId);
        await note("copy_saved", { descChars: c.description.length, samples: c.messageSamples.length });
        return json({ ok: true, ...view(await load(), await numbersOf()) });
      }

      case "set_mock": {
        // ⚠️ ONLY BEFORE ANYTHING IS SUBMITTED. Past `ready` a brand exists at Twilio and is
        // either mock or not; flipping our row then would make the screen lie about a thing
        // that can no longer change.
        const reg = await load();
        if (!["none", "intake", "aup_pending", "ready"].includes(reg.status)) {
          return json({ error: "This registration has already been submitted, so it is too late to change that." }, 409);
        }
        const want = !!p.mock;
        const { error } = await admin.from("sms_registrations")
          .update({ mock_brand: want, updated_at: new Date().toISOString() })
          .eq("client_id", clientId);
        if (error) {
          // Migration 170's trigger is the real authority here, and it raises rather than
          // returning a row. Translate it instead of leaking a Postgres message.
          return json({ error: /internal account/i.test(error.message)
            ? "Test registrations are only available on the internal CSM Synergy account."
            : "Could not change that just now." }, 400);
        }
        await note(want ? "mock_enabled" : "mock_disabled", {});
        return json({ ok: true, ...view(await load(), await numbersOf()) });
      }

      case "advance": {
        if (!trustHubConfigured()) {
          return json({ error: "Text messaging is not switched on for this deployment yet." }, 503);
        }
        const primary = Deno.env.get("TWILIO_PRIMARY_PROFILE_SID") ?? "";
        if (!primary) {
          return json({ error: "Text messaging is not switched on for this deployment yet." }, 503);
        }

        // ⚠️ SINGLE-FLIGHT, TAKEN IN ONE STATEMENT. A read-then-write here races, and the
        // race is two brand registrations and two real charges for one builder. Proceed
        // ONLY if a row comes back.
        const nowIso = new Date().toISOString();
        const lockUntil = new Date(Date.now() + 5 * 60_000).toISOString();
        const { data: locked } = await admin.from("sms_registrations")
          .update({ advance_lock_until: lockUntil })
          .eq("client_id", clientId)
          .or(`advance_lock_until.is.null,advance_lock_until.lt.${nowIso}`)
          .select("*").maybeSingle();
        if (!locked) {
          return json({ error: "This registration is already being worked on. Give it a minute and refresh." }, 409);
        }

        try {
          const out = await advanceOne(admin, clientId, locked, p, primary, note, userId ?? null);
          return json({ ok: true, ...view(out, await numbersOf()) });
        } finally {
          // Always release, even on failure: a stuck lock parks a builder for five minutes
          // for no reason, and the state machine is idempotent by design.
          await admin.from("sms_registrations")
            .update({ advance_lock_until: null }).eq("client_id", clientId);
        }
      }

      case "search_numbers": {
        if (!trustHubConfigured()) return json({ error: "Text messaging is not switched on yet." }, 503);
        const results = await searchAvailableNumbers({
          areaCode: String(p.areaCode ?? "").replace(/\D/g, "").slice(0, 3) || undefined,
          contains: p.contains ? String(p.contains) : undefined,
          inRegion: p.region ? String(p.region).toUpperCase().slice(0, 2) : undefined,
          limit: 10,
        });
        return json({ ok: true, numbers: results });
      }

      case "buy_number": {
        if (!trustHubConfigured()) return json({ error: "Text messaging is not switched on yet." }, 503);
        const reg = await load();
        if (!reg.messaging_service_sid || reg.status === "none") {
          return json({ error: "Finish the carrier registration before buying a number." }, 409);
        }
        const wanted = String(p.phoneNumber ?? "").trim();
        if (!/^\+1\d{10}$/.test(wanted)) return json({ error: "Choose a number from the search results." }, 400);

        // ⚠️ ONE LIVE NUMBER PER TENANT, enforced here AND by a partial unique index. The
        // inbound webhook resolves the tenant from the To number and nothing else.
        const { count } = await admin.from("sms_numbers")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId).is("released_at", null);
        if ((count ?? 0) >= 1) {
          return json({ error: "This account already has a texting number." }, 409);
        }

        // Reconcile BEFORE buying: a previous attempt may have succeeded with its response
        // lost in flight, and buying again would silently rent a second number forever.
        const already = await findPurchasedNumbers(clientId);
        const dupe = already.find((n) => n.phoneNumber === wanted);

        // ⚠️ The number bills MONTHLY at Twilio from the moment it is bought, so the first
        // month is charged here. Idempotent on the tenant + the number, so a retry after a
        // lost response reconciles to the same hold rather than charging for a second month.
        //
        // ⏭ RECURRING IS NOT WIRED. This takes the FIRST month only. There is no pg_cron on
        // this project, so the monthly charge needs the same lazy-sweep treatment the
        // registration poller uses — see the work log. Until then a number bills us monthly
        // and the builder once, which is a known, bounded shortfall rather than a silent one.
        const heldNum = await takeHold(admin, clientId, "sms_number_monthly", `sms_num:${clientId}:${wanted}`, userId ?? null);
        if (!heldNum.ok) return json(heldNum.body, heldNum.status);

        let bought;
        try {
          bought = dupe ?? await purchaseNumber({
            phoneNumber: wanted, clientId, messagingServiceSid: reg.messaging_service_sid,
          });
        } catch (e) {
          if (heldNum.holdId) {
            await admin.rpc("wallet_release", { p_hold_id: heldNum.holdId, p_reason: "number purchase failed" })
              .then(() => {}, () => {});
          }
          throw e;
        }
        if (heldNum.holdId) {
          await admin.rpc("wallet_capture", {
            p_hold_id: heldNum.holdId, p_cost_cents: null,
            p_usage: { phone_number: bought.phoneNumber }, p_ref_id: bought.sid,
          }).then(() => {}, () => {});
        }

        await admin.from("sms_numbers").insert({
          client_id: clientId,
          phone_number: bought.phoneNumber,
          twilio_sid: bought.sid,
          messaging_service_sid: reg.messaging_service_sid,
          registration_status: "pending_registration",
        });
        await admin.from("client_settings")
          .update({ sms_number: bought.phoneNumber }).eq("client_id", clientId);
        await admin.from("sms_registrations").update({
          status: "number_pending", next_poll_at: null, updated_at: new Date().toISOString(),
        }).eq("client_id", clientId);
        await note("number_purchased", { phoneNumber: bought.phoneNumber, reconciled: !!dupe });

        return json({ ok: true, ...view(await load(), await numbersOf()) });
      }

      case "opt_outs": {
        const { data } = await admin.from("sms_opt_outs")
          .select("phone_digits, reason, requested_at, effective_at, note")
          .eq("client_id", clientId).order("effective_at", { ascending: false }).limit(500);
        return json({ ok: true, optOuts: data ?? [] });
      }

      case "set_opt_out": {
        const digits = String(p.phoneDigits ?? "").replace(/\D/g, "");
        if (digits.length !== 10) return json({ error: "That is not a US phone number." }, 400);
        if (p.optedOut === false) {
          await admin.from("sms_opt_outs").delete()
            .eq("client_id", clientId).eq("phone_digits", digits);
          await admin.from("sms_consent_log").insert({
            client_id: clientId, phone_digits: digits, action: "granted", source: "operator",
            detail: { by: userId, note: String(p.note ?? "") },
          });
        } else {
          // The FCC's 2025-04-11 rule: a revocation made "in any reasonable manner" must be
          // honoured within 10 BUSINESS DAYS. Recording requested_at separately from
          // effective_at is what lets an operator prove the deadline was met — the block
          // itself is immediate.
          await admin.from("sms_opt_outs").upsert({
            client_id: clientId, phone_digits: digits, reason: "operator",
            requested_at: p.requestedAt ?? new Date().toISOString(),
            effective_at: new Date().toISOString(),
            note: String(p.note ?? ""),
          }, { onConflict: "client_id,phone_digits" });
          await admin.from("sms_consent_log").insert({
            client_id: clientId, phone_digits: digits, action: "revoked", source: "operator",
            detail: { by: userId, note: String(p.note ?? "") },
          });
        }
        return json({ ok: true });
      }

      case "check_auth_token": {
        // ── Is TWILIO_AUTH_TOKEN the REAL account auth token? ─────────────────────────
        //
        // This exists because the question is otherwise unanswerable until it is too late.
        // The auth token is the ONLY credential that can validate X-Twilio-Signature, and
        // sms-inbound's behaviour flips on merely whether it is SET:
        //   unset → skip validation, run on the URL secret (logs sms_signature_skipped)
        //   set   → validate, and REFUSE anything that does not match
        // So a WRONG token is worse than no token: every real customer reply starts getting
        // 401'd, silently, and the only symptom is texts that never arrive. Nothing else in
        // the codebase exercises the token either — basicAuthPair() prefers the API-key pair
        // everywhere — so it can sit wrong indefinitely.
        //
        // The test is conclusive rather than circular: signing something ourselves and
        // checking our own signature would pass with ANY value. Instead we ask TWILIO
        // whether AccountSid:AuthToken authenticates. Only the account's real token does.
        //
        // ⚠️ The token itself never leaves the runtime. Only a verdict, a length and a
        // Twilio error code travel — no prefix, no suffix, no hash.
        const acct = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
        const tok = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
        if (!acct) return json({ ok: false, verdict: "no_account_sid" });
        if (!tok) {
          return json({
            ok: false, verdict: "empty",
            detail: "TWILIO_AUTH_TOKEN is not set, so inbound webhook signatures are not being validated.",
          });
        }
        let res: Response;
        try {
          res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${acct}.json`, {
            headers: { Accept: "application/json", Authorization: `Basic ${btoa(`${acct}:${tok}`)}` },
          });
        } catch (e) {
          return json({ ok: false, verdict: "unreachable", detail: (e as Error).message });
        }
        const text = await res.text();
        let body: any = {};
        try { body = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
        if (res.ok) {
          return json({
            ok: true, verdict: "valid",
            tokenLength: tok.length,
            // Proves it authenticated against the account we think we are, not some other one.
            accountSid: String(body?.sid ?? ""),
            friendlyName: String(body?.friendly_name ?? ""),
            detail: "Twilio accepted this token for this account, so inbound webhook signature validation will work.",
          });
        }
        // 20003 is Twilio's authentication failure. Anything else is a different problem.
        const code = typeof body?.code === "number" ? body.code : 0;
        return json({
          ok: false,
          verdict: code === 20003 ? "wrong_token" : "error",
          status: res.status,
          code,
          tokenLength: tok.length,
          detail: code === 20003
            ? "Twilio rejected this token. Inbound customer replies will be refused until it is corrected."
            : `Twilio answered HTTP ${res.status}.`,
        });
      }

      default:
        return json({ error: `Unrecognised action "${action}".` }, 400);
    }
  } catch (e) {
    // A billing refusal is the product declining with a price attached, not a fault. It keeps
    // its own status and its own sentence rather than being flattened into the 502 below.
    if (e instanceof BillingRefusal) return json(e.body, e.status);
    const err = e as TrustHubError;
    // Twilio's body can echo the EIN and the representative's mobile. It goes to app_errors,
    // never to the browser.
    await logEdgeError({
      fn: "portal-sms",
      clientId,
      code: "sms_registration_failed",
      message: `${action} failed: ${err.message}`,
      context: { action, code: err.code ?? 0, status: err.status ?? 0 },
    }).catch(() => {});

    if (err instanceof TrustHubError && err.code === 30915) {
      // The single most likely rejection for a shed builder, and it has a real fix.
      return json({
        error: "The carriers rejected this as a sole proprietor because the business has a tax ID. " +
               "Go back, answer yes to the EIN question, and enter it — then submit again.",
      }, 400);
    }
    if (err instanceof TrustHubError && err.code === 21717) {
      // ⚠️ NOT A FAULT. Twilio reports a brand APPROVED before it will answer use-case
      // questions about it, and its own guidance is to pause after brand submission. Hit on
      // the first live run: the builder had done nothing wrong and was told "Support has been
      // notified", which is a dead end for something that clears itself in a minute.
      return json({
        error: "The carriers have approved your business but need another minute before the campaign can go in. " +
               "Wait a moment and submit again.",
      }, 409);
    }
    if (err instanceof TrustHubError && err.code === 21724) {
      return json({
        error: "This registration has used all three free resubmissions. Support has to take it from here.",
      }, 409);
    }
    return json({ error: "The carrier registration could not be updated just now. Support has been notified." }, 502);
  }
}));

/**
 * ONE STAGE PER CALL. Each branch performs a single step and returns; the builder's poll or
 * an Event Streams callback brings us back for the next. That is what makes the whole chain
 * safe to retry — a crash mid-chain repeats at most one stage, and every create is
 * reconciled against what already exists.
 */
async function advanceOne(
  // deno-lint-ignore no-explicit-any
  admin: any,
  clientId: string,
  reg: any,
  p: Record<string, any>,
  primaryProfileSid: string,
  note: (t: string, d: unknown) => Promise<void>,
  // Attribution on the wallet hold — who authorised the charge. Null on the lazy sweep,
  // which is nobody pressing anything; that path never reaches a charging state anyway.
  userId: string | null,
): Promise<any> {
  const set = async (patch: Record<string, unknown>) => {
    await admin.from("sms_registrations")
      .update({ ...patch, updated_at: new Date().toISOString() }).eq("client_id", clientId);
    const { data } = await admin.from("sms_registrations").select("*").eq("client_id", clientId).maybeSingle();
    return data;
  };
  const soon = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();

  switch (reg.status) {
    case "none":
    case "intake":
    case "aup_pending":
      // Nothing to advance — the form is not finished. Returning the row unchanged is the
      // honest answer; inventing an error here would make a half-filled form look broken.
      return reg;

    case "ready": {
      if (!reg.aup_accepted_at) return reg;
      const intake = (p.intake ?? {}) as BuilderIntake;
      const problems = validateIntake(intake, reg.brand_tier !== "sole_proprietor");
      if (problems.length) throw new TrustHubError({ message: problems[0], status: 400, code: 0, permanent: true });

      // ⚠️ WRITE THE COPY DOWN BEFORE THE FIRST TWILIO CALL. Until 2026-09-01 `p.copy` was read
      // NOWHERE in this branch and never stored, so the paragraphs the builder typed on this very
      // screen were gone the moment the page reloaded — and the carriers take days, so it always
      // did. Persisting first also means a throw anywhere in the twelve calls below loses no
      // typing, and validating first means an empty MessageFlow is refused here rather than by
      // the carriers a week later.
      const readyCopy = mergeCopy(reg, p.copy);
      const copyProblems = validateCampaignCopy(readyCopy);
      if (copyProblems.length) {
        throw new TrustHubError({ message: copyProblems[0], status: 400, code: 0, permanent: true });
      }
      await set({
        campaign_description: readyCopy.description,
        campaign_message_flow: readyCopy.messageFlow,
        campaign_message_samples: readyCopy.messageSamples,
        campaign_copy_updated_at: new Date().toISOString(),
      });

      // Stages 1 and 2. Twilio's ISV guide is explicit that the trust product does NOT have
      // to reach `approved` before the brand, so both are created in one pass and the first
      // real wait is at the brand itself.
      const prof = reg.customer_profile_sid
        ? { profileSid: reg.customer_profile_sid }
        : await createSecondaryCustomerProfile({
            intake, primaryProfileSid, friendlyName: `${clientId} — ${intake.legalBusinessName}`,
          });
      const a2p = reg.a2p_profile_sid
        ? { a2pProfileSid: reg.a2p_profile_sid }
        : await createA2pTrustProduct({
            profileSid: prof.profileSid, email: intake.repEmail,
            friendlyName: `${clientId} — A2P`,
          });
      await note("profiles_created", { profileSid: prof.profileSid, a2pProfileSid: a2p.a2pProfileSid });
      return await set({
        customer_profile_sid: prof.profileSid,
        a2p_profile_sid: a2p.a2pProfileSid,
        status: "profile_pending",
        next_poll_at: soon(2),
      });
    }

    case "profile_pending": {
      // ⚠️ THE MONEY STEP, in both senses: Twilio bills us for the brand registration, and
      // this is where the builder is charged for it. Guarded by the advance lock above and
      // reconciled by brand_sid below, so a repeat can never register — or charge — twice.
      if (reg.brand_sid) {
        return await set({ status: "brand_pending", next_poll_at: soon(30) });
      }

      // ⚠️ HOLD BEFORE SPENDING, CAPTURE AFTER IT SUCCEEDS. A charge taken before the thing
      // is bought is a refund waiting to happen; a charge taken after, with no hold, is a
      // registration we paid Twilio for and forgot to bill. The idempotency key is the
      // TENANT plus the act — never a timestamp — so a double Submit takes one hold.
      //
      // ⚠️ A MOCK BRAND COSTS NOTHING AT TWILIO, so it must not be charged for. Internal
      // accounts are comped and the meters are disarmed, so nothing would land today either
      // way — but a charging path whose correctness depends on two OTHER switches being off
      // is one refactor away from billing somebody for a test.
      const wantMock = reg.mock_brand === true;
      const held: { ok: true; holdId: number | null } | { ok: false; status: number; body: Record<string, unknown> } =
        wantMock
          ? { ok: true, holdId: null }
          : await takeHold(admin, clientId, "sms_registration", `sms_reg:${clientId}`, userId ?? null);
      if (!held.ok) throw new BillingRefusal(held.status, held.body);

      let b;
      try {
        b = await registerBrand({
          customerProfileBundleSid: reg.customer_profile_sid,
          a2pProfileBundleSid: reg.a2p_profile_sid,
          tier: reg.brand_tier,
          mock: wantMock,
        });
      } catch (e) {
        // Twilio refused, so nothing was bought. Release the hold rather than capturing it —
        // the builder must not pay for a registration that does not exist.
        if (held.holdId) {
          await admin.rpc("wallet_release", { p_hold_id: held.holdId, p_reason: "brand registration failed" })
            .then(() => {}, () => {});
        }
        throw e;
      }
      if (held.holdId) {
        await admin.rpc("wallet_capture", {
          p_hold_id: held.holdId, p_cost_cents: null,
          p_usage: { brand_sid: b.brandSid, tier: reg.brand_tier }, p_ref_id: b.brandSid,
        }).then(() => {}, () => {});
      }
      // ⚠️ ASKED FOR A MOCK AND GOT A REAL ONE. That means the parameter was ignored and a
      // REAL brand now exists, billed, against a business that only meant to test. Say so
      // loudly rather than letting the bill be the first anyone hears of it.
      if (wantMock && !b.mock) {
        await logEdgeError({
          fn: "portal-sms", clientId, code: "sms_mock_brand_came_back_real",
          message: `Asked Twilio for a mock brand and it created a REAL one (${b.brandSid}). This has been charged.`,
          context: { brandSid: b.brandSid, tier: reg.brand_tier },
        }).catch(() => {});
      }
      await note("brand_registered", { brandSid: b.brandSid, tier: reg.brand_tier, mock: b.mock });
      return await set({
        brand_sid: b.brandSid,
        brand_status: normalizeBrandStatus(b.status),
        brand_identity_status: b.identityStatus,
        // What Twilio SAYS it made, not what we asked for.
        mock_brand: b.mock,
        status: "brand_pending",
        next_poll_at: soon(30),
      });
    }

    case "brand_pending": {
      const b = await fetchBrand(reg.brand_sid);
      const status = normalizeBrandStatus(b.status);
      if (status === "APPROVED") {
        await note("brand_approved", { tcrId: b.tcrId });
        return await set({
          brand_status: status, brand_identity_status: b.identityStatus,
          last_errors: b.errors, status: "brand_approved", next_poll_at: soon(1),
        });
      }
      if (status === "FAILED" || status === "SUSPENDED") {
        return await set({
          brand_status: status, last_errors: b.errors, status: "brand_failed",
          next_poll_at: null, needs_attention: true,
          attention_note: status === "SUSPENDED"
            ? "The carriers suspended this brand. Only Twilio support can lift it."
            : "The carriers rejected this registration. Check the details and resubmit.",
        });
      }
      return await set({ brand_status: status, next_poll_at: soon(60) });
    }

    case "brand_approved": {
      // Stage 5–7: the Messaging Service, then the campaign against the eligible use cases.
      let svc: { serviceSid: string };
      if (reg.messaging_service_sid) {
        svc = { serviceSid: reg.messaging_service_sid };
      } else {
        svc = await createMessagingService({
          friendlyName: `${clientId} messaging`,
          inboundWebhookUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/sms-inbound?key=${Deno.env.get("SMS_INBOUND_SECRET") ?? ""}`,
          statusCallbackUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/sms-status?key=${Deno.env.get("SMS_INBOUND_SECRET") ?? ""}`,
        });
        // ⚠️ WRITE IT DOWN BEFORE ANYTHING ELSE CAN THROW. Everything below this line can
        // fail, and until 2026-08-31 a failure meant the SID was never persisted, so the next
        // attempt built a SECOND Messaging Service and abandoned the first. Observed on the
        // very first live run: MG7ae8… was orphaned with our inbound webhook still on it.
        // A leaked service is not free of consequence, it is an endpoint pointing at us that
        // nothing owns.
        await set({ messaging_service_sid: svc.serviceSid });
      }

      // ⚠️ NEVER HARDCODE THE USE CASE. What a brand may register is only knowable after it
      // is approved, and it varies by brand tier.
      //
      // ⚠️ 21717 HERE MEANS "TOO SOON", NOT "BROKEN". Twilio reports the brand APPROVED before
      // it will answer use-case questions about it, and Twilio's own guidance is to pause
      // after brand submission for exactly this reason. `advance` is a button, so it does not
      // wait for next_poll_at the way the lazy sweep does, and a builder clicking straight
      // through hits this every time. It used to surface as "Support has been notified",
      // which is a dead end for something that fixes itself in a minute.
      // 21717 out of here means "too soon" and is translated for the builder by the handler's
      // catch. Nothing is written, so the row stays brand_approved and a retry reuses the
      // Messaging Service persisted above.
      const eligible = await fetchEligibleUseCases(svc.serviceSid, reg.brand_sid);
      const wanted = String(p.useCase ?? "");
      const pick = eligible.find((u) => u.code === wanted)
        ?? eligible.find((u) => u.code === "MIXED")
        ?? eligible.find((u) => u.code === "CUSTOMER_CARE")
        ?? eligible[0];
      if (!pick) {
        return await set({
          messaging_service_sid: svc.serviceSid, status: "brand_approved",
          next_poll_at: soon(60), needs_attention: true,
          attention_note: "Twilio offered no eligible campaign use cases for this brand.",
        });
      }

      // ⚠️ THE COPY COMES FROM THE ROW, NOT ONLY FROM THE REQUEST. This card is reached after a
      // page reload BY DEFINITION — the carriers take days — so the browser's form state is empty
      // by the time anyone gets here. Reading only p.copy is why this used to answer 400 with no
      // form on screen to fix it.
      const copy = mergeCopy(reg, p.copy);
      const copyProblems = validateCampaignCopy(copy);
      if (copyProblems.length) {
        throw new TrustHubError({ message: copyProblems[0], status: 400, code: 0, permanent: true });
      }
      const samples: string[] = copy.messageSamples.filter(Boolean);
      // Keep whatever the caller improved: a campaign rejection can only be re-authored from our
      // own record, because the Usa2p resource has no update operation.
      await set({
        campaign_description: copy.description,
        campaign_message_flow: copy.messageFlow,
        campaign_message_samples: copy.messageSamples,
        campaign_copy_updated_at: new Date().toISOString(),
      });
      // The four fields below are NOT part of the persisted copy and deliberately still come
      // from the request: they are per-submission flags and boilerplate, not the paragraphs a
      // builder authored and would need back to re-author a rejection. `mergeCopy` carries only
      // the three that are worth surviving a reload.
      const extra = (p.copy ?? {}) as Record<string, unknown>;
      const c = await createCampaign({
        serviceSid: svc.serviceSid, brandSid: reg.brand_sid, useCase: pick.code,
        copy: {
          description: copy.description,
          messageFlow: copy.messageFlow,
          messageSamples: samples,
          optOutKeywords: "STOP", helpKeywords: "HELP", optInKeywords: "START",
          helpMessage: String(extra.helpMessage ?? ""),
          optOutMessage: String(extra.optOutMessage ?? ""),
        },
        hasEmbeddedLinks: !!extra.hasEmbeddedLinks,
        hasEmbeddedPhone: !!extra.hasEmbeddedPhone,
      });
      await note("campaign_submitted", { useCase: pick.code, campaignSid: c.campaignSid });
      return await set({
        messaging_service_sid: svc.serviceSid,
        campaign_sid: c.campaignSid,
        campaign_status: normalizeCampaignStatus(c.status),
        status: "campaign_pending",
        next_poll_at: soon(60),
      });
    }

    case "campaign_pending": {
      const c = await fetchCampaign(reg.messaging_service_sid);
      const status = normalizeCampaignStatus(c.status);
      if (status === "APPROVED") {
        await note("campaign_approved", {});
        return await set({
          campaign_status: status, status: "campaign_approved", next_poll_at: null,
        });
      }
      if (status === "FAILED") {
        // ⚠️ THERE IS NO CAMPAIGN UPDATE API. Deleting and re-creating is vetted as a new
        // submission and charges the fee again; the free path is a human editing it in the
        // Twilio Console. So this is an OPERATOR state, not an automatic retry.
        return await set({
          campaign_status: status, status: "campaign_failed", next_poll_at: null,
          needs_attention: true,
          attention_note: "The carriers rejected the campaign. It has to be corrected in the Twilio Console — re-creating it through the API would be charged again.",
        });
      }
      return await set({ campaign_status: status, next_poll_at: soon(120) });
    }

    case "campaign_approved":
      // Waiting for the builder to pick a number. Nothing to poll.
      return reg;

    case "brand_failed": {
      // Three free resubmissions, then error 21724. Whatever is being fixed lives upstream
      // in the bundle's EndUsers, so the caller is expected to have corrected those first.
      if (Number(reg.brand_update_count ?? 0) >= 3) {
        throw new TrustHubError({ message: "brand update limit reached", status: 400, code: 21724, permanent: true });
      }
      await updateBrand(reg.brand_sid);
      await note("brand_resubmitted", { attempt: Number(reg.brand_update_count ?? 0) + 1 });
      return await set({
        brand_update_count: Number(reg.brand_update_count ?? 0) + 1,
        status: "brand_pending", needs_attention: false, attention_note: null,
        next_poll_at: soon(30),
      });
    }

    default:
      return reg;
  }
}
