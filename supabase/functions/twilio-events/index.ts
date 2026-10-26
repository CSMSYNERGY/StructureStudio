import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";
import { timingSafeEqual } from "../_shared/emailInbound.ts";
import { normalizeBrandStatus, normalizeCampaignStatus } from "../_shared/twilioTrustHub.ts";
import { campaignVerdictPredatesResubmit, eventOccurrenceKey, eventOccurrenceStamp, numberEventTarget, numberVerdictEffect } from "../_shared/twilioEventKey.ts";
// Workstream 2, phase 4: whose Twilio account an event came from (only while TWILIO_SUBACCOUNTS is "on").
import { eventAccountSid, eventAccountVerdict, subaccountsOn } from "../_shared/twilioAccount.ts";

// Twilio Event Streams sink for A2P compliance events.
//
// This is not a nicety. Per-number A2P registration — the LAST step before a builder can
// text anyone — has NO polling API at all: the Messaging Service PhoneNumbers resource
// carries no A2P fields, and Twilio's only status readout is a Console CSV that "can take up
// to 24 hours to generate". These events are the only programmatic way to learn that a
// number went live. Everything else here (brand, campaign) is a faster echo of what the
// poller would eventually see anyway.
//
// ⚠️ verify_jwt MUST be false. Twilio cannot send a Supabase JWT, and with verification on
// the gateway 401s every delivery BEFORE this function runs — the billing-webhook failure
// mode, which was invisible from inside the database for weeks. Auth is the shared URL
// secret, compared in constant time.
//
// ⚠️ ANSWER FIRST, WORK AFTER — and this is not a precaution, it is a fix. The sink timeout
// is FIVE SECONDS and a cold Supabase isolate spends ~2.5s before its first query. The first
// version did the database work inline and Twilio's own test event came back **504 Timed out
// waiting for a response** — while the event itself had been received and stored perfectly.
// The work was never the problem; being still busy when Twilio gave up was.
//
// So the handler now authenticates, parses, and RETURNS 200 immediately, handing the
// processing to EdgeRuntime.waitUntil() so the isolate stays alive to finish it.
//
// ⚠️ The trade this makes, deliberately: a failure after the response cannot be reported to
// Twilio. That costs nothing here, because Event Streams has no documented redelivery — a
// non-2xx would not have earned a retry anyway, and could get the subscription disabled. The
// real safety nets for the signal that matters (per-number registration) are the poller and
// the probe send, both of which exist for exactly this reason.
//
// Still true: NO Twilio round trips in here, ever. Anything that needs one belongs in the poller.
//
// ⚠️ ALWAYS 200 ONCE AUTHENTICATED, like sms-inbound. Event Streams has no documented
// redelivery; a non-2xx buys nothing and can get the subscription disabled.
//
// ⚠️ ONE SINK PER TWILIO ACCOUNT, ONE SHARED KEY (Workstream 2, phase 4). Each builder's
// sub-account gets its own Event Streams sink pointing here with the same ?key=, so the key alone
// no longer says which account an event is from. While TWILIO_SUBACCOUNTS is "on", an event acts
// on a registration only when its AccountSid (the payload's `accountsid`) fits the account that
// registration's business lives in (_shared/twilioAccount.ts eventAccountVerdict): a sub's
// business only on an event naming that sub; a business on the parent on an event naming the
// parent OR NAMING NO ACCOUNT (today's events, until phase 6 confirms the field is sent). Anything
// else (another account, a sub's business with no AccountSid, a lookup that failed) is recorded
// with no tenant under a key of its own and reported as twilio_event_account_mismatch, never acted
// on. ⚠️ This is not authentication: the payload is written by whoever holds the key. Off,
// nothing here changes and nothing is looked up.

// Supabase's runtime provides this; the type is not in the edge-runtime .d.ts, so declare the
// one member used. Guarded at the call site — if it is ever absent the work is awaited inline,
// which is the pre-fix behaviour rather than silently dropping the event.
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

