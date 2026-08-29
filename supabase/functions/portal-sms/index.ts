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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
  // ⚠️ SPENDS MONEY.
  advance:         { area: "settings_billing", level: "edit" },
  search_numbers:  { area: "settings_billing", level: "edit" },
  // ⚠️ SPENDS MONEY (a number is billed monthly from purchase).
  buy_number:      { area: "settings_billing", level: "edit" },
  // Consent management — the people who talk to customers.
  opt_outs:        { area: "contacts", level: "view" },
  set_opt_out:     { area: "contacts", level: "edit" },
};

const AUP_TEXT =
  "I confirm that this business will only text people who have given us permission to text " +
  "them, that we will stop when someone asks us to stop, and that we are responsible for " +
  "what we send. I understand our messages are sent under our own business's carrier " +
  "registration and that false information here can get our texting shut off.";

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
    intake: {
      legalBusinessName: reg?.legal_business_name ?? "",
      einLast4: reg?.ein_last4 ?? "",
      websiteUrl: reg?.website_url ?? "",
      privacyPolicyUrl: reg?.privacy_policy_url ?? "",
      termsUrl: reg?.terms_url ?? "",
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
        const reg = await load();
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
          const out = await advanceOne(admin, clientId, locked, p, primary, note);
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
        const bought = dupe ?? await purchaseNumber({
          phoneNumber: wanted, clientId, messagingServiceSid: reg.messaging_service_sid,
        });

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

      default:
        return json({ error: `Unrecognised action "${action}".` }, 400);
    }
  } catch (e) {
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
      // ⚠️ THE MONEY STEP. Guarded by the lock above; reconciled by brand_sid below so a
      // repeat can never register twice.
      if (reg.brand_sid) {
        return await set({ status: "brand_pending", next_poll_at: soon(30) });
      }
      const b = await registerBrand({
        customerProfileBundleSid: reg.customer_profile_sid,
        a2pProfileBundleSid: reg.a2p_profile_sid,
        tier: reg.brand_tier,
      });
      await note("brand_registered", { brandSid: b.brandSid, tier: reg.brand_tier });
      return await set({
        brand_sid: b.brandSid,
        brand_status: normalizeBrandStatus(b.status),
        brand_identity_status: b.identityStatus,
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
      const svc = reg.messaging_service_sid
        ? { serviceSid: reg.messaging_service_sid }
        : await createMessagingService({
            friendlyName: `${clientId} messaging`,
            inboundWebhookUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/sms-inbound?key=${Deno.env.get("SMS_INBOUND_SECRET") ?? ""}`,
            statusCallbackUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/sms-status?key=${Deno.env.get("SMS_INBOUND_SECRET") ?? ""}`,
          });

      // ⚠️ NEVER HARDCODE THE USE CASE. What a brand may register is only knowable after it
      // is approved, and it varies by brand tier.
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

      const copy = (p.copy ?? {}) as any;
      const samples: string[] = Array.isArray(copy.messageSamples) ? copy.messageSamples.filter(Boolean) : [];
      if (samples.length < 2) {
        throw new TrustHubError({
          message: "At least two example messages are needed before the campaign can be submitted.",
          status: 400, code: 0, permanent: true,
        });
      }
      const c = await createCampaign({
        serviceSid: svc.serviceSid, brandSid: reg.brand_sid, useCase: pick.code,
        copy: {
          description: String(copy.description ?? ""),
          messageFlow: String(copy.messageFlow ?? ""),
          messageSamples: samples,
          optOutKeywords: "STOP", helpKeywords: "HELP", optInKeywords: "START",
          helpMessage: String(copy.helpMessage ?? ""),
          optOutMessage: String(copy.optOutMessage ?? ""),
        },
        hasEmbeddedLinks: !!copy.hasEmbeddedLinks,
        hasEmbeddedPhone: !!copy.hasEmbeddedPhone,
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
