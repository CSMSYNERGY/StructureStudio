import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";
import { clientIp } from "../_shared/adminGate.ts";
import { hasPaidFeature } from "../_shared/featureCheck.ts";
import { availableSlots, widenBusy, parseDay } from "../_shared/meetingAvailability.ts";

// BOOK-PUBLIC — the public booking page's only server. Migration 325, phase 1 of
// MEETINGS_SCOPE.md. Four actions, all ANON (the anon key passes the gateway; config.toml
// keeps verify_jwt = false because a shed shopper has no account and never will):
//
//   availability  open slots for one host + type over a date range
//   book          take one
//   lookup        read a booking back from its cancel token (the manage page)
//   cancel        give one up, authenticated by that token
//
// `clientId` comes from the BODY — it has to, this is a public endpoint — and is validated
// against the tenant's own `get_public_booking` read before anything else happens. Nothing
// here trusts a host id, a type id or a price from the browser: every one is re-read from the
// database under the tenant named in the same request.
//
// ── THE TOKEN IS THE AUTHENTICATION ──────────────────────────────────────────────────────
// Cancel and reschedule are authenticated by `meetings.cancel_token`, an unguessable value in
// the confirmation email's link — the same capability model as a design's short_code. It is
// NOT the email address: anyone can type a customer's email, and a cancel-by-email endpoint
// is a way to clear a builder's diary from the outside. A wrong token answers exactly what an
// unknown one does, so a refusal never confirms that a booking exists.
//
// ── RATE LIMITED, AND THE ORDER MATTERS ──────────────────────────────────────────────────
// Anyone holding the public anon key can otherwise drive unbounded writes into ANY configured
// tenant. capture-lead's header explains at length why its guards moved to run BEFORE every
// write rather than between the local write and the outbound call: "A cap that lets the flood
// write is not a cap." Same conclusion here, and this endpoint is worse than capture-lead's
// in one way — a flood does not merely grow a table, it fills a real person's calendar with
// junk meetings they have to cancel by hand.
//
// Three buckets, because there are three different attacks:
//   * per tenant      — many different names/emails: fills one builder's diary
//   * per IP          — one source hammering, whatever tenant it names
//   * per host+window — the narrow one: repeated attempts on a single calendar
//
// ⚠️ Deliberately NO global cap, for the reason given in capture-lead: a global window needs
// an `updated_at`-only scan with no index to serve it, which becomes its own DoS surface as
// the table grows. Per-tenant times the tenant count already bounds the total.

const RATE_WINDOW_MS = 60_000;
const RATE_AVAILABILITY_PER_IP = 60;   // a month view is one call; browsing is a handful
const RATE_BOOK_PER_IP = 5;
const RATE_BOOK_PER_TENANT = 20;
const RATE_BOOK_PER_HOST = 10;
const RATE_LOG_CEILING = 3;            // log the first few of a burst, then go quiet

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

/** Count first, then decide — delivery-quote's and shop-checkout's shape. Fails OPEN on a
 *  storage error: a rate limiter that breaks must not take the booking page down with it. */