function ok(body: unknown = { ok: true }) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
function deny() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });
}

/** The A2P compliance event types worth acting on. Anything else is recorded and ignored —
 *  Twilio adds event types, and an unknown one must never look like a failure. */
const NUMBER_EVENTS = new Set([
  "com.twilio.messaging.compliance.number-registration.pending",
  "com.twilio.messaging.compliance.number-registration.successful",
  "com.twilio.messaging.compliance.number-registration.failed",
]);

Deno.serve(withErrorLog("twilio-events", async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const secret = Deno.env.get("TWILIO_EVENTS_SECRET") ?? "";
  const key = new URL(req.url).searchParams.get("key") ?? "";
  // Unset secret ⇒ refuse everything. Inert, never open — the same posture email-inbound and
  // sms-inbound ship with, so this can be deployed long before the sink is created.
  if (!secret || !timingSafeEqual(key, secret)) return deny();

  let events: any[] = [];
  try {
    const body = await req.json();
    // Event Streams posts a CloudEvents ARRAY. A single object is accepted too so a manual
    // curl probe behaves the same as the real thing.
    events = Array.isArray(body) ? body : [body];
  } catch {
    return ok({ ok: true, ignored: "unparseable" });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // ── Respond NOW, process after ───────────────────────────────────────────────────────
  // Everything above is cheap and synchronous: a constant-time secret compare and a JSON
  // parse. Everything below touches the database, and that is what blew the five-second
  // budget. Twilio gets its 200 while the work runs on.
  const work = processEvents(admin, events);
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
      EdgeRuntime.waitUntil(work);
    } else {
      // No waitUntil in this runtime — finishing the work matters more than the deadline,
      // because a dropped event has no redelivery to save it.
      await work;
    }
  } catch {
    await work.catch(() => {});
  }
  return ok({ ok: true, received: events.length });
}));

