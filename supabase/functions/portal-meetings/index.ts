import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import { ownMeetingsOnly, type GateTable } from "../_shared/access.ts";
import { hasPaidFeature } from "../_shared/featureCheck.ts";
import { availableSlots, widenBusy, parseDay } from "../_shared/meetingAvailability.ts";
import { sendMeetingEmail, claimConfirmation, bumpIcsSequence } from "../_shared/meetingSend.ts";
import { denoVideoEnv, dropConference, ensureConference, videoReadiness } from "../_shared/meetingVideo.ts";
import { zoomAuthorizeUrl, zoomCredsFromEnv, zoomRevoke } from "../_shared/zoomApi.ts";
import {
  MEETINGS_OAUTH_HOSTS, OAUTH_STATE_TTL_MS, meetingsOauthRedirectUri, newOauthState,
} from "../_shared/meetingOauth.ts";

// MEETINGS — the tenant half. Migration 325, phase 1 of MEETINGS_SCOPE.md.
//
// Carolyn, 2026-10-22: a Calendly-style way to set meetings with customers. This function
// owns every portal-side read and write; `book-public` owns the public page. They share two
// things and nothing else: the availability engine (_shared/meetingAvailability.ts) and the
// `book_meeting()` SQL function.
//
// ⚠️ BOOKING IS THE ONLY WAY A MEETING IS CREATED. Carolyn had the "meeting" and "lunch"
// chips removed from the Activity composer on 2026-08-26 — "I don't want meeting in there, we
// have a meeting scheduler" — and the comment left at 02-sales.jsx:5609 states the rule:
// "two ways to book the same thing is how a calendar drifts out of sync with itself". So the
// `book` action here goes through the SAME SQL function the public page calls, buffers,
// advisory lock and all. Do not add a fast path that inserts into `meetings` directly.
//
// Auth: resolveTenant — JWT → caller → client_users; clientId is NEVER read from the body.
// This function belongs in portal.html's SS_TENANT_SCOPED_FNS so an operator in view-as
// reaches a builder's meetings through the standard targetClientId injection.
//
// ── GATING, AND THE ONE TRAP ─────────────────────────────────────────────────────────────
// The GATES table below is the gate (migration 100). The `meetings` area has four levels and
// 'own' WRITES (ownWrites in access.ts — your own hours are yours to set), so canEdit() is
// true for an 'own' holder. **That alone is a blanket edit on every person's calendar in the
// business.** Two things narrow it, and both are needed:
//
//   * TENANT_WIDE — the actions that configure the business rather than a person (meeting
//     types, the booking page's settings). An own-only caller is refused outright.
//   * HOST_SCOPE — every other write declares how to find the host row it touches, and an
//     own-only caller naming a host that is not theirs gets a 404: the same status an
//     invisible design returns, so a refusal never confirms the row exists.
//
// This is the `contacts:'own'` / CONTACT_ROW_SCOPE shape, for the same reason it exists
// there: the failure is silent. The action does not 403, it RUNS, against the whole team.
//
// ── THE ENTITLEMENT IS SEPARATE FROM THE PERMISSION ──────────────────────────────────────
// Booking is part of the CRM (Carolyn 2026-10-22: no plan of its own, no billing_plans row,
// no second launch switch). So every action here also needs the `crm` feature, checked ONCE
// below. It is NOT in access.ts: an area says what a person may do, never what the account
// has bought, and the refusal has to say which of the two it was or an owner — who holds
// every permission there is — goes off to Team looking for a switch that is not there.
//
// It FAILS CLOSED, unlike the base billing gate. `crm` is in portal-billing's
// PAID_ONLY_FEATURES, so there is no transition blanket to fall back on, and a feature that
// quietly works during an outage is a feature nobody ever buys.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, ...extra, "Content-Type": "application/json" },
  });
}
/** A refusal that must answer 5xx marks itself, so withErrorLog keeps it at `error`
 *  severity instead of demoting it with the ordinary 4xx refusals (migration 141). */
function refusal(body: unknown, status: number) {
  return json(body, status, { "x-ss-refusal": "1" });
}

// ⚠️ A GATE'S `level` IS A MINIMUM AND ONLY SPEAKS 'view' OR 'edit' (GateNeed in access.ts).
// It cannot say "own", and that is not an omission to work around — RANK scores 'own' and
// 'view' the same, so an 'own' holder satisfies a 'view' gate, and because `meetings` is
// ownWrites they satisfy an 'edit' gate too. **So this table does NOT separate "my calendar"
// from "the team's" and cannot be made to.** TENANT_WIDE and HOST_SCOPE below are what
// actually narrow an own-only caller; the levels here only separate reads from writes, which
// is what gateIsRead() uses for the read-only-operator capability check.
// ── "TEAM" BOOKING (Carolyn 2026-10-23) ─────────────────────────────────────────────────
// "I want them to be able to see the entire team and schedule with anyone." So the middle
// level, 'view', BOOKS: a caller on the phone with a lead puts the call on whoever's calendar
// it belongs on, and can cancel, mark or resend it. What stays with 'edit' is the SETUP —
// the business's meeting types and booking page (TENANT_WIDE), and other people's hours,
// days off, offerings and video accounts (PERSONAL_SETUP below).
//
// ⚠️ WHY `any: [edit, view]` AND NOT PLAIN `view`. The gate's level does two jobs: who may
// (checkGate — 'view' is satisfied by own/view/edit) and whether the action is a WRITE
// (gateIsRead, used to stop a READ-ONLY OPERATOR). A plain 'view' gate would turn booking into
// a "read" and let a read-only operator book meetings in a builder's name. Listing 'edit' as
// well keeps it a write while 'view' still satisfies it.
const TEAM_WRITE = { any: [{ area: "meetings", level: "edit" as const }, { area: "meetings", level: "view" as const }] };