// deno-lint-ignore no-explicit-any
async function overCap(admin: any, bucket: string, max: number): Promise<{ over: boolean; hits: number }> {
  const nowMs = Date.now();
  const { data: rl, error } = await admin.from("rate_buckets")
    .select("window_started_at, hits").eq("bucket", bucket).maybeSingle();
  if (error) return { over: false, hits: 0 };
  const startedAt = rl?.window_started_at ? Date.parse(String(rl.window_started_at)) : NaN;
  const inWindow = Number.isFinite(startedAt) && (nowMs - startedAt) < RATE_WINDOW_MS;
  const hits = (inWindow ? (Number(rl?.hits) || 0) : 0) + 1;
  await admin.from("rate_buckets").upsert({
    bucket,
    window_started_at: inWindow ? rl!.window_started_at : new Date(nowMs).toISOString(),
    hits,
    updated_at: new Date(nowMs).toISOString(),
  }, { onConflict: "bucket" });
  return { over: hits > max, hits };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN = /^[0-9a-f]{24,64}$/;
// Deliberately loose. A booking page is not the place to adjudicate exotic-but-valid
// addresses; the confirmation either arrives or it does not, and refusing a real customer
// over a regex costs a builder a sale.
const EMAILISH = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

Deno.serve(withErrorLog("book-public", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "We could not read that request." }, 400);
  }

  const action = str(body.action, 40) || "availability";
  const clientId = str(body.clientId, 64).toLowerCase();
  const ip = clientIp(req) || "unknown";

  if (!SLUG.test(clientId)) return json({ ok: false, error: "not_found" }, 404);

  // ── The page has to be switched on, and the account has to have the CRM ───────────────
  // get_public_booking answers {ok:false, reason:'not_found'} for a tenant that does not
  // exist, a tenant with Meetings off, AND an unknown host — indistinguishable on purpose,
  // so nobody can enumerate which builders have the feature or who works there.
  const hostSlug = str(body.hostSlug, 40).toLowerCase();

  // `lookup` and `cancel` are keyed on a token, not a host, so they skip the host read.
  const needsHost = action === "availability" || action === "book";
  // deno-lint-ignore no-explicit-any
  let page: any = null;
  if (needsHost) {
    if (!SLUG.test(hostSlug)) return json({ ok: false, error: "not_found" }, 404);
    const { data, error } = await admin.rpc("get_public_booking", {
      p_client_id: clientId,
      p_host_slug: hostSlug,
    });
    if (error) throw error;
    page = data;
    if (!page || page.ok !== true) return json({ ok: false, error: "not_found" }, 404);
  }

  // Booking is part of the CRM (Carolyn 2026-10-22). Fails CLOSED — `crm` is pay-only, so
  // there is no blanket to fall back on, and a public page that keeps taking bookings for an
  // account that stopped paying is a promise we cannot keep. The customer is never told
  // about anyone's subscription: they get the same "not taking bookings" the page shows when
  // a host has switched themselves off.
  if (action === "availability" || action === "book") {
    let crmOn = false;
    try {
      crmOn = await hasPaidFeature(admin, clientId, "crm");
    } catch (e) {
      console.error("book-public: entitlement read failed:", (e as Error)?.message);
      return json({ ok: false, error: "unavailable" }, 503);
    }
    if (!crmOn) return json({ ok: false, error: "not_found" }, 404);
  }

  switch (action) {
    // ══ AVAILABILITY ════════════════════════════════════════════════════════════════════
    case "availability": {
      const cap = await overCap(admin, `book:avail:ip:${ip}`, RATE_AVAILABILITY_PER_IP);
      if (cap.over) return json({ ok: false, error: "busy" }, 429);

      const typeSlug = str(body.typeSlug, 40).toLowerCase();
      if (!SLUG.test(typeSlug)) return json({ ok: false, error: "not_found" }, 404);

      // Re-read the host and type from the database rather than trusting the page's copy,
      // and join through meeting_host_types so a type this host does not offer is not
      // bookable by anyone who edits the URL.
      const { data: host, error: he } = await admin.from("meeting_hosts")
        .select("id, user_id, time_zone, weekly_hours, accepting")
        .eq("client_id", clientId).eq("slug", hostSlug).eq("active", true).maybeSingle();
      if (he) throw he;
      if (!host) return json({ ok: false, error: "not_found" }, 404);

      const { data: type, error: te } = await admin.from("meeting_types")
        .select("id, duration_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_hours, max_days_ahead, slot_interval_minutes, meeting_host_types!inner(host_id)")
        .eq("client_id", clientId).eq("slug", typeSlug).eq("active", true)
        .eq("meeting_host_types.host_id", host.id).maybeSingle();
      if (te) throw te;
      if (!type) return json({ ok: false, error: "not_found" }, 404);

      if (!host.accepting) {
        return json({ ok: true, accepting: false, timeZone: host.time_zone, days: [] });
      }

      const today = new Date().toISOString().slice(0, 10);
      const fromDate = parseDay(str(body.fromDate, 10)) ? str(body.fromDate, 10) : today;
      const toDate = parseDay(str(body.toDate, 10))
        ? str(body.toDate, 10)
        : new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10);

      const { data: overrides, error: oe } = await admin.from("meeting_overrides")
        .select("on_date, blocked, hours").eq("host_id", host.id);
      if (oe) throw oe;

      const fromIso = new Date(Date.parse(fromDate + "T00:00:00Z") - 2 * 86_400_000).toISOString();
      const toIso = new Date(Date.parse(toDate + "T00:00:00Z") + 2 * 86_400_000).toISOString();

      const [{ data: booked, error: be }, { data: ext, error: ee }] = await Promise.all([
        admin.from("meetings")
          .select("starts_at, ends_at, meeting_types!inner(buffer_before_minutes, buffer_after_minutes)")
          .eq("host_user_id", host.user_id).eq("status", "booked")
          .lt("starts_at", toIso).gt("ends_at", fromIso),
        admin.from("meeting_busy").select("starts_at, ends_at")
          .eq("host_id", host.id).lt("starts_at", toIso).gt("ends_at", fromIso),
      ]);
      if (be) throw be;
      if (ee) throw ee;

      const busy = widenBusy(
        // deno-lint-ignore no-explicit-any
        ((booked ?? []) as any[]).map((m) => ({
          startsAt: m.starts_at,
          endsAt: m.ends_at,
          bufferBeforeMinutes: m.meeting_types?.buffer_before_minutes ?? 0,
          bufferAfterMinutes: m.meeting_types?.buffer_after_minutes ?? 0,
        })),
        // deno-lint-ignore no-explicit-any
      ).concat(widenBusy(((ext ?? []) as any[]).map((b) => ({ startsAt: b.starts_at, endsAt: b.ends_at }))));

      const days = availableSlots({
        timeZone: host.time_zone,
        weeklyHours: host.weekly_hours || {},
        // deno-lint-ignore no-explicit-any
        overrides: ((overrides ?? []) as any[]).map((o) => ({
          onDate: o.on_date, blocked: o.blocked, hours: o.hours || [],
        })),
        busy,
        type: {
          durationMinutes: type.duration_minutes,
          bufferBeforeMinutes: type.buffer_before_minutes,
          bufferAfterMinutes: type.buffer_after_minutes,
          minNoticeHours: type.min_notice_hours,
          maxDaysAhead: type.max_days_ahead,
          slotIntervalMinutes: type.slot_interval_minutes,
        },
        fromDate,
        toDate,
        now: new Date(),
      });

      return json({ ok: true, accepting: true, timeZone: host.time_zone, days });
    }

    // ══ BOOK ════════════════════════════════════════════════════════════════════════════
    case "book": {
      // ⚠️ ALL THREE CAPS BEFORE ANY WRITE. See the header: a cap that lets the flood write
      // is not a cap, and this one writes onto a real person's calendar.
      const typeSlug = str(body.typeSlug, 40).toLowerCase();
      if (!SLUG.test(typeSlug)) return json({ ok: false, error: "not_found" }, 404);

      const perIp = await overCap(admin, `book:do:ip:${ip}`, RATE_BOOK_PER_IP);
      const perTenant = await overCap(admin, `book:do:tenant:${clientId}`, RATE_BOOK_PER_TENANT);
      const perHost = await overCap(admin, `book:do:host:${clientId}:${hostSlug}`, RATE_BOOK_PER_HOST);
      if (perIp.over || perTenant.over || perHost.over) {
        const worst = Math.max(perIp.hits, perTenant.hits, perHost.hits);
        if (worst <= Math.max(RATE_BOOK_PER_IP, RATE_BOOK_PER_TENANT, RATE_BOOK_PER_HOST) + RATE_LOG_CEILING) {
          await logEdgeError({
            fn: "book-public",
            req,
            clientId,
            code: "rate_cap",
            message: `book-public rate cap hit — ip ${perIp.hits}, tenant ${perTenant.hits}, host ${perHost.hits} in ${RATE_WINDOW_MS / 1000}s; booking dropped`,
            context: { ip: perIp.hits, tenant: perTenant.hits, host: perHost.hits },
          });
        }
        return json({ ok: false, error: "busy" }, 429);
      }

      const name = str(body.name, 120);
      const email = str(body.email, 254).toLowerCase();
      const phone = str(body.phone, 32);
      const notes = str(body.notes, 2000);
      const startsAt = str(body.startsAt, 40);
      const customerTz = str(body.timeZone, 64);

      if (!name) return json({ ok: false, error: "Tell us your name." }, 400);
      if (!email && !phone) {
        return json({ ok: false, error: "Add an email address or a phone number so we can confirm it." }, 400);
      }
      if (email && !EMAILISH.test(email)) {
        return json({ ok: false, error: "That email address doesn't look right." }, 400);
      }
      const startMs = Date.parse(startsAt);
      if (!Number.isFinite(startMs)) return json({ ok: false, error: "Pick a time." }, 400);

      const { data: host, error: he } = await admin.from("meeting_hosts")
        .select("id, user_id, time_zone, accepting")
        .eq("client_id", clientId).eq("slug", hostSlug).eq("active", true).maybeSingle();
      if (he) throw he;
      if (!host) return json({ ok: false, error: "not_found" }, 404);
      if (!host.accepting) {
        return json({ ok: false, error: "They aren't taking bookings right now." }, 409);
      }

      const { data: type, error: te } = await admin.from("meeting_types")
        .select("id, name, duration_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_hours, max_days_ahead, location_kind, location_detail, meeting_host_types!inner(host_id)")
        .eq("client_id", clientId).eq("slug", typeSlug).eq("active", true)
        .eq("meeting_host_types.host_id", host.id).maybeSingle();
      if (te) throw te;
      if (!type) return json({ ok: false, error: "not_found" }, 404);

      // ⚠️ RE-CHECK THE NOTICE AND HORIZON WINDOWS SERVER-SIDE. The browser already hides
      // these slots, which is exactly why they must be checked again: a posted `startsAt` is
      // a number a stranger chose, and without this anyone could book a lot walkthrough for
      // 3am tomorrow, or for a date in 2031, by skipping the page entirely.
      const nowMs = Date.now();
      if (startMs < nowMs + type.min_notice_hours * 3_600_000) {
        return json({ ok: false, error: "That time is too soon to book. Please pick a later one." }, 409);
      }
      if (startMs > nowMs + type.max_days_ahead * 86_400_000) {
        return json({ ok: false, error: "That date is further ahead than they're taking bookings." }, 409);
      }

      // The start must be a time the engine would actually have offered — not merely free.
      // Otherwise a hand-made request can land a meeting at 02:07 on a Sunday: outside the
      // host's hours, off the slot grid, and in a gap no buffer protects.
      const { data: overrides, error: oe } = await admin.from("meeting_overrides")
        .select("on_date, blocked, hours").eq("host_id", host.id);
      if (oe) throw oe;
      const windowFrom = new Date(startMs - 2 * 86_400_000).toISOString();
      const windowTo = new Date(startMs + 2 * 86_400_000).toISOString();
      const [{ data: booked2, error: be2 }, { data: ext2, error: ee2 }] = await Promise.all([
        admin.from("meetings")
          .select("starts_at, ends_at, meeting_types!inner(buffer_before_minutes, buffer_after_minutes)")
          .eq("host_user_id", host.user_id).eq("status", "booked")
          .lt("starts_at", windowTo).gt("ends_at", windowFrom),
        admin.from("meeting_busy").select("starts_at, ends_at")
          .eq("host_id", host.id).lt("starts_at", windowTo).gt("ends_at", windowFrom),
      ]);
      if (be2) throw be2;
      if (ee2) throw ee2;
      const { data: hostFull, error: hfe } = await admin.from("meeting_hosts")
        .select("weekly_hours").eq("id", host.id).single();
      if (hfe) throw hfe;

      const rules = {
        timeZone: host.time_zone,
        weeklyHours: hostFull.weekly_hours || {},
        // deno-lint-ignore no-explicit-any
        overrides: ((overrides ?? []) as any[]).map((o) => ({
          onDate: o.on_date, blocked: o.blocked, hours: o.hours || [],
        })),
        type: {
          durationMinutes: type.duration_minutes,
          bufferBeforeMinutes: type.buffer_before_minutes,
          bufferAfterMinutes: type.buffer_after_minutes,
          minNoticeHours: type.min_notice_hours,
          maxDaysAhead: type.max_days_ahead,
          // 1-minute grid: the grid is the PAGE's affordance, and a customer who took a
          // perfectly good 09:05 from a link we sent should not be refused because the
          // tenant later moved to 15-minute steps.
          slotIntervalMinutes: 1,
        },
        // Two days either side: a slot near midnight belongs to a different calendar day in
        // the host's zone than the UTC date of its instant.
        fromDate: new Date(startMs - 86_400_000).toISOString().slice(0, 10),
        toDate: new Date(startMs + 86_400_000).toISOString().slice(0, 10),
        now: new Date(),
      };
      const busyNow = widenBusy(
        // deno-lint-ignore no-explicit-any
        ((booked2 ?? []) as any[]).map((m) => ({
          startsAt: m.starts_at,
          endsAt: m.ends_at,
          bufferBeforeMinutes: m.meeting_types?.buffer_before_minutes ?? 0,
          bufferAfterMinutes: m.meeting_types?.buffer_after_minutes ?? 0,
        })),
        // deno-lint-ignore no-explicit-any
      ).concat(widenBusy(((ext2 ?? []) as any[]).map((b) => ({ startsAt: b.starts_at, endsAt: b.ends_at }))));

      const wanted = new Date(startMs).toISOString();
      const isSlot = (days: ReturnType<typeof availableSlots>) =>
        days.some((d) => d.slots.some((s) => s.startsAt === wanted));

      if (!isSlot(availableSlots({ ...rules, busy: busyNow }))) {
        // ⚠️ TWO DIFFERENT REFUSALS, and the difference is worth a second availability pass.
        // Re-running with an EMPTY diary separates "somebody took it while you were typing"
        // from "that was never a time on offer" (outside the host's hours, or off a
        // hand-made request that skipped the page). Both are refused either way — the check
        // above is the security boundary — but telling a customer a time "isn't open any
        // more" when it never was sends them back to the calendar looking for what changed.
        const neverOffered = !isSlot(availableSlots({ ...rules, busy: [] }));
        return json({
          ok: false,
          error: neverOffered
            ? "That isn't a time they take bookings. Pick one from the calendar and it'll go straight in."
            : "That time was just taken. Pick another and it'll go straight in.",
          code: neverOffered ? "not_bookable" : "slot_taken",
        }, 409);
      }

      // ── The CRM contact ───────────────────────────────────────────────────────────────
      // Before the booking, so the meeting lands already filed against a person. BEST
      // EFFORT: a CRM hiccup must not cost the customer their slot — they did their part,
      // and an unlinked meeting is a far smaller problem than a lost booking. The tenant can
      // switch it off (meeting_settings.create_contact).
      const { data: settings } = await admin.from("meeting_settings")
        .select("create_contact, send_confirmation").eq("client_id", clientId).maybeSingle();
      let contactId: string | null = null;
      if (settings?.create_contact !== false) {
        try {
          const { data: crmId, error: crmErr } = await admin.rpc("crm_ensure_contact", {
            p_client_id: clientId,
            p_name: name,
            p_phone: phone || null,
            p_email: email || null,
          });
          if (crmErr) throw crmErr;
          contactId = typeof crmId === "string" ? crmId : null;
        } catch (e) {
          await logEdgeError({
            fn: "book-public",
            req,
            clientId,
            code: "contact_link",
            message: `book-public could not file the booking against a contact: ${(e as Error)?.message}`,
          });
        }
      }

      const endMs = startMs + type.duration_minutes * 60_000;
      const { data: result, error: bookErr } = await admin.rpc("book_meeting", {
        p_client_id: clientId,
        p_host_id: host.id,
        p_type_id: type.id,
        p_starts_at: new Date(startMs).toISOString(),
        p_ends_at: new Date(endMs).toISOString(),
        // What the CUSTOMER was looking at. Kept because it is what their confirmation will
        // say; falls back to the host's zone when the browser did not tell us.
        p_time_zone: customerTz || host.time_zone,
        p_name: name,
        p_email: email || null,
        p_phone: phone || null,
        p_notes: notes || null,
        p_source: body.embed ? "embed" : "public",
        p_contact_id: contactId,
        p_short_code: null,
        p_created_by: null,
        p_buffer_before_minutes: type.buffer_before_minutes,
        p_buffer_after_minutes: type.buffer_after_minutes,
      });
      if (bookErr) throw bookErr;
      if (!result) {
        return json({
          ok: false,
          error: "That time was just taken. Pick another and it'll go straight in.",
          code: "slot_taken",
        }, 409);
      }

      // Phase 2 sends the confirmation and the .ics from here. Deliberately not stubbed with
      // a silent no-op that looks like it works: the response says plainly whether anything
      // was sent, so the page can tell the customer the truth today ("we have your booking")
      // rather than promising an email that is not written yet.
      return json({
        ok: true,
        id: result.id,
        manageToken: result.cancelToken,
        confirmationSent: false,
        meeting: {
          typeName: type.name,
          startsAt: new Date(startMs).toISOString(),
          endsAt: new Date(endMs).toISOString(),
          timeZone: customerTz || host.time_zone,
          locationKind: type.location_kind,
          locationDetail: type.location_detail,
        },
      });
    }

    // ══ LOOKUP / CANCEL — token-authenticated ═══════════════════════════════════════════
    case "lookup":
    case "cancel": {
      const token = str(body.token, 64).toLowerCase();
      // Same answer for a malformed token, an unknown one and one belonging to another
      // tenant: a refusal must not confirm that a booking exists.
      if (!TOKEN.test(token)) return json({ ok: false, error: "not_found" }, 404);
      const cap = await overCap(admin, `book:token:ip:${ip}`, RATE_BOOK_PER_IP * 4);
      if (cap.over) return json({ ok: false, error: "busy" }, 429);

      const { data: m, error } = await admin.from("meetings")
        .select("id, client_id, starts_at, ends_at, booked_time_zone, status, customer_name, meeting_types!inner(name, location_kind, location_detail), meeting_hosts!inner(public_name, slug)")
        .eq("client_id", clientId).eq("cancel_token", token).maybeSingle();
      if (error) throw error;
      if (!m) return json({ ok: false, error: "not_found" }, 404);

      const shaped = {
        startsAt: m.starts_at,
        endsAt: m.ends_at,
        timeZone: m.booked_time_zone,
        status: m.status,
        customerName: m.customer_name,
        // deno-lint-ignore no-explicit-any
        typeName: (m as any).meeting_types?.name,
        // deno-lint-ignore no-explicit-any
        locationKind: (m as any).meeting_types?.location_kind,
        // deno-lint-ignore no-explicit-any
        locationDetail: (m as any).meeting_types?.location_detail,
        // deno-lint-ignore no-explicit-any
        hostName: (m as any).meeting_hosts?.public_name,
        // deno-lint-ignore no-explicit-any
        hostSlug: (m as any).meeting_hosts?.slug,
      };

      if (action === "lookup") return json({ ok: true, meeting: shaped });

      if (m.status !== "booked") {
        // Idempotent: a customer who clicks Cancel twice, or follows an old link, should see
        // "that's cancelled", not an error.
        return json({ ok: true, meeting: { ...shaped, status: m.status }, alreadyGone: true });
      }
      const { error: ue } = await admin.from("meetings").update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancel_reason: str(body.reason, 500) || "Cancelled by the customer",
        updated_at: new Date().toISOString(),
      }).eq("id", m.id).eq("status", "booked");
      if (ue) throw ue;
      return json({ ok: true, meeting: { ...shaped, status: "cancelled" } });
    }

    default:
      return json({ ok: false, error: `Unknown action "${action}".` }, 400);
  }
}));