// deno-lint-ignore no-explicit-any
async function processEvents(admin: any, events: any[]): Promise<void> {
  // Three different reasons an event ends without acting, each reported under its own code at
  // the end of the batch. They used to share ONE "no recognised A2P fields" row, which was
  // wrong for two of them and hid the dedupe collision below for most of a month.
  const duplicates: Record<string, unknown>[] = [];
  const noTenant: Record<string, unknown>[] = [];
  const stale: Record<string, unknown>[] = [];
  const unhandledTypes: string[] = [];
  const mismatched: Record<string, unknown>[] = [];
  const envGet = (k: string) => Deno.env.get(k);
  const perAccount = subaccountsOn(envGet);
  for (const ev of events) {
    const eventId = String(ev?.id ?? "");
    const type = String(ev?.type ?? "");
    const d = (ev?.data ?? {}) as Record<string, any>;
    // ⚠️ Twilio's OWN connectivity test carries no A2P fields and matches no tenant by design,
    // and someone will press that button many times while wiring a sink. Reporting it would
    // turn a healthy setup step into a repeating info row — and a repeating info row is the
    // signal this project uses to find real bugs, so polluting it has a cost beyond noise.
    const isTest = type.endsWith(".test-event");
    let handled = false;

    // ── Resolve the tenant ────────────────────────────────────────────────────────────
    // ⚠️ NEVER on the campaign SID. The event payload's `campaignsid` is a CM… SID, a
    // DIFFERENT SID SPACE from the QE… the REST API returns and stores in campaign_sid.
    // Joining those two is a bug that silently matches nothing. brandsid (BN…) and
    // messagingservicesid (MG…) DO match what we store.
    const brandSid = String(d.brandsid ?? d.brandSid ?? "");
    const serviceSid = String(d.messagingservicesid ?? d.messagingServiceSid ?? "");
    const numberTarget = numberEventTarget(d);

    let reg: any = null;
    if (brandSid) {
      const { data } = await admin.from("sms_registrations").select("*").eq("brand_sid", brandSid).maybeSingle();
      reg = data;
    }
    if (!reg && serviceSid) {
      const { data } = await admin.from("sms_registrations").select("*").eq("messaging_service_sid", serviceSid).maybeSingle();
      reg = data;
    }

    // ── Whose account (switch on only) ────────────────────────────────────────────────
    // A registration found above is acted on only when the event came from the account its
    // business lives in. Otherwise the event is recorded with no tenant and reported below.
    if (perAccount && reg) {
      const verdict = await eventAccountVerdict(admin, d, String(reg.client_id), envGet);
      if (verdict !== "ok") {
        if (!isTest) {
          const evAccount = eventAccountSid(d);
          mismatched.push({
            type, client_id: reg.client_id, lookup_failed: verdict === "lookup_failed",
            // SID prefixes only, like twilio_event_no_tenant: enough to find it, not a copy.
            event_account: evAccount ? evAccount.slice(0, 8) : null,
          });
        }
        // ⚠️ UNDER A KEY OF ITS OWN, never the event's real one: a refusal (a lookup that failed for
        // a moment, above all) must not use up the idempotency key, or the same event re-sent
        // later (Twilio does re-send, see twilioEventKey.ts), or replayed by hand once the cause is
        // fixed, would be dropped as a duplicate and its verdict never applied.
        const realKey = eventOccurrenceKey(eventId, d);
        await admin.from("sms_registration_events").insert({
          client_id: null, event_id: realKey ? `${realKey}:refused` : null, event_type: type, detail: d,
        }).then(() => {}, () => {});
        continue;
      }
    }

    // ── Record first, act second ──────────────────────────────────────────────────────
    // The idempotency key is the CloudEvents id PLUS the payload's occurrence stamp. The id
    // alone is fixed per (campaign, event type), so after in-place campaign edits every verdict
    // but the first collided and was dropped — see _shared/twilioEventKey.ts. A 23505 now means
    // the same payload really was delivered twice, which is still a SUCCESS (the event is
    // already recorded) and must not look like a failure or provoke a retry.
    const key = eventOccurrenceKey(eventId, d);
    const { error: insErr } = await admin.from("sms_registration_events").insert({
      client_id: reg?.client_id ?? null,
      event_id: key,
      event_type: type,
      detail: d,
    });
    if (insErr && String((insErr as { code?: string }).code) === "23505") {
      // Skipped, but never silently: a collision that was not really a redelivery is exactly
      // how the per-type id went unnoticed. Both stamps side by side tell the two apart.
      if (!isTest) {
        const { data: prior } = await admin.from("sms_registration_events")
          .select("created_at, detail").eq("event_id", key).maybeSingle();
        duplicates.push({
          id: eventId, key, type,
          stamp: eventOccurrenceStamp(d) || null,
          prior_stamp: prior ? eventOccurrenceStamp(prior.detail) || null : null,
          first_recorded_at: prior?.created_at ?? null,
        });
      }
      continue;
    }
    if (insErr) {
      // Any other failure means the event was NOT recorded. Act on it anyway (Twilio will not
      // send it again, and the row is the thing the builder is waiting on), but say so: "record
      // first" silently not happening is how the last two SMS bugs stayed invisible.
      await logEdgeError({
        fn: "twilio-events",
        clientId: reg?.client_id ?? null,
        code: "twilio_event_record_failed",
        message: `sms_registration_events insert for ${type} failed: ${insErr.message}`,
        severity: "error",
        context: { event_id: eventId, event_type: type, pg_code: (insErr as { code?: string }).code ?? null },
      }).catch(() => {});
    }
    if (!reg) {
      // Recorded above with client_id null. SID prefixes only: enough to find the brand in
      // the Twilio console, not a copy of the payload.
      if (!isTest) {
        noTenant.push({ type, brand: brandSid.slice(0, 8) || null, service: serviceSid.slice(0, 8) || null });
      }
      continue;
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    // ── Per-number registration: the reason this function exists ─────────────────────
    if (NUMBER_EVENTS.has(type) && (numberTarget.sid || numberTarget.phone)) {
      // Twilio's own vocabulary, kept verbatim on the number row.
      const external = String(d.externalstatus ?? d.externalStatus ?? "").toLowerCase();
      const status = type.endsWith(".successful") || external === "registered"
        ? "registered"
        : type.endsWith(".failed") ? "failed" : "pending_registration";
      // ⚠️ READ WHAT MATCHED. This update used to key on Twilio's raw `phonenumber`, which has
      // no "+", so it matched nothing and nobody knew; see numberEventTarget. SID first, the
      // E.164 phone only if the SID finds no row.
      const setNumber = (col: string, val: string) => admin.from("sms_numbers")
        .update({ registration_status: status })
        .eq("client_id", reg.client_id).eq(col, val).is("released_at", null).select("id, phone_number");
      let numRes = numberTarget.sid ? await setNumber("twilio_sid", numberTarget.sid) : null;
      if (numberTarget.phone && !numRes?.error && !numRes?.data?.length) {
        numRes = await setNumber("phone_number", numberTarget.phone);
      }
      const numberMatched = !numRes?.error && (numRes?.data?.length ?? 0) > 0;
      if (!numberMatched) {
        await logEdgeError({
          fn: "twilio-events",
          clientId: reg.client_id,
          code: "sms_number_update_missed",
          message: `No live sms_numbers row took ${type}${numRes?.error ? `: ${numRes.error.message}` : ""}`,
          severity: "error",
          context: {
            event_id: eventId, event_type: type, status,
            by_sid: !!numberTarget.sid, by_phone: !!numberTarget.phone,
            pg_code: numRes?.error?.code ?? null,
          },
        }).catch(() => {});
      }

      // ⚠️ WHICH NUMBER (migration 266): only the main texting number's verdict is about the
      // business's texting; another number's stays on its own row (numberVerdictEffect). The main
      // number is read only for a verdict; a failed read counts as none on record, which is how
      // every number event was read before 266.
      let mainNumber: string | null = null;
      if (status !== "pending_registration") {
        const { data: csMain } = await admin.from("client_settings")
          .select("sms_number").eq("client_id", reg.client_id).maybeSingle();
        mainNumber = (csMain as { sms_number?: string | null } | null)?.sms_number ?? null;
      }
      const matchedRow = numberMatched ? (numRes!.data![0] as { id?: string; phone_number?: string | null }) : null;
      const effect = numberVerdictEffect({
        status, numberMatched, eventPhone: matchedRow?.phone_number || numberTarget.phone, mainNumber,
      });

      // Only when the number row itself moved: smsSend checks THAT row on every send, so an
      // "active" builder whose number still reads pending is a switch that texts nobody.
      if (effect === "activate") {
        // THE MOMENT TEXTING BECOMES LEGAL for this builder. Both switches flip together:
        // sms_registrations.status gates the feature, client_settings.sms_status is what
        // smsSend reads on every send.
        patch.status = "active";
        patch.next_poll_at = null;
        patch.needs_attention = false;
        patch.attention_note = null;
        await admin.from("client_settings")
          .update({ sms_status: "active" }).eq("client_id", reg.client_id);
      } else if (effect === "attention") {
        patch.needs_attention = true;
        patch.attention_note = "The carriers refused to register this number. It may need to be released and replaced.";
      } else if (effect === "extra_failed") {
        // The business still texts from its main number, and this one still takes calls; the
        // Phone tab says so beside it. Logged so someone can look into the refusal.
        await logEdgeError({
          fn: "twilio-events",
          clientId: reg.client_id,
          code: "sms_extra_number_registration_failed",
          message: `The carriers refused to register one of the business's other numbers for texting (${type}); the main texting number is unaffected`,
          severity: "error",
          context: { event_id: eventId, event_type: type, number_id: matchedRow?.id ?? null },
        }).catch(() => {});
      }
      handled = true;
    }

    // ── Brand and campaign: a faster echo of what the poller would find ──────────────
    // ⚠️ Event statuses are lowercase and DISJOINT from the REST enum ("registered",
    // "vetting_failed"). Normalising here is what stops one column meaning two things
    // depending on which code path wrote it last.
    const brandStatusRaw = String(d.brandstatus ?? d.brandStatus ?? "");
    if (brandStatusRaw) {
      const s = normalizeBrandStatus(brandStatusRaw);
      patch.brand_status = s;
      if (s === "APPROVED" && reg.status === "brand_pending") {
        patch.status = "brand_approved";
        patch.next_poll_at = new Date(Date.now() + 60_000).toISOString();
      }
      if (s === "FAILED" || s === "SUSPENDED") {
        patch.status = "brand_failed";
        patch.next_poll_at = null;
        patch.needs_attention = true;
        patch.attention_note = s === "SUSPENDED"
          ? "The carriers suspended this brand. Only Twilio support can lift it."
          : "The carriers rejected this registration.";
      }
      handled = true;
    }
    const identityRaw = String(d.identitystatus ?? d.identityStatus ?? "");
    if (identityRaw) patch.brand_identity_status = identityRaw.toUpperCase();

    const campaignRaw = String(d.campaignregistrationstatus ?? d.campaignStatus ?? "");
    // A verdict about an EARLIER submission (a replay, or one that arrives after the builder
    // resubmitted) must not touch the row; see _shared/twilioEventKey.ts. Recorded above, and
    // reported below so a flood of them is still visible.
    const staleVerdict = !!campaignRaw && campaignVerdictPredatesResubmit(d, reg.campaign_copy_updated_at);
    if (staleVerdict) {
      stale.push({ id: eventId, type, stamp: eventOccurrenceStamp(d) || null, copy_updated_at: reg.campaign_copy_updated_at ?? null });
      handled = true;
    }
    if (campaignRaw && !staleVerdict) {
      const s = normalizeCampaignStatus(campaignRaw);
      // ⚠️ A DECIDED CAMPAIGN NEVER GOES BACK TO PENDING. Twilio delivers these events out of
      // order — on 2026-09-02 the failure landed at 18:01:12.969 and the SUBMITTED event that
      // preceded it by Twilio's own clock arrived 246ms LATER, overwriting FAILED with PENDING.
      // The row then disagreed with itself for hours (`status` rejected, `campaign_status`
      // pending) and the screen it produced could not be reasoned about. A verdict is terminal
      // until our own code resubmits, which is the only thing that writes PENDING back.
      const settled = reg.campaign_status === "APPROVED" || reg.campaign_status === "FAILED";
      if (!(s === "PENDING" && settled)) patch.campaign_status = s;
      // ⚠️ PROMOTE FROM `campaign_failed` TOO. A rectified campaign is approved FROM the failed
      // state — that is the whole point of the free in-place resubmit — and gating this on
      // `campaign_pending` alone left the builder staring at "the carriers turned this one
      // down" over an APPROVED campaign, with no route to the number step, forever.
      if (s === "APPROVED" && ["campaign_pending", "campaign_failed"].includes(String(reg.status))) {
        patch.status = "campaign_approved";
        patch.next_poll_at = null;
        patch.needs_attention = false;
        patch.attention_note = null;
        patch.last_errors = [];
      }
      if (s === "FAILED") {
        patch.status = "campaign_failed";
        patch.next_poll_at = null;
        patch.needs_attention = true;
        patch.attention_note = "The carriers turned down the way this campaign describes its texting. Fix the wording and send it again — resending costs nothing.";
      }
      handled = true;
    }
    // ⚠️ THE ONE THING THE BUILDER ACTUALLY NEEDS, AND IT USED TO BE THROWN AWAY. Twilio names
    // the failing fields (30908 PRIVACY_POLICY_URL, 30882 TERMS_AND_CONDITIONS_URL, …) right
    // here, and nothing stored them: `last_errors` was only ever written on the BRAND path, so
    // the rejection card rendered "They told us why. Fix what they named" over an empty list.
    // Two campaigns were refused for the same two fields without that ever reaching a screen.
    const campErrs = d.campaignregistrationerrors ?? d.campaignRegistrationErrors ?? null;
    if (Array.isArray(campErrs) && !staleVerdict) patch.last_errors = campErrs;
    // The CM… campaign SID, kept in its own column so it can never be confused with the QE…
    const cm = String(d.campaignsid ?? d.campaignSid ?? "");
    // Not from a stale verdict: a replay about a campaign retry_campaign has since deleted
    // would put the old CM SID back.
    if (cm && !staleVerdict) patch.campaign_cm_sid = cm;

    if (Object.keys(patch).length > 1) {
      // ⚠️ READ THE ERROR. This result was ignored, so when the first campaign-approved event
      // arrived (structure-studio, 2026-09-22) and the write broke sms_registrations_poll_chk,
      // the whole patch vanished — campaign_status with it — and nothing but a Postgres log
      // line said so. The event row above is already stored, so this is the only trace.
      // Twilio has had its 200 long ago; this runs under waitUntil and cannot change it.
      const { error: updErr } = await admin.from("sms_registrations").update(patch).eq("client_id", reg.client_id);
      if (updErr) {
        await logEdgeError({
          fn: "twilio-events",
          clientId: reg.client_id,
          code: "sms_registration_update_failed",
          message: `sms_registrations update for ${type} failed: ${updErr.message}`,
          severity: "error",
          // KEYS, not values: the patch can carry Twilio's error texts and attention notes.
          context: { event_id: eventId, event_type: type, from_status: reg.status, patch_keys: Object.keys(patch), pg_code: updErr.code ?? null },
        }).catch(() => {});
      }
    }
    if (!handled && !isTest) unhandledTypes.push(type);
  }

  // All three are info, not errors: each is the code declining correctly. They stay visible
  // so a flood of any one of them is still noticed.
  if (duplicates.length) {
    await logEdgeError({
      fn: "twilio-events",
      code: "twilio_event_duplicate",
      message: `${duplicates.length} event(s) were already recorded under the same key and were skipped.`,
      severity: "info",
      context: { events: duplicates.slice(0, 5) },
    }).catch(() => {});
  }
  if (stale.length) {
    await logEdgeError({
      fn: "twilio-events",
      code: "twilio_event_stale_verdict",
      message: `${stale.length} campaign verdict(s) predate the last resubmit and were not applied.`,
      severity: "info",
      context: { events: stale.slice(0, 5) },
    }).catch(() => {});
  }
  if (noTenant.length) {
    await logEdgeError({
      fn: "twilio-events",
      code: "twilio_event_no_tenant",
      message: `${noTenant.length} event(s) matched no SMS registration. Recorded, not acted on.`,
      severity: "info",
      context: { events: noTenant.slice(0, 5) },
    }).catch(() => {});
  }
  if (mismatched.length) {
    // An error, not info: either an account other than the business's is posting events about it,
    // or our own record of which account the business lives in is wrong. Someone looks at both.
    await logEdgeError({
      fn: "twilio-events",
      code: "twilio_event_account_mismatch",
      message: `${mismatched.length} event(s) came from a Twilio account other than the one their business lives in, or carried none. Recorded, not acted on.`,
      severity: "error",
      context: { events: mismatched.slice(0, 5) },
    }).catch(() => {});
  }
  if (unhandledTypes.length) {
    // Matched a tenant and was new, but no branch above understood it. Twilio adds event
    // types, and an unrecognised one is recorded above and deliberately ignored.
    await logEdgeError({
      fn: "twilio-events",
      code: "twilio_event_unhandled",
      message: `Received ${unhandledTypes.length} event(s) with no recognised A2P fields.`,
      severity: "info",
      context: { types: unhandledTypes.slice(0, 5) },
    }).catch(() => {});
  }
}