const GATES: GateTable = {
  // ── Reads ────────────────────────────────────────────────────────────────────────────
  // The whole Settings → Meetings payload: the tenant's types, this person's host row and
  // hours, the team's host list, and connection status. The handler strips the team list for
  // an own-only caller.
  overview:        { area: "meetings", level: "view" },
  // The meetings list. Narrowed to the caller's own host for an own-only reader.
  list:            { area: "meetings", level: "view" },
  // Open slots for a host + type. Feeds the CRM tab's "next times open".
  availability:    { area: "meetings", level: "view" },
  // One contact's meetings, for the Meeting scheduler tab. ALSO needs contacts:view —
  // declared `all` so holding one area is not enough.
  contact_meetings: { all: [{ area: "meetings", level: "view" }, { area: "contacts", level: "view" }] },

  // ── Writes about a PERSON (narrowed by HOST_SCOPE) ───────────────────────────────────
  save_host:       TEAM_WRITE,
  save_override:   TEAM_WRITE,
  delete_override: TEAM_WRITE,
  set_host_types:  TEAM_WRITE,
  // Booking writes a CRM contact as well as a meeting, so it needs both areas.
  // contacts:'edit' keeps this a write on its own; meetings only needs 'view' (Team).
  book:            { all: [{ area: "meetings", level: "view" }, { area: "contacts", level: "edit" }] },
  cancel:          TEAM_WRITE,
  set_status:      TEAM_WRITE,
  // "They never got the email." Sends the confirmation again, to the address on the booking
  // and nowhere else - deliberately NOT to an address from the request body, which would be
  // a way to have the platform mail a stranger on a builder's behalf.
  resend:          TEAM_WRITE,
  // VIDEO (migration 333). "Make the link" — retry creating the provider meeting for a booking
  // whose link could not be made, then re-send the confirmation with it.
  make_link:       TEAM_WRITE,
  // Start connecting MY Zoom account (returns the provider's authorize URL). Self only: the
  // handler refuses a host that is not the caller's own, whatever their level, because a
  // meeting created in somebody's account must be that person's own decision.
  video_connect:   TEAM_WRITE,
  // Disconnect a video account. Your own, or — for someone who manages the whole team — a
  // colleague's, e.g. after they leave.
  video_disconnect: TEAM_WRITE,

  // ── Writes about the BUSINESS (narrowed by TENANT_WIDE) ──────────────────────────────
  save_settings:   { area: "meetings", level: "edit" },
  save_type:       { area: "meetings", level: "edit" },
  delete_type:     { area: "meetings", level: "edit" },
};

/**
 * Actions that configure the BUSINESS, not a person. An own-only caller is refused outright.
 *
 * This set — not the gate — is the real control, for the reason in the comment above GATES:
 * `meetings` is ownWrites, so a sales rep with 'own' passes every `level: "edit"` gate in
 * that table. Without this, a rep could rewrite the tenant's meeting types and switch the
 * whole booking page off.
 */
const TENANT_WIDE = new Set(["save_settings", "save_type", "delete_type"]);

/**
 * A person's own SETUP: their host row and hours, days off, which types they offer, their
 * video account. Anyone below 'edit' (own AND view) may change only their OWN; 'edit' may
 * change anyone's. Booking on someone's calendar is not setup — 'view' does that for anyone.
 */
const PERSONAL_SETUP = new Set([
  "save_host", "save_override", "delete_override", "set_host_types", "video_connect", "video_disconnect",
]);

/**
 * How to find the host row each person-scoped write touches. An own-only caller naming
 * anything else gets a 404.
 *
 * ⚠️ A NEW person-scoped write is a TWO-PLACE change: GATES and here. Miss this table and
 * the action does not 403 — it runs, against any host id the browser cares to name, which is
 * every calendar in the business. `set_status` is the shape to remember: it takes a meeting
 * id and never mentions a host, so it reads like it needs no check and needs one most.
 */
const HOST_SCOPE: Record<string, { hostKey?: string; meetingKey?: string; overrideKey?: string }> = {
  save_host:       { hostKey: "hostId" },
  save_override:   { hostKey: "hostId" },
  delete_override: { overrideKey: "id" },
  set_host_types:  { hostKey: "hostId" },
  book:            { hostKey: "hostId" },
  cancel:          { meetingKey: "id" },
  set_status:      { meetingKey: "id" },
  resend:          { meetingKey: "id" },
  make_link:       { meetingKey: "id" },
  video_connect:   { hostKey: "hostId" },
  video_disconnect: { hostKey: "hostId" },
};

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Validate a weekly_hours blob before it is stored. Shape is
 * `{"mon":[["08:00","17:00"]], …}` — the same one phone_user_settings.ring_hours uses.
 *
 * Rebuilt from a whitelist rather than filtered, because this column is read by the public
 * availability path: an unknown key surviving here would be a value a stranger's page
 * iterates. Returns the clean object, or throws a sentence a person can act on.
 */
// deno-lint-ignore no-explicit-any
function cleanWeeklyHours(raw: any): Record<string, [string, string][]> {
  const out: Record<string, [string, string][]> = {};
  if (raw === null || raw === undefined) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Your hours could not be read.");
  for (const key of DAY_KEYS) {
    const blocks = raw[key];
    if (blocks === undefined || blocks === null) continue;
    if (!Array.isArray(blocks)) throw new Error(`The hours for ${key} could not be read.`);
    if (blocks.length > 6) throw new Error(`That is more than six blocks of time on one day.`);
    const kept: [string, string][] = [];
    for (const b of blocks) {
      if (!Array.isArray(b) || b.length !== 2) throw new Error(`A block of time on ${key} is not a start and an end.`);
      const from = String(b[0] ?? "").trim();
      const to = String(b[1] ?? "").trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(to)) {
        throw new Error(`A time on ${key} is not a 24-hour HH:MM.`);
      }
      if (to <= from) throw new Error(`On ${key}, ${to} is not after ${from}.`);
      kept.push([from, to]);
    }
    if (kept.length) out[key] = kept;
  }
  return out;
}

/** Is this a time zone this runtime actually knows? A stored zone nobody can resolve makes
 *  every availability call for that person return nothing, with no error anywhere. */
