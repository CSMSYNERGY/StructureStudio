# Meetings — Calendly-style booking for builders

**Status: PHASES 1, 2 AND 2b ARE LIVE ON BETA** (migrations 326–329, 2026-10-22), verified
end to end against real sends. **Phase 4b (Zoom, a fresh link per booking) is BUILT
(migration 333, 2026-10-23) and dark until Carolyn's Zoom app secrets are added.** Phases 3,
4 and 5 are not built; 3 and 4 are blocked on an OAuth app Carolyn owns. Read it before touching anything named `meeting_*`.

## Why, and what was already decided

The slot has been reserved in the product for two months. `portal/02-sales.jsx:2618` carries a
greyed CRM tab — `{ key: "scheduler", label: "Meeting scheduler", enabled: () => false, hint:
"Arrives with the calendar integration." }` — and on **2026-08-26 (18:00) Carolyn had the
"meeting" and "lunch" chips removed from the Activity composer**: *"I don't want meeting in
there — we have a meeting scheduler."* Ahsan confirmed 2026-08-27. The comment left behind
states the rule this whole feature has to honour:

> two ways to book the same thing is how a calendar drifts out of sync with itself.

So **booking is the only way a meeting comes into existence.** The server still accepts the
`meeting` and `lunch` activity kinds (migration 131's CHECK, `KINDS` in portal-settings,
`labelActivity` in `_shared/crmFeed.ts`) because tenants have historical rows — do not remove
them, that would blank existing history. But nothing new writes them.

⚠️ **This is NOT `SCHEDULING_SCOPE.md`.** That document is the Build Schedule / Delivery
Schedule / Repairs suite (migrations 087–095, `portal-schedule`), which schedules *buildings*.
This schedules *people talking to people*. They share no tables and no edge function. The one
place they touch is vocabulary: the `scheduler` JOB TITLE belongs to the build boards and has
nothing to do with who may hold a booking link.

## Carolyn's three decisions (2026-10-22)

1. **Per-person links, with a team pool possible later.** Every bookable person gets their own
   link and their own hours, like Calendly. Availability is always a person's, never a
   company's. A tenant-level link that round-robins across a chosen group layers on top
   without reshaping anything (phase 5).
2. **Google AND Outlook two-way sync.** Both, not one. Read busy times so nothing
   double-books; write the meeting into the host's own calendar.
3. **Sold as part of the CRM.** It gates on the existing `crm` entitlement
   (`_shared/featureCheck.ts`), the same one the Activity / Notes / Email tabs use. No new
   `billing_plans` row, no second launch switch, no pricing in What's New. The greyed tab
   already shows `CRM_LOCKED_HINT` for an account without it, so the story is consistent.

⚠️ **Decision 2 cannot gate the launch, and the build is sequenced so it does not.** Google
Calendar's read scope is *sensitive* and needs a published OAuth app plus a verification
review; Microsoft needs an Entra app registration. Both are Carolyn's to create — see
"What Carolyn has to do" at the end. **Phases 1–2 ship a fully working booking product with
no external calendar at all**, and the connectors in 3–4 attach to it. A tenant with no
calendar connected is a supported, permanent state, not a degraded one.

## Shape

**Public page `/book`** — `book.html`, served by the Worker exactly like `shop.html` and
`my-quotes.html`: plain JS + inline CSS, no React, no Babel, no `/vendor/` tags, so it loads
fast on a phone and inside a builder's own site. Brand colours from the tenant's config, same
as the shop. Two URL shapes:

- `/book?client=<slug>&with=<host-slug>` — one person. The Calendly equivalent.
- `/book?client=<slug>&type=<type-slug>` — pick a meeting type first, then a person.
- (phase 5) `/book?client=<slug>&team=<pool-slug>` — round-robin across a group.

`book-embed.js` mirrors `shop-embed.js` so a builder can drop the booker into their own site.

**Portal, three surfaces:**

- **Sales → CRM record → Meeting scheduler** (the greyed tab, switched on). Book *for* this
  contact, and see that contact's upcoming and past meetings. This is the internal path: a rep
  on the phone with a customer books it there and then rather than sending a link.