function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function slugify(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

Deno.serve(withErrorLog("portal-meetings", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Warm-up: before any client, auth or tenant resolution, and a query param rather than an
  // action so it needs no GATES entry. Same shape as portal-schedule's and portal-setup's.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const r = await resolveTenant(req, admin, { gates: GATES, readActions: new Set(), defaultAction: "overview" });
  if (!r.ok) return json(r.body, r.status);
  const { clientId, payload, action, userId, selfUserId, access, operator } = r.ctx;
  // deno-lint-ignore no-explicit-any
  const p: any = payload || {};

  // ── The CRM entitlement, once, for every action ────────────────────────────────────────
  // Fails closed: `crm` is pay-only (no transition blanket), so an unreadable entitlement
  // must not hand the feature out. Worded to match the greyed tab's CRM_LOCKED_HINT so the
  // hint and any refusal that reaches the browser tell one story.
  let crmOn = false;
  try {
    crmOn = await hasPaidFeature(admin, clientId, "crm");
  } catch (e) {
    console.error("portal-meetings: entitlement read failed:", (e as Error)?.message);
    return refusal({ error: "We could not check your subscription just now. Please try again." }, 503);
  }
  if (!crmOn) {
    return refusal({
      error: "The built-in CRM isn't part of your subscription — add it under Settings → Billing.",
      code: "crm_locked",
    }, 403);
  }

  const ownOnly = ownMeetingsOnly(access);
  // Below 'edit', a person's setup is their own (see PERSONAL_SETUP). Operators carry the
  // owner's map, so they are 'edit' here.
  const ownSetupOnly = access.meetings !== "edit";

  if (TENANT_WIDE.has(action) && ownOnly) {
    return json({ error: "Only someone who manages meetings for the whole business can change this." }, 403);
  }

  // ── My own host row, if I have one ─────────────────────────────────────────────────────
  // An operator in view-as has no client_users row on this tenant and therefore no host row.
  // That is correct and not a bug to paper over: a CSM Synergy operator does not have a
  // booking page on a builder's account. It does mean every own-scoped branch has to cope
  // with myHost being null, and operators are never own-only anyway (their access comes from
  // app_operators and resolves to the owner's map).
  // ⛔ selfUserId, NOT userId. This is "whose calendar is this screen about", and keying it
  // on the signed-in human meant that an operator acting as a sales rep opened Settings →
  // Meetings and saw THEIR OWN calendar presented as the rep's. Carolyn, 2026-10-23: "I logged
  // in as brent and went to meetings and I see the meetings for Carolyn."
  const { data: myHostRow, error: myHostErr } = await admin
    .from("meeting_hosts").select("*").eq("client_id", clientId).eq("user_id", selfUserId).maybeSingle();
  if (myHostErr) throw myHostErr;
  const myHost = myHostRow || null;

  // ── HOST_SCOPE ─────────────────────────────────────────────────────────────────────────
  // Resolve which host row this action touches, and refuse an own-only caller who named
  // somebody else's. Denies by default: naming no host at all, on an action that needs one,
  // is refused rather than falling through to "mine".
  let scopedHostId: string | null = null;
  const scope = HOST_SCOPE[action];
  if (scope) {
    if (scope.hostKey) {
      const named = typeof p[scope.hostKey] === "string" ? p[scope.hostKey] : null;
      // An own-only caller may omit the host and mean themselves — that is the common case
      // from Settings → Meetings, where there is only ever one calendar on screen.
      scopedHostId = named || ((ownOnly || (ownSetupOnly && PERSONAL_SETUP.has(action))) ? (myHost?.id ?? null) : null);
      if (!scopedHostId) return json({ error: "Which person's calendar did you mean?" }, 400);
    } else if (scope.meetingKey) {
      const id = typeof p[scope.meetingKey] === "string" ? p[scope.meetingKey] : null;
      if (!id) return json({ error: "Which meeting did you mean?" }, 400);
      const { data: m, error } = await admin
        .from("meetings").select("host_id").eq("client_id", clientId).eq("id", id).maybeSingle();
      if (error) throw error;
      if (!m) return json({ error: "That meeting is not on this account." }, 404);
      scopedHostId = m.host_id;
    } else if (scope.overrideKey) {
      const id = typeof p[scope.overrideKey] === "string" ? p[scope.overrideKey] : null;
      if (!id) return json({ error: "Which day did you mean?" }, 400);
      const { data: o, error } = await admin
        .from("meeting_overrides").select("host_id").eq("client_id", clientId).eq("id", id).maybeSingle();
      if (error) throw error;
      if (!o) return json({ error: "That day is not on this account." }, 404);
      scopedHostId = o.host_id;
    }

    const narrowed = ownOnly || (ownSetupOnly && PERSONAL_SETUP.has(action));
    if (narrowed && scopedHostId && scopedHostId !== (myHost?.id ?? null)) {
      // 404, not 403: a refusal must not confirm whose calendar that id belongs to.
      return json({ error: "That calendar is not yours." }, 404);
    }
  }

  // ── Shared loader: everything the availability engine needs for one host + type ────────
  async function loadRules(hostId: string, typeId: string) {
    const [{ data: host, error: he }, { data: type, error: te }] = await Promise.all([
      admin.from("meeting_hosts").select("*").eq("client_id", clientId).eq("id", hostId).maybeSingle(),
      admin.from("meeting_types").select("*").eq("client_id", clientId).eq("id", typeId).maybeSingle(),
    ]);
    if (he) throw he;
    if (te) throw te;
    if (!host || !type) return null;
    return { host, type };
  }

  /**
   * Busy windows for one host over a window, widened by each existing meeting's OWN type
   * buffers, plus the cached external calendar blocks.
   *
   * ⚠️ The widening must match book_meeting()'s overlap test (migration 326). This decides
   * what is OFFERED; that decides what is ACCEPTED. If this is the more generous of the two,
   * a customer is shown times the database then refuses, which reads as a broken page.
   */
  async function loadBusy(host: { id: string; user_id: string }, fromIso: string, toIso: string) {
    const [{ data: booked, error: be }, { data: ext, error: ee }] = await Promise.all([
      admin.from("meetings")
        .select("starts_at, ends_at, meeting_types!inner(buffer_before_minutes, buffer_after_minutes)")
        .eq("host_user_id", host.user_id).eq("status", "booked")
        .lt("starts_at", toIso).gt("ends_at", fromIso),
      admin.from("meeting_busy")
        .select("starts_at, ends_at")
        .eq("host_id", host.id).lt("starts_at", toIso).gt("ends_at", fromIso),
    ]);
    if (be) throw be;
    if (ee) throw ee;
    // deno-lint-ignore no-explicit-any
    const fromBookings = ((booked ?? []) as any[]).map((m) => ({
      startsAt: m.starts_at,
      endsAt: m.ends_at,
      bufferBeforeMinutes: m.meeting_types?.buffer_before_minutes ?? 0,
      bufferAfterMinutes: m.meeting_types?.buffer_after_minutes ?? 0,
    }));
    // deno-lint-ignore no-explicit-any
    const fromExternal = ((ext ?? []) as any[]).map((b) => ({ startsAt: b.starts_at, endsAt: b.ends_at }));
    return widenBusy(fromBookings).concat(widenBusy(fromExternal));
  }

  switch (action) {
    // ══ READS ═══════════════════════════════════════════════════════════════════════════
    case "overview": {
      const [
        { data: settings, error: se },
        { data: types, error: tye },
        { data: hosts, error: hse },
      ] = await Promise.all([
        admin.from("meeting_settings").select("*").eq("client_id", clientId).maybeSingle(),
        admin.from("meeting_types").select("*").eq("client_id", clientId).order("name"),
        admin.from("meeting_hosts").select("*").eq("client_id", clientId).eq("active", true).order("public_name"),
      ]);
      if (se) throw se;
      if (tye) throw tye;
      if (hse) throw hse;

      const hostIds = (hosts ?? []).map((h: { id: string }) => h.id);
      const [{ data: offers, error: oe }, { data: conns, error: ce }, { data: ovr, error: ove }] = await Promise.all([
        hostIds.length
          ? admin.from("meeting_host_types").select("host_id, type_id").in("host_id", hostIds)
          : Promise.resolve({ data: [], error: null }),
        // ⛔ meeting_connections holds refresh tokens. NEVER select * here, and never let a
        // token column reach a browser — status and the calendar's name are the whole of
        // what the Settings screen needs to render "Connected / Reconnect".
        myHost
          ? admin.from("meeting_connections")
              .select("provider, status, calendar_id, last_synced_at, account_email, account_name, last_error").eq("host_id", myHost.id)
          : Promise.resolve({ data: [], error: null }),
        myHost
          ? admin.from("meeting_overrides").select("*").eq("host_id", myHost.id)
              .gte("on_date", new Date().toISOString().slice(0, 10)).order("on_date")
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (oe) throw oe;
      if (ce) throw ce;
      if (ove) throw ove;

      // VIDEO (333): which team members have a working Zoom connection, so the type editor can
      // say who a "new link per booking" type would fall back for. Status only — the same
      // no-token-columns rule as above. Not for an own-only caller, who sees nobody else.
      const videoByHost = new Map<string, string>();
      if (!ownOnly && hostIds.length) {
        const { data: tv, error: tve } = await admin.from("meeting_connections")
          .select("host_id, provider, status").in("host_id", hostIds).eq("provider", "zoom");
        if (tve) throw tve;
        // deno-lint-ignore no-explicit-any
        for (const row of (tv ?? []) as any[]) videoByHost.set(row.host_id, row.status);
      }

      // deno-lint-ignore no-explicit-any
      const byHost = new Map<string, string[]>();
      // deno-lint-ignore no-explicit-any
      for (const row of (offers ?? []) as any[]) {
        const list = byHost.get(row.host_id) ?? [];
        list.push(row.type_id);
        byHost.set(row.host_id, list);
      }

      // deno-lint-ignore no-explicit-any
      const shapeHost = (h: any) => ({
        id: h.id,
        userId: h.user_id,
        slug: h.slug,
        publicName: h.public_name,
        publicTitle: h.public_title,
        photoUrl: h.photo_url,
        timeZone: h.time_zone,
        weeklyHours: h.weekly_hours || {},
        accepting: h.accepting,
        typeIds: byHost.get(h.id) ?? [],
        zoom: videoByHost.get(h.id) ?? null,
      });

      return json({
        ok: true,
        settings: settings
          ? {
              enabled: settings.enabled,
              heading: settings.heading,
              intro: settings.intro,
              sendConfirmation: settings.send_confirmation,
              reminderHours: settings.reminder_hours,
              createContact: settings.create_contact,
            }
          : null,
        // deno-lint-ignore no-explicit-any
        types: (types ?? []).map((t: any) => ({
          id: t.id, name: t.name, slug: t.slug, description: t.description,
          durationMinutes: t.duration_minutes, locationKind: t.location_kind,
          locationDetail: t.location_detail,
          bufferBeforeMinutes: t.buffer_before_minutes, bufferAfterMinutes: t.buffer_after_minutes,
          minNoticeHours: t.min_notice_hours, maxDaysAhead: t.max_days_ahead,
          slotIntervalMinutes: t.slot_interval_minutes, color: t.color, active: t.active,
          conferenceProvider: t.conference_provider, conferenceUrl: t.conference_url,
          conferenceNote: t.conference_note, conferenceMode: t.conference_mode,
        })),
        myHost: myHost ? shapeHost(myHost) : null,
        // An own-only caller gets their own row and nobody else's — the whole point of the
        // level. Everyone else gets the team, which is what Settings → Meetings needs to
        // show an owner who on their team is bookable.
        // deno-lint-ignore no-explicit-any
        team: ownOnly ? [] : (hosts ?? []).map(shapeHost),
        // deno-lint-ignore no-explicit-any
        connections: (conns ?? []).map((c: any) => ({
          provider: c.provider, status: c.status, calendarId: c.calendar_id, lastSyncedAt: c.last_synced_at,
          accountEmail: c.account_email, accountName: c.account_name, lastError: c.last_error,
        })),
        // Which providers can make a fresh link per booking right now (secrets present).
        videoReady: videoReadiness((k) => Deno.env.get(k)),
        // deno-lint-ignore no-explicit-any
        overrides: (ovr ?? []).map((o: any) => ({
          id: o.id, onDate: o.on_date, blocked: o.blocked, hours: o.hours, note: o.note,
        })),
        // Meeting types and the booking page: 'edit' only. 'view' (Team) sees and books the
        // whole team, but does not change the setup — TENANT_WIDE's gates refuse it anyway.
        canManageBusiness: access.meetings === "edit",
        viewing: !!operator,
      });
    }

    case "list": {
      const fromIso = typeof p.from === "string" ? p.from : new Date().toISOString();
      const toIso = typeof p.to === "string"
        ? p.to
        : new Date(Date.now() + 60 * 86_400_000).toISOString();
      let q = admin.from("meetings")
        .select("id, host_id, host_user_id, type_id, contact_id, short_code, starts_at, ends_at, booked_time_zone, status, customer_name, customer_email, customer_phone, customer_notes, source, conference_provider, conference_url, conference_status, conference_error, meeting_types!inner(name, duration_minutes, location_kind, location_detail, color), meeting_hosts!inner(public_name)")
        .eq("client_id", clientId)
        .gte("starts_at", fromIso).lte("starts_at", toIso)
        .order("starts_at");
      if (ownOnly) {
        // No host row yet = no meetings of your own. Returning the tenant's would be the
        // bug this level exists to prevent, so answer empty rather than widening.
        if (!myHost) return json({ ok: true, meetings: [] });
        q = q.eq("host_id", myHost.id);
      } else if (typeof p.hostId === "string") {
        q = q.eq("host_id", p.hostId);
      }
      const { data, error } = await q.limit(500);
      if (error) throw error;
      // deno-lint-ignore no-explicit-any
      return json({ ok: true, meetings: (data ?? []).map((m: any) => ({
        id: m.id, hostId: m.host_id, hostName: m.meeting_hosts?.public_name,
        typeId: m.type_id, typeName: m.meeting_types?.name,
        locationKind: m.meeting_types?.location_kind, locationDetail: m.meeting_types?.location_detail,
        color: m.meeting_types?.color,
        contactId: m.contact_id, shortCode: m.short_code,
        startsAt: m.starts_at, endsAt: m.ends_at, timeZone: m.booked_time_zone,
        status: m.status, customerName: m.customer_name, customerEmail: m.customer_email,
        customerPhone: m.customer_phone, customerNotes: m.customer_notes, source: m.source,
        conferenceProvider: m.conference_provider, conferenceUrl: m.conference_url,
        conferenceStatus: m.conference_status, conferenceError: m.conference_error,
      })) });
    }

    case "availability": {
      const hostId = typeof p.hostId === "string" ? p.hostId : (myHost?.id ?? null);
      const typeId = typeof p.typeId === "string" ? p.typeId : null;
      if (!hostId || !typeId) return json({ error: "Pick a person and a meeting type first." }, 400);
      if (ownOnly && hostId !== (myHost?.id ?? null)) return json({ error: "That calendar is not yours." }, 404);

      const loaded = await loadRules(hostId, typeId);
      if (!loaded) return json({ error: "That person or meeting type is not on this account." }, 404);
      const { host, type } = loaded;

      const today = new Date().toISOString().slice(0, 10);
      const fromDate = typeof p.fromDate === "string" && parseDay(p.fromDate) ? p.fromDate : today;
      const toDate = typeof p.toDate === "string" && parseDay(p.toDate)
        ? p.toDate
        : new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

      const { data: overrides, error: ovErr } = await admin
        .from("meeting_overrides").select("on_date, blocked, hours").eq("host_id", hostId);
      if (ovErr) throw ovErr;

      // The busy window has to be a little wider than the asked-for days, or a meeting that
      // started the evening before the range still has to block its morning.
      const fromIso = new Date(Date.parse(fromDate + "T00:00:00Z") - 2 * 86_400_000).toISOString();
      const toIso = new Date(Date.parse(toDate + "T00:00:00Z") + 2 * 86_400_000).toISOString();
      const busy = await loadBusy(host, fromIso, toIso);

      const days = availableSlots({
        timeZone: host.time_zone,
        weeklyHours: host.weekly_hours || {},
        // deno-lint-ignore no-explicit-any
        overrides: (overrides ?? []).map((o: any) => ({ onDate: o.on_date, blocked: o.blocked, hours: o.hours || [] })),
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
      return json({ ok: true, timeZone: host.time_zone, accepting: host.accepting, days });
    }

    case "contact_meetings": {
      const contactId = typeof p.contactId === "string" ? p.contactId : null;
      if (!contactId) return json({ error: "Which contact did you mean?" }, 400);
      let q = admin.from("meetings")
        .select("id, host_id, starts_at, ends_at, status, booked_time_zone, customer_notes, conference_provider, conference_url, conference_status, conference_error, meeting_types!inner(name, location_kind, location_detail), meeting_hosts!inner(public_name)")
        .eq("client_id", clientId).eq("contact_id", contactId)
        .order("starts_at", { ascending: false }).limit(50);
      if (ownOnly) {
        if (!myHost) return json({ ok: true, meetings: [] });
        q = q.eq("host_id", myHost.id);
      }
      const { data, error } = await q;
      if (error) throw error;
      // deno-lint-ignore no-explicit-any
      return json({ ok: true, meetings: (data ?? []).map((m: any) => ({
        id: m.id, startsAt: m.starts_at, endsAt: m.ends_at, status: m.status,
        timeZone: m.booked_time_zone, typeName: m.meeting_types?.name,
        locationKind: m.meeting_types?.location_kind, locationDetail: m.meeting_types?.location_detail,
        hostName: m.meeting_hosts?.public_name, notes: m.customer_notes,
        conferenceProvider: m.conference_provider, conferenceUrl: m.conference_url,
        conferenceStatus: m.conference_status, conferenceError: m.conference_error,
      })) });
    }

    // ══ WRITES — the business ═══════════════════════════════════════════════════════════
    case "save_settings": {
      const row: Record<string, unknown> = { client_id: clientId, updated_at: new Date().toISOString() };
      if (typeof p.enabled === "boolean") row.enabled = p.enabled;
      if (p.heading !== undefined) row.heading = p.heading ? String(p.heading).slice(0, 120) : null;
      if (p.intro !== undefined) row.intro = p.intro ? String(p.intro).slice(0, 1000) : null;
      if (typeof p.sendConfirmation === "boolean") row.send_confirmation = p.sendConfirmation;
      if (typeof p.createContact === "boolean") row.create_contact = p.createContact;
      if (Array.isArray(p.reminderHours)) {
        const asNumbers: number[] = p.reminderHours.map((h: unknown) => Math.trunc(Number(h)));
        row.reminder_hours = [...new Set(asNumbers)]
          .filter((h) => Number.isFinite(h) && h > 0 && h <= 336)
          .sort((a, b) => a - b)
          .slice(0, 4);
      }
      const { data, error } = await admin.from("meeting_settings")
        .upsert(row, { onConflict: "client_id" }).select().single();
      if (error) throw error;
      await r.ctx.audit("meetings_save_settings", 1, data.enabled ? "on" : "off");
      return json({ ok: true, settings: {
        enabled: data.enabled, heading: data.heading, intro: data.intro,
        sendConfirmation: data.send_confirmation, reminderHours: data.reminder_hours,
        createContact: data.create_contact,
      } });
    }

    case "save_type": {
      const name = String(p.name ?? "").trim();
      if (!name) return json({ error: "A meeting type needs a name." }, 400);
      const duration = Math.trunc(Number(p.durationMinutes));
      if (!Number.isFinite(duration) || duration < 5 || duration > 480) {
        return json({ error: "A meeting has to be between 5 minutes and 8 hours long." }, 400);
      }
      const kind = String(p.locationKind ?? "in_person");
      if (!["in_person", "phone", "video", "custom"].includes(kind)) {
        return json({ error: "That is not a kind of meeting we know." }, 400);
      }
      // ── VIDEO (migrations 328/329) ────────────────────────────────────────────────────
      // ⚠️ https ONLY, checked here as well as at the column. This value is copied onto every
      // booking of the type and ends up in an href in a customer's mail client and in the
      // LOCATION of a calendar invite, so `javascript:` or a bare host must never reach it.
      // The column refuses it too (328) — belt and braces, because a constraint violation
      // reaches the browser as a database error while this reaches it as a sentence.
      const confProvider = ["none", "zoom", "google_meet", "teams", "other"]
        .includes(String(p.conferenceProvider ?? "none"))
        ? String(p.conferenceProvider ?? "none")
        : "none";
      let confUrl: string | null = null;
      if (p.conferenceUrl !== undefined && p.conferenceUrl !== null && String(p.conferenceUrl).trim() !== "") {
        const raw = String(p.conferenceUrl).trim().slice(0, 500);
        // ⛔ startsWith, NOT a regex, and do not "tidy" it back into one ending `\/\/`.
        // scripts/preflight.mjs' walkBlock scans for `//` BEFORE it skips strings, so a regex
        // literal whose source ends in an escaped slash followed by the closing delimiter
        // reads as the start of a line comment. It then swallows the rest of the line — the
        // opening brace of this `if` included — the brace depth goes out by one, and the
        // GATES cross-check loses every case label after this point: nine actions reported as
        // "listed but no branch handles it" when all nine were right there.
        if (!raw.toLowerCase().startsWith("https://")) {
          return json({ error: "A meeting link has to be an https address." }, 400);
        }
        confUrl = raw;
      }
      // ── How the link is made (333) ───────────────────────────────────────────────────
      // 'generate' = a fresh meeting in the host's own connected account per booking. Only
      // Zoom can do that today (Carolyn 2026-10-23: Zoom first); Meet and Teams arrive with the
      // Google / Microsoft calendar connections. The column refuses 'generate' without a
      // provider that can generate (333's CHECK); this says it as a sentence.
      const confMode = kind === "video" && String(p.conferenceMode ?? "room") === "generate" ? "generate" : "room";
      if (confMode === "generate" && confProvider !== "zoom") {
        return json({
          error: "A new link for every booking works with Zoom for now. Pick Zoom, or paste your room link instead.",
          code: "generate_needs_zoom",
        }, 400);
      }
      // In 'generate' mode the room link is OPTIONAL — it is the fallback used when a link
      // cannot be made (host not connected, Zoom down). In 'room' mode it is the whole point.
      // A provider with no link and nothing to generate it is a video meeting with no way in.
      if (confMode === "room" && confProvider !== "none" && !confUrl) {
        return json({
          error: "Paste your meeting room link, or set the provider back to “I’ll send a link myself”.",
          code: "conference_url_required",
        }, 400);
      }

      const num = (v: unknown, dflt: number, lo: number, hi: number) => {
        const n = Math.trunc(Number(v));
        if (!Number.isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
      };
      const row: Record<string, unknown> = {
        client_id: clientId,
        name: name.slice(0, 80),
        slug: slugify(p.slug || name) || "meeting",
        description: p.description ? String(p.description).slice(0, 2000) : null,
        duration_minutes: duration,
        location_kind: kind,
        location_detail: p.locationDetail ? String(p.locationDetail).slice(0, 300) : null,
        buffer_before_minutes: num(p.bufferBeforeMinutes, 0, 0, 240),
        buffer_after_minutes: num(p.bufferAfterMinutes, 0, 0, 240),
        min_notice_hours: num(p.minNoticeHours, 2, 0, 720),
        max_days_ahead: num(p.maxDaysAhead, 60, 1, 365),
        slot_interval_minutes: num(p.slotIntervalMinutes, 15, 5, 120),
        color: /^#[0-9A-Fa-f]{6}$/.test(String(p.color ?? "")) ? String(p.color) : null,
        conference_provider: confProvider,
        conference_url: confUrl,
        conference_note: p.conferenceNote ? String(p.conferenceNote).slice(0, 300) : null,
        conference_mode: confMode,
        active: p.active === undefined ? true : !!p.active,
        updated_at: new Date().toISOString(),
      };
      let res;
      if (typeof p.id === "string" && p.id) {
        res = await admin.from("meeting_types").update(row)
          .eq("client_id", clientId).eq("id", p.id).select().maybeSingle();
      } else {
        res = await admin.from("meeting_types").insert(row).select().maybeSingle();
      }
      if (res.error) {
        // The slug is unique per tenant, and two types called "Site visit" is a thing a
        // person will genuinely try. Say which it was rather than showing Postgres's text.
        if (String(res.error.code) === "23505") {
          return json({ error: "You already have a meeting type with that name." }, 409);
        }
        throw res.error;
      }
      if (!res.data) return json({ error: "That meeting type is not on this account." }, 404);
      await r.ctx.audit("meetings_save_type", 1, res.data.name);
      return json({ ok: true, id: res.data.id });
    }

    case "delete_type": {
      const id = typeof p.id === "string" ? p.id : null;
      if (!id) return json({ error: "Which meeting type did you mean?" }, 400);
      // meetings.type_id is ON DELETE RESTRICT, so a type with history cannot be deleted —
      // deactivate it instead. Checking first lets us say that, rather than surfacing a
      // foreign-key violation to somebody who only wanted to tidy a list.
      const { count, error: ce } = await admin.from("meetings")
        .select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("type_id", id);
      if (ce) throw ce;
      if ((count ?? 0) > 0) {
        return json({
          error: "That type has meetings booked against it, so it can't be deleted. Switch it off instead and it stops being offered.",
          code: "in_use",
        }, 409);
      }
      const { error } = await admin.from("meeting_types").delete().eq("client_id", clientId).eq("id", id);
      if (error) throw error;
      await r.ctx.audit("meetings_delete_type", 1, id);
      return json({ ok: true });
    }

    // ══ WRITES — a person ═══════════════════════════════════════════════════════════════
    case "save_host": {
      // Creating a host for SOMEBODY ELSE needs the business-wide level; creating your own
      // needs nothing more than the area. An own-only caller with no row yet is making
      // their own, which is how a rep gets a booking link without asking an owner.
      // Whose calendar is being saved: the one named, else the person this screen is about.
      const forUserId = typeof p.userId === "string" && p.userId ? p.userId : selfUserId;
      if (ownSetupOnly && forUserId !== selfUserId) return json({ error: "That calendar is not yours." }, 404);
      // ⚠️ A SELF-SCOPED WRITE WHILE WEARING SOMEBODY IS REFUSED. Reading as them is the
      // feature; quietly rewriting their own hours and booking link under their name is not,
      // and the audit would read as the operator having done it to themselves. Say so plainly
      // rather than saving it somewhere surprising.
      if (operator && operator.asUserId && forUserId === operator.asUserId) {
        return json({
          error: "You're seeing this account as someone else, so their own calendar is read-only here. Exit to your own view to change it.",
          code: "acting_as_read_only",
        }, 409);
      }

      // The person must be on this tenant's team. Without this check a host row could be
      // minted for any auth user id the browser named.
      const { data: member, error: me } = await admin.from("client_users")
        .select("user_id, full_name").eq("client_id", clientId).eq("user_id", forUserId).maybeSingle();
      if (me) throw me;
      if (!member) return json({ error: "That person is not on your team." }, 404);

      let weeklyHours: Record<string, [string, string][]> | undefined;
      if (p.weeklyHours !== undefined) {
        try {
          weeklyHours = cleanWeeklyHours(p.weeklyHours);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }

      const tz = p.timeZone === undefined ? undefined : String(p.timeZone);
      if (tz !== undefined && !knownZone(tz)) {
        return json({ error: "We don't recognise that time zone." }, 400);
      }

      const row: Record<string, unknown> = {
        client_id: clientId,
        user_id: forUserId,
        updated_at: new Date().toISOString(),
      };
      const publicName = p.publicName !== undefined
        ? String(p.publicName).trim().slice(0, 80)
        : (member.full_name || "").trim().slice(0, 80);
      if (publicName) row.public_name = publicName;
      if (p.publicTitle !== undefined) row.public_title = p.publicTitle ? String(p.publicTitle).slice(0, 80) : null;
      if (tz !== undefined) row.time_zone = tz;
      if (weeklyHours !== undefined) row.weekly_hours = weeklyHours;
      if (typeof p.accepting === "boolean") row.accepting = p.accepting;
      if (typeof p.active === "boolean") row.active = p.active;

      const existing = scopedHostId
        ? await admin.from("meeting_hosts").select("*").eq("client_id", clientId).eq("id", scopedHostId).maybeSingle()
        : await admin.from("meeting_hosts").select("*").eq("client_id", clientId).eq("user_id", forUserId).maybeSingle();
      if (existing.error) throw existing.error;

      if (p.slug !== undefined) {
        const slug = slugify(p.slug);
        if (!slug) return json({ error: "A booking link needs some letters or numbers in it." }, 400);
        row.slug = slug;
      } else if (!existing.data) {
        // A new host needs a link. Derive it from their name, and make it unique by
        // suffixing rather than refusing — two people called Chris is not an error.
        const base = slugify(publicName || "me") || "me";
        let candidate = base;
        for (let i = 2; i <= 50; i++) {
          const { data: taken, error } = await admin.from("meeting_hosts")
            .select("id").eq("client_id", clientId).eq("slug", candidate).maybeSingle();
          if (error) throw error;
          if (!taken) break;
          candidate = `${base}-${i}`.slice(0, 40);
        }
        row.slug = candidate;
      }
      if (!existing.data && !row.public_name) {
        return json({ error: "Add the name customers should see on the booking page." }, 400);
      }

      let res;
      if (existing.data) {
        res = await admin.from("meeting_hosts").update(row)
          .eq("client_id", clientId).eq("id", existing.data.id).select().maybeSingle();
      } else {
        res = await admin.from("meeting_hosts").insert(row).select().maybeSingle();
      }
      if (res.error) {
        if (String(res.error.code) === "23505") {
          return json({ error: "That booking link is already taken on this account." }, 409);
        }
        throw res.error;
      }
      await r.ctx.audit("meetings_save_host", 1, res.data?.slug ?? null);
      return json({ ok: true, host: {
        id: res.data.id, userId: res.data.user_id, slug: res.data.slug,
        publicName: res.data.public_name, publicTitle: res.data.public_title,
        photoUrl: res.data.photo_url, timeZone: res.data.time_zone,
        weeklyHours: res.data.weekly_hours || {}, accepting: res.data.accepting,
      } });
    }

    case "set_host_types": {
      const ids: string[] = Array.isArray(p.typeIds)
        ? [...new Set(p.typeIds.filter((x: unknown) => typeof x === "string"))] as string[]
        : [];
      // Every id must be one of THIS tenant's types; an id from another builder would
      // otherwise end up in the join table and onto a public page.
      if (ids.length) {
        const { data: valid, error } = await admin.from("meeting_types")
          .select("id").eq("client_id", clientId).in("id", ids);
        if (error) throw error;
        if ((valid ?? []).length !== ids.length) {
          return json({ error: "One of those meeting types is not on this account." }, 404);
        }
      }
      const { error: de } = await admin.from("meeting_host_types").delete().eq("host_id", scopedHostId);
      if (de) throw de;
      if (ids.length) {
        const { error: ie } = await admin.from("meeting_host_types")
          .insert(ids.map((id) => ({ host_id: scopedHostId, type_id: id })));
        if (ie) throw ie;
      }
      await r.ctx.audit("meetings_set_host_types", ids.length, null);
      return json({ ok: true, typeIds: ids });
    }

    case "save_override": {
      const onDate = typeof p.onDate === "string" ? p.onDate : "";
      if (!parseDay(onDate)) return json({ error: "That is not a date we can read." }, 400);
      const blocked = p.blocked === undefined ? true : !!p.blocked;
      let hours: Record<string, [string, string][]> = {};
      if (!blocked) {
        try {
          // Reuse the weekly validator by wrapping the single day's blocks — one rule for
          // what a block of time may look like, not two that can drift.
          hours = cleanWeeklyHours({ mon: p.hours ?? [] });
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
        if (!hours.mon || !hours.mon.length) {
          return json({ error: "Give the hours for that day, or block it out instead." }, 400);
        }
      }
      const { data, error } = await admin.from("meeting_overrides").upsert({
        client_id: clientId,
        host_id: scopedHostId,
        on_date: onDate,
        blocked,
        hours: blocked ? [] : hours.mon,
        note: p.note ? String(p.note).slice(0, 200) : null,
      }, { onConflict: "host_id,on_date" }).select().single();
      if (error) throw error;
      await r.ctx.audit("meetings_save_override", 1, onDate);
      return json({ ok: true, override: {
        id: data.id, onDate: data.on_date, blocked: data.blocked, hours: data.hours, note: data.note,
      } });
    }

    case "delete_override": {
      const { error } = await admin.from("meeting_overrides")
        .delete().eq("client_id", clientId).eq("id", p.id);
      if (error) throw error;
      await r.ctx.audit("meetings_delete_override", 1, null);
      return json({ ok: true });
    }

    case "book": {
      const typeId = typeof p.typeId === "string" ? p.typeId : null;
      const startsAt = typeof p.startsAt === "string" ? p.startsAt : null;
      if (!typeId || !startsAt) return json({ error: "Pick a meeting type and a time." }, 400);
      const startMs = Date.parse(startsAt);
      if (!Number.isFinite(startMs)) return json({ error: "That is not a time we can read." }, 400);

      const loaded = await loadRules(scopedHostId!, typeId);
      if (!loaded) return json({ error: "That person or meeting type is not on this account." }, 404);
      const { host, type } = loaded;
      if (!type.active) return json({ error: "That meeting type isn't being offered." }, 409);

      const name = String(p.customerName ?? "").trim();
      const email = p.customerEmail ? String(p.customerEmail).trim().slice(0, 254) : null;
      const phone = p.customerPhone ? String(p.customerPhone).trim().slice(0, 32) : null;
      if (!name) return json({ error: "Who is the meeting with?" }, 400);
      if (!email && !phone) {
        return json({ error: "Add an email address or a phone number, or there is no way to confirm it." }, 400);
      }

      // ⚠️ Through book_meeting(), exactly like the public page. Not a direct insert: the
      // advisory lock and the buffered overlap re-check inside that function are the only
      // reason two people cannot take the same slot.
      const endMs = startMs + type.duration_minutes * 60_000;
      const { data: booked, error: be } = await admin.rpc("book_meeting", {
        p_client_id: clientId,
        p_host_id: host.id,
        p_type_id: type.id,
        p_starts_at: new Date(startMs).toISOString(),
        p_ends_at: new Date(endMs).toISOString(),
        p_time_zone: host.time_zone,
        p_name: name.slice(0, 120),
        p_email: email,
        p_phone: phone,
        p_notes: p.notes ? String(p.notes).slice(0, 2000) : null,
        p_source: "portal",
        p_contact_id: typeof p.contactId === "string" ? p.contactId : null,
        p_short_code: typeof p.shortCode === "string" ? p.shortCode : null,
        p_created_by: userId,
        p_buffer_before_minutes: type.buffer_before_minutes,
        p_buffer_after_minutes: type.buffer_after_minutes,
      });
      if (be) throw be;
      if (!booked) {
        return json({
          error: "That time was just taken. Pick another and it'll go straight in.",
          code: "slot_taken",
        }, 409);
      }
      await r.ctx.audit("meetings_book", 1, `${host.slug} ${new Date(startMs).toISOString()}`);

      // ⚠️ THE SAME CONFIRMATION THE PUBLIC PAGE SENDS, through the same module. A rep
      // booking for a customer on the phone and the customer booking themselves must produce
      // the same email and the same calendar invite - otherwise which of the two happened
      // becomes something the customer can tell, and the rep has to explain it.
      // Best effort: the booking is committed, and a mail failure must not undo it.
      //
      // VIDEO (333) FIRST, so the confirmation carries the fresh link. Never throws: a link
      // that cannot be made leaves the type's room link (or "a link will follow") in place.
      const video = await ensureConference(admin, booked.id, denoVideoEnv());
      let confirmationSent = false;
      if (await claimConfirmation(admin, booked.id)) {
        const mail = await sendMeetingEmail(admin, { meetingId: booked.id, which: "booked", req });
        confirmationSent = mail.sent;
      }
      return json({ ok: true, id: booked.id, confirmationSent, video: video.status });
    }

    case "cancel": {
      const { data, error } = await admin.from("meetings").update({
        status: "cancelled",
        cancelled_by: userId,
        cancelled_at: new Date().toISOString(),
        cancel_reason: p.reason ? String(p.reason).slice(0, 500) : null,
        updated_at: new Date().toISOString(),
      }).eq("client_id", clientId).eq("id", p.id).eq("status", "booked").select().maybeSingle();
      if (error) throw error;
      // Already cancelled is not an error worth a red message — but it is not a success
      // either, because the caller's list is stale and it should refresh.
      if (!data) return json({ ok: true, alreadyGone: true });
      await r.ctx.audit("meetings_cancel", 1, p.id);
      // Delete the Zoom meeting we made for it (333), so no dead room is left in their account.
      await dropConference(admin, p.id, denoVideoEnv());
      // Sequence first, then METHOD:CANCEL, so it leaves the customer's calendar instead of
      // sitting there as a meeting nobody turns up to (see meetingIcs.ts).
      const cancelSeq = await bumpIcsSequence(admin, p.id);
      const cancelMail = await sendMeetingEmail(admin, {
        meetingId: p.id, which: "cancelled", req, sequence: cancelSeq,
      });
      return json({ ok: true, emailSent: cancelMail.sent });
    }

    case "set_status": {
      const status = String(p.status ?? "");
      // Deliberately NOT 'booked' and NOT 'cancelled': un-cancelling would need the slot
      // re-checked (somebody else may hold it now), and that is `book`'s job, not a status flip.
      if (!["completed", "no_show"].includes(status)) {
        return json({ error: "That is not a state a meeting can be put into here." }, 400);
      }
      const { data, error } = await admin.from("meetings")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("client_id", clientId).eq("id", p.id).neq("status", "cancelled").select().maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "That meeting was cancelled, so it can't be marked." }, 409);
      await r.ctx.audit("meetings_set_status", 1, status);
      return json({ ok: true });
    }

    case "resend": {
      // Only the address already on the booking. Taking one from the body would turn this
      // into a way to have the platform email a stranger under a builder's domain.
      const { data: m, error } = await admin.from("meetings")
        .select("id, status, customer_email").eq("client_id", clientId).eq("id", p.id).maybeSingle();
      if (error) throw error;
      if (!m) return json({ error: "That meeting is not on this account." }, 404);
      if (!m.customer_email) {
        return json({ error: "There's no email address on that booking, so there's nothing to resend." }, 409);
      }
      // A cancelled meeting resends the CANCELLATION, not the confirmation: re-confirming
      // something that is off is the one version of this nobody wants.
      const which = m.status === "booked" ? "booked" : "cancelled";
      const out = await sendMeetingEmail(admin, { meetingId: m.id, which, req });
      await r.ctx.audit("meetings_resend", 1, which);
      if (!out.sent) {
        return json({
          error: out.reason === "not_active"
            ? "Your account isn't set up to send email yet — that's under Settings → Email Settings."
            : "That didn't send. Please try again.",
          code: out.reason,
        }, 409);
      }
      return json({ ok: true, sentTo: m.customer_email });
    }

    // ══ VIDEO (migration 333) ═══════════════════════════════════════════════════════════
    case "make_link": {
      const { data: m, error } = await admin.from("meetings")
        .select("id, status, conference_status, customer_email").eq("client_id", clientId).eq("id", p.id).maybeSingle();
      if (error) throw error;
      if (!m) return json({ error: "That meeting is not on this account." }, 404);
      if (m.status !== "booked") return json({ error: "That meeting isn't upcoming, so it doesn't need a link." }, 409);
      const out = await ensureConference(admin, m.id, denoVideoEnv());
      await r.ctx.audit("meetings_make_link", 1, out.status);
      if (out.status === "generated") {
        // Only when this call made it: re-send the confirmation with a bumped SEQUENCE, so the
        // customer's email and their calendar entry both carry the link (meetingIcs.ts).
        let emailSent = false;
        if (m.conference_status !== "generated" && m.customer_email) {
          const seq = await bumpIcsSequence(admin, m.id);
          const mail = await sendMeetingEmail(admin, { meetingId: m.id, which: "booked", req, sequence: seq });
          emailSent = mail.sent;
        }
        return json({ ok: true, status: "generated", emailSent });
      }
      const why: Record<string, string> = {
        not_connected: "The host hasn't connected their Zoom account yet. They can do that under Settings → Customer Hub → Meetings.",
        needs_reconnect: "The host's Zoom connection has stopped working. They need to reconnect it under Settings → Customer Hub → Meetings.",
        not_set_up: "Zoom isn't switched on for Structure Studio yet.",
        not_available: "A new link per booking only works with Zoom for now.",
        room_link: "This meeting type uses your standing room link, so there's nothing to make.",
        in_progress: "A link is being made for this meeting right now. Give it a moment and refresh.",
      };
      const reason = "reason" in out ? out.reason : "provider_error";
      return json({
        error: why[reason] || "Zoom didn't make the meeting just now. Please try again in a minute.",
        code: reason,
      }, 409);
    }

    case "video_connect": {
      // SELF ONLY. HOST_SCOPE already narrowed an own-only caller; this closes it for a
      // manager too, who could otherwise attach their own Zoom to a colleague's bookings.
      if (!myHost || scopedHostId !== myHost.id) {
        return json({ error: "Only the person themselves can connect their Zoom account." }, 403);
      }
      if (operator) return json({ error: "Connecting a Zoom account isn't available while viewing another account." }, 403);
      const provider = String(p.provider ?? "zoom");
      if (provider !== "zoom") return json({ error: "Only Zoom can be connected so far." }, 400);
      const creds = zoomCredsFromEnv((k) => Deno.env.get(k));
      if (!creds) {
        return refusal({ error: "Zoom isn't switched on for Structure Studio yet.", code: "not_set_up" }, 503);
      }
      const returnHost = String(p.returnTo ?? "");
      if (!MEETINGS_OAUTH_HOSTS.has(returnHost)) return json({ error: "Start this from the Structure Studio app." }, 400);
      const state = newOauthState();
      const { error } = await admin.from("meeting_oauth_states").insert({
        state, client_id: clientId, host_id: myHost.id, user_id: userId, provider,
        return_host: returnHost, expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
      });
      if (error) throw error;
      await r.ctx.audit("meetings_video_connect", 1, provider);
      return json({ ok: true, url: zoomAuthorizeUrl(creds, meetingsOauthRedirectUri(), state) });
    }

    case "video_disconnect": {
      const provider = String(p.provider ?? "zoom");
      if (provider !== "zoom") return json({ error: "Only Zoom can be connected so far." }, 400);
      const { data: conn, error } = await admin.from("meeting_connections")
        .select("id, access_token, refresh_token").eq("host_id", scopedHostId).eq("provider", provider).maybeSingle();
      if (error) throw error;
      if (!conn) return json({ ok: true, alreadyGone: true });
      // Tell Zoom too, best effort: the row is deleted either way, so no token outlives this.
      const creds = zoomCredsFromEnv((k) => Deno.env.get(k));
      const tok = conn.refresh_token || conn.access_token;
      if (creds && tok) await zoomRevoke(creds, tok);
      const { error: de } = await admin.from("meeting_connections").delete().eq("id", conn.id);
      if (de) throw de;
      await r.ctx.audit("meetings_video_disconnect", 1, provider);
      return json({ ok: true });
    }

    default:
      return json({ error: `Unknown action "${action}".` }, 400);
  }
}));