- **Sales → Meetings** — my week, and (with `meetings:'view'`) the team's. Cancel, reschedule,
  mark no-show.
- **Settings → Meetings** — meeting types, my hours, my link, connected calendars, reminders.
  Per Carolyn's standing rule, every feature's settings get their own page under Settings,
  never a panel on the working tab.

## Tables (one migration; take the next free number at apply time — 315 is the highest here)

1. **`meeting_hosts`** — one row per bookable person. `client_id`, `user_id` (→ `client_users`),
   `slug` (unique per tenant; what's in the URL), `public_name`, `public_title`, `photo_url`,
   `time_zone`, `weekly_hours` jsonb, `accepting` bool, `active` bool.
   `weekly_hours` reuses the **exact shape `phone_user_settings.ring_hours` already uses**
   (migration 264): `{"mon":[["08:00","12:00"],["13:00","17:00"]],…}`, interpreted in
   `time_zone`. Same shape, same validation helper, no second mental model for "weekly hours".
2. **`meeting_types`** — `name`, `slug`, `duration_minutes`, `location_kind`
   (`in_person` | `phone` | `video` | `custom`), `location_detail`, `description`,
   `buffer_before_minutes`, `buffer_after_minutes`, `min_notice_hours`, `max_days_ahead`,
   `slot_interval_minutes`, `color`, `active`. Tenant-level; a host opts into the ones they
   offer via `meeting_host_types`.
3. **`meeting_host_types`** — which host offers which type (many-to-many).
4. **`meeting_overrides`** — a specific date for one host: either blocked (vacation, holiday)
   or replacement hours for that day. Beats `weekly_hours`.
5. **`meetings`** — the booking. `client_id`, `host_user_id`, `meeting_type_id`, `contact_id`,
   `short_code` (the deal it's filed against, nullable), `starts_at timestamptz`, `ends_at`,
   `booked_time_zone` (what the *customer* saw — keep it, it's what the confirmation said),
   `status` (`booked` | `cancelled` | `completed` | `no_show`), customer name/email/phone,
   `customer_notes`, `internal_notes`, `cancel_token`, `source` (`public` | `portal` | `embed`),
   `created_by`, `cancelled_by`, `cancelled_at`, `cancel_reason`.
6. **`meeting_connections`** — one per host per provider. `provider` (`google` | `microsoft`),
   `calendar_id`, refresh token, `sync_token`, `last_synced_at`, `status`. **Service-role only,
   zero RLS policies**, the `commission_members` / `driver_profiles` posture. A refresh token is
   a standing key to someone's calendar; it never reaches a browser.
7. **`meeting_busy`** — cached external busy blocks (`host_user_id`, `starts_at`, `ends_at`,
   `provider`, `external_id`). **Availability reads this table, never a live Google/Microsoft
   API call.** A public page view must not fan out to a third-party API: it would put Google's
   rate limit and uptime in front of a builder's booking page.
8. **`meeting_settings`** — per tenant: on/off, page heading and blurb, confirmation-email
   toggle, reminder schedule, whether a booking creates a CRM contact.

**One anon read path**, `get_public_booking(p_client_id, p_host_slug)`, SECURITY DEFINER,
anon-executable, modelled line-for-line on `get_public_shop` (migration 310): it returns only
what a public page may show — host display name, title, photo, time zone, the types they offer.
**Never** `user_id`, email, phone, the tenant's contacts, or anything about other bookings
beyond "this slot is taken".

## The availability engine

This is the whole feature; everything else is forms. Given a host, a meeting type and a date
range, in the host's `time_zone`:

1. Generate candidate starts from `weekly_hours`, stepping by `slot_interval_minutes`.
2. Replace any day present in `meeting_overrides` (blocked → no slots).
3. Subtract `meetings` with `status='booked'`, widened by the type's before/after buffers.
4. Subtract `meeting_busy` rows (phases 3–4; empty until a calendar is connected).
5. Drop anything inside `min_notice_hours` or beyond `max_days_ahead`.
6. Render in the **customer's** timezone, with the host's timezone named on screen.

⚠️ **The whole engine is timezone arithmetic, which is where this class of feature actually
breaks.** Two rules, both already written down in `portal/01-core.jsx:2177`: a bare
`yyyy-mm-dd` is a calendar day, not an instant, and `new Date("2026-11-20")` is UTC midnight.
Every stored instant is `timestamptz`. Every *rule* (weekly hours, override dates) is local
wall-clock plus a named zone. DST is the test case that matters: a host whose Tuesday runs
08:00–17:00 works those hours on both sides of the change, which means the UTC offsets of
their slots differ across it. Compute in the zone, store the instant.

**A booking must not be able to double-book.** The slot list a customer sees is a snapshot;
two people can load the same slot. The write path re-checks availability inside the
transaction and relies on an exclusion constraint on `(host_user_id, tstzrange(starts_at,
ends_at))` for `status='booked'`, so the loser gets a clean "that time was just taken" rather
than a second meeting nobody sees.

## Edge functions

- **`book-public`** — anon, the public page's only writer. Actions `availability`, `book`,
  `cancel`, `reschedule`. Token-authenticated for cancel/reschedule (`cancel_token` in the
  link), never by email address. **Rate limited per tenant exactly like `capture-lead`**, and
  for the same reason: anyone holding the public anon key can otherwise drive unbounded writes
  into any configured tenant. Both of capture-lead's guards apply — the many-different-emails
  flood and the one-email-hammered case — and **they run before every write**, which is the
  ordering capture-lead's header explains at length. Do not re-learn that lesson here.
- **`portal-meetings`** — tenant-side, `resolveTenant` + a `GATES` table, in
  `SS_TENANT_SCOPED_FNS` so operator view-as works.
- **`meetings-oauth-connect` / `meetings-oauth-callback`** — copy the shape of
  `qbo-oauth-connect` / `qbo-oauth-callback`, which already solves per-tenant OAuth round-trip,
  state signing and token storage in this codebase.

## Access

A new area **`meetings`**, `group: "workspace"`, levels `["none","own","view","edit"]` with
**`ownWrites: true`** — your own calendar is yours to run, the way `contacts:'own'` works.
`'own'` = my meetings and my availability; `'view'` = see the team's; `'edit'` = manage anyone's
and edit the tenant's meeting types.

⛔ **Adding an area is a two-place change and `scripts/preflight.mjs` enforces it.** `AREAS` in
`_shared/access.ts` AND the `area_level_for()` mirror in SQL — and the current definition of
that function is **not** whichever migration has the highest number. Derive it:
`grep -l 'create or replace function public.area_level_for' supabase/migrations/*.sql`, and
cross-check what is actually deployed with `select pg_get_functiondef(...)`. `change_orders`
and the sales_rep `orders` level both drifted silently because somebody read a number off a
document. `checkAreaMirror()` will fire on the key set; add it to the SQL in the same commit.

Also: the ten job-title presets each need a `meetings` level. Proposed — owner/admin/
office_staff/sales_manager `edit`; sales_rep/dealer `own`; scheduler/crew_leader/crew_member/
driver `none`. ⚠️ Preset LEVELS are the one thing preflight does **not** check, so these are
reviewed by eye or not at all.

## Email and SMS

Confirmation on booking, reminder before, notice on cancel/reschedule — through
`_shared/emailSend.ts` and the tenant's own Resend domain where they have one, falling back to
the platform address (see "StructureStudio without GoHighLevel": a builder with no GHL must get
the full flow). Every confirmation carries an **`.ics` attachment** — that is how the customer's
own calendar finds out, and it is the only sync that works for the *customer*, who will never
connect anything to us.

⚠️ **An SMS reminder is not a free add-on.** It goes through the existing registration, consent
and STOP rules in `portal-sms`; a reminder to someone who never opted in is a compliance
problem, not a feature. Phase 2 ships email only; SMS is a separate decision.

## Video meetings (added 2026-10-22)

Carolyn: *"We need to be able to connect zoom, hangouts & teams to generate video meeting
links for video meetings."*

⚠️ **Meet and Teams need no integration of their own, and knowing that halves this work.** A
Google Meet link is what Google's Calendar API hands back when the event is created with
`conferenceData`; a Teams link is what Microsoft Graph hands back the same way. So both ride
the two calendar connectors phases 3–4 already need. **Only Zoom is a separate OAuth app —
three apps for Carolyn to create, not five.**

There are two genuinely different features here, and only one of them needed anybody's
permission:

- **Route A — the standing room link. SHIPPED (migrations 328/329).** Zoom, Meet and Teams all
  give every account a permanent personal room, and a small business very often runs every
  call through it. The builder pastes it once on the meeting type; `book_meeting()` copies it
  onto each booking, and it reaches the customer in the confirmation, the reminder and the
  invite's `LOCATION` — which is where a calendar client turns it into its own Join button.
  Nothing is connected, and it works.
- **Route B — a fresh link per booking. ZOOM BUILT (migration 333), see below.** Needs the OAuth apps. The columns are already laid
  out for it (`meetings.conference_*` is per booking, not per type) and `book_meeting()`
  reports the provider back to its caller so a booking that is *waiting* for a generated link
  (`'zoom'` with a null url) is distinguishable from one that never wanted one (`'none'`).

⚠️ **The link lives on the MEETING, not only the type.** A builder who changes their room link
next month must not silently move a meeting that was already confirmed with the old one — the
same reasoning that keeps `booked_time_zone` on the row.

### Route B for Zoom — how it works (migration 333, 2026-10-23)

Carolyn's decisions, 2026-10-23: **each team member connects their own account** (the
meeting is made in the host's Zoom, like Calendly); **book anyway** when a link cannot be
made, using the type's room link, or telling the customer a link will follow, with a "Make the
link" button for the host; **Zoom first**; connecting Google/Microsoft later should put the
meeting on the host's calendar, with busy-time blocking after that.

- **Per type:** `meeting_types.conference_mode` = `room` (route A, the default; every existing
  type) or `generate`. `generate` requires a provider that can generate (a CHECK; only Zoom is
  accepted by `save_type` today). In `generate` mode the room link is optional and is the
  FALLBACK.
- **Per person:** Settings → Customer Hub → Meetings → **My Zoom account**. `video_connect`
  (portal-meetings, self only, even for a manager) writes a one-shot row to
  `meeting_oauth_states` and returns Zoom's authorize URL; `meetings-oauth-callback`
  (verify_jwt false) burns the row, exchanges the code, and upserts `meeting_connections`
  (provider `zoom`, plus `account_email` for "Connected as …"). `video_disconnect` revokes at
  Zoom and deletes the row (a manager may disconnect a colleague's).
- **Per booking:** `_shared/meetingVideo.ts`. `book_meeting()` is unchanged: it already copies
  the room link, which is the fallback. After it returns, `ensureConference` claims the row
  (`conference_status='pending'`, one winner), creates the Zoom meeting in the host's account,
  and swaps in the join link + `conference_external_id` (`generated`). On any failure the
  row reads `fallback` (room link kept) or `failed` (no link: the confirmation says "Your video
  link will follow by email" and the portal offers **Make the link**, which retries and re-sends
  the confirmation with a bumped SEQUENCE). It never throws and every Zoom call has a timeout,
  so a booking never fails for want of a link.
- **Moves and cancels:** `moveConference` PATCHes the Zoom meeting before the rescheduled email
  (a meeting deleted in Zoom by hand gets a new one; one that never got a link gets another
  try); `dropConference` deletes it on cancel. Wired into `book-public` (book, reschedule,
  cancel) and `portal-meetings` (book, cancel) — those are every path that changes a meeting.
- **Zoom rotates the refresh token on every refresh.** `zoomAccess` stores the new one first,
  and on `invalid_grant` re-reads the row before declaring the connection dead (a concurrent
  request may have rotated it). A dead connection becomes `needs_reauth` and the page says
  "Reconnect Zoom".
- **`zoom-webhook`** (verify_jwt false, `x-zm-signature` HMAC) answers Zoom's URL validation
  and drops tokens on `app_deauthorized`, which Zoom requires of a published app.
- **Privacy:** the Zoom topic is "<type> with <business>", never the customer's name. Nothing
  about the customer is sent to Zoom.
- Tests: `_shared/zoomApi.test.ts`, `_shared/meetingVideo.test.ts`, one case in
  `meetingEmails.test.ts`.

### What Carolyn does to switch Zoom on (no agent handles these values)

1. marketplace.zoom.us → Develop → Build App → **General App**, user-managed.
2. OAuth Redirect URL **and** allow list:
   `https://jzeamjbhdrsbygdnphbm.supabase.co/functions/v1/meetings-oauth-callback`
3. Scopes: `meeting:write:meeting`, `meeting:update:meeting`, `meeting:delete:meeting`,
   `user:read:user`.
4. Features → Event Subscriptions: endpoint
   `https://jzeamjbhdrsbygdnphbm.supabase.co/functions/v1/zoom-webhook`, event
   "App Deauthorized".
5. Supabase → Edge Functions → Secrets: `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`,
   `ZOOM_WEBHOOK_SECRET_TOKEN`.
6. Until Zoom reviews and publishes the app, only accounts in Carolyn's own Zoom account can
   connect; other builders' Zoom accounts need the published app.

## Phases

| # | What | Ships without |
|---|------|---------------|
| 1 | Schema, availability engine, `book.html`, Meeting scheduler tab, Settings → Meetings | any external calendar |
| 2 | Confirmation + reminder email, `.ics`, cancel/reschedule links | — |
| 2b | Video **room links** (route A), Meetings inside Settings → Customer Hub | anything connected |
| 3 | Google Calendar connector: busy read, event write, **and Meet links** | Carolyn's Google Cloud app |
| 4 | Microsoft connector: busy read, event write, **and Teams links** | Carolyn's Entra registration |
| 4b | Zoom connector: a fresh meeting per booking — **BUILT (333), dark until the secrets** | Carolyn's Zoom app |
| 5 | Team pools / round-robin, `book-embed.js`, Sales → Meetings page | — |

## What Carolyn has to do (phases 3–4 cannot start without these)

1. **Google Cloud project** → OAuth 2.0 Web client, scopes `calendar.readonly` +
   `calendar.events`, redirect URI to the callback function. The calendar scopes are
   *sensitive*, so the app needs publishing and a verification review — that review takes days
   to weeks and is the long pole on phase 3.
2. **Microsoft Entra app registration** → client ID + secret, delegated `Calendars.ReadWrite` +
   `offline_access`, same redirect shape.
3. **Zoom** → a Server-to-Server OAuth or OAuth app on marketplace.zoom.us, scope
   `meeting:write`, for route B only. Route A needs nothing.
4. Both client IDs and secrets go in as **Supabase function secrets**, added by her — per the
   standing rule, no key values are read, printed or fingerprinted here.

## What is actually running the reminders

⚠️ **pg_cron is NOT installed on this project** (CLAUDE.md records it verified absent on
2026-08-08, and records the cost: `sync_all` says "Run by pg_cron every 10 minutes" and has
never run once). Reminders are therefore driven by the **phone-api Cloudflare Worker's
one-minute cron tick**, every five minutes on `MEETINGS_MINUTE_MOD5`, which POSTs to the
`meeting-reminders` edge function. That Worker's deploy is MANUAL and it serves the live phone
line, so the reminder job ships on its next deploy — confirmations, reschedules and
cancellations do not wait for it.

## Verified-after-deploy

Carolyn's standing rule applies in full: every change is verified AND tested live on beta
(`beta.structurestudiosuite.com` — *not* `beta.structurestudio.app`, which 301s to production)
after deploy. Pushing is not done. Test with `?client=structure-studio`.
