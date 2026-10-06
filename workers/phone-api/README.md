# phone-api

The My Synergy Phone Worker. It answers Twilio's call webhooks, mints Twilio Access Tokens for the Chrome extension and the phone app, sends texts through the shared texting rules, serves the apps' read endpoints, pushes text alerts to phones, and runs two crons: a recording sweep, and a daily job for voicemail retention and (once armed) billing. It also handles hold and warm transfer (plan 9C, design b), voicemail transcription, inbound photos, and call recording with transcripts and summaries (release B2, off until switched on).

The contract is `docs/SPEC.md` in the private `structure-studio-phone` repo, section 3. The product plan is `_Extras/Structure Studio Phone Plan 2026-09-28.md` in the vault. Where this Worker reads the contract a particular way, `DEVIATIONS.md` says so. The one-time setup is in `SETUP.md`.

This repo is public. No secret, client name, phone number or SID goes in any file here, tests included. Every credential below is a `wrangler secret`.

## Layout

```
src/index.ts          router: /voice/* (Twilio), /push/text and /push/email (DB webhooks), everything else (apps), crons
src/routes/voice.ts   outbound, inbound, after-dial, screen, status, voicemail
src/routes/token.ts   POST /token
src/routes/calls.ts   cold transfer, call events, voicemail audio
src/routes/conference.ts  hold, resume, warm transfer (the app endpoints)
src/routes/handoff.ts  moving a live call to the person's other device (the app endpoints)
src/routes/media.ts   GET /media/:messageId/:index (inbound photos)
src/routes/sms.ts     POST /sms/send
src/routes/reads.ts   /threads, /threads/:key, /calls, /search, /team
src/emailThread.ts    email in a conversation: the rows the apps get, HTML mail as text, whether they can send
src/routes/me.ts      /settings/me (POST and GET), /devices, /devices/signout-all, /log, /turn, /health
src/routes/greeting.ts  /settings/me/greeting/record, /audio, /clear: each person's own voicemail greeting
src/greeting.ts       the greeting's Twilio side: /voice/greeting (the recording ring's TwiML and save), GET /voice/greeting-audio
src/voicemail.ts      the voicemail TwiML and whose greeting it plays (the person's own, the number's, the standard one)
src/hours.ts          business hours (isOpen) and each person's own hours (inRingHours), in their time zones
src/logPrivacy.ts     what a Chrome extension error report keeps: keyed refs instead of ids, known context keys, numbers and ids redacted
src/routes/quickSends.ts  /quick-sends: each person's saved messages (list, add, change, delete, used)
src/routes/push.ts    /push/text and /push/email: text and email alerts (FCM HTTP v1, APNs)
src/routes/recordings.ts  GET /recordings/:id/audio, GET /calls/:id/transcript
src/recording.ts      call recording: armed or not, the announcement, start / pause / resume / stop on the customer's leg, /voice/recording, /voice/notice, the sweep's backstop
src/cron/             sweep.ts (*/15), usageCharge.ts (every 5 min: each call, text, call recording and transcript at cost x markup; 09:00 UTC: Twilio's daily usage totals), retention.ts, lineFee.ts and numberFee.ts (daily, 09:00 UTC: voicemail and call recording retention, monthly line fee, each number's monthly fee from its second month), transcribe.ts (every minute while CALL_TRANSCRIBE is on: Workers AI transcripts, then the summary request)
src/conference.ts     the conference design: TwiML, which leg is which, the transfer_state machine, /voice/conference
src/handoff.ts        moving a live call between the person's devices: the answer, make before break, /voice/handoff
src/callEvents.ts     what phone_call_events say that the row cannot: a warm transfer's state, a Resume still landing
src/voicemail.ts      the greeting + <Record> TwiML (and transcription)
src/wallet.ts         the wallet floor for outbound calls
src/jwt.ts            Supabase login check (ES256 via JWKS, cached per isolate)
src/twilioSignature.ts  ?key= always, X-Twilio-Signature whenever TWILIO_AUTH_TOKEN is set
src/accessToken.ts    Twilio Access Token (HS256, cty twilio-fpa;v=1)
src/scope.ts          contacts row scope and "mine", reusing _shared/access.ts
scripts/log-ref.mjs   one person's user_ref / client_ref, to find their extension error reports when they ask for help
```

It imports five files from `supabase/functions/_shared`: `smsSend.ts` (and through it `twilioSms.ts`, `smsQuietHours.ts`, `logError.ts`), `access.ts`, `featureCheck.ts` (and through it `billingPeriods.ts`; the paid-CRM check for email), and `crmFeed.ts` (only `senderVerifiedFrom`, the inbound sender check the portal shows). Those files are written for Deno. Wrangler's `alias` maps their `jsr:@supabase/supabase-js@2` import onto the npm package installed here, and `src/env.ts` installs a `Deno.env.get` shim over the Worker's env, so they read the same secret names they read on the edge functions. Nothing under `supabase/functions` is edited for this. After a change to any of those shared files, redeploy this Worker along with the edge functions that import them.

## Commands

Run from this directory. `wrangler dev` does not start on the Windows machine (spawn UNKNOWN), so the tests run the Worker in Node with fetch stubbed.

```
npm ci
npm test                                   # vitest (Node, fetch stubbed)
npm run typecheck                          # tsc, includes the shared Deno files
npx wrangler deploy --dry-run --outdir dist   # proves the bundle builds; uploads nothing
```

`PHONE_CORE_DIR=<phone repo>/packages/phone-core npm test` also checks that `src/identity.ts` agrees with `@sss/phone-core` on every identity and number case.

Deploying is manual, from this directory, and only by a person (see SETUP.md). This Worker is not connected to Workers Builds.

Deploy only from a tree that has origin/beta merged in, or from beta itself. A `wrangler deploy` uploads this whole directory, so a branch cut before 259 and 260 were merged (8f206a2, where the email-in-the-conversation work began) would remove the call handoff routes and the usage cron from the live Worker for every business.

## Vars (wrangler.jsonc, not secret)

| Var | Default | What it does |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://phone.structurestudiosuite.com` | Every URL handed to Twilio is built from it. Use the workers.dev URL until the phone. routes exist. |
| `EMERGENCY_MODE` | `block` | `block` answers 911, 933 and 112 with "For emergencies, call 9 1 1 from your cell phone." Only the exact value `allow` lets 911 and 933 through (phase 6, needs registered emergency addresses). |
| `DAILY_MINUTE_CAP` | `600` | Outbound minutes per builder per UTC day, each call rounded up. `0` turns the cap off. |
| `EXTENSION_ORIGINS` | empty | Chrome extension ids (or full `chrome-extension://` origins), comma separated, allowed by CORS. The portal origins (app., beta., beta-2-0.) are built in. |
| `PHONE_USAGE_METERS` | `off` | Release 2. Exactly `on` lets calls and texts be charged to the wallet one by one (`src/cron/usageCharge.ts`) and the wallet floor refuse an outbound call, but only where the meter is also armed in the database (`phone_billing_settings` markup and `armed_at` set, and the `usage_prices` meter active or the tenant on the pilot list; migration 259). The monthly line fee needs this `on` and `phone_line_monthly` active and priced. The monthly number fee (`src/cron/numberFee.ts`) does NOT read this: its only switch is `sms_number_monthly` active and priced, the one the purchase's first month is charged on. The edge functions read the same name as a Supabase function secret for the texting path, so arming texts sent from the portal means setting it there too. Carolyn's prices (the cost × 1.25) and the arming order: SETUP.md 7e. |
| `PHONE_USAGE_COST_CAPTURE` | `on` | Anything but `off` records what every call and text cost at Twilio, and what it would charge at the current markup, as `shadow` rows in `usage_charges`, while nothing is charged. Also stores Twilio's daily usage totals in `twilio_usage_daily` at 09:00 UTC. |
| `VOICEMAIL_RETENTION_DAYS` | `365` | Recordings older than this are deleted at Twilio by the daily job. Minimum 30. |
| `TRANSCRIBE` | `off` | Release 2. `on` adds Twilio transcription to every voicemail (`<Record transcribe>`, about $0.05 a minute, English, 2 s to 2 min); the text lands in `phone_voicemails.transcript` and on the call's `voicemail` summary. |
| `CALL_RECORDING` | `off` | Release B2, the kill switch. Exactly `on` lets a business whose switch is on (on by default since migration 287; only the owner turns it off, in Settings › Phone) have its calls announced ("This call may be recorded.") and recorded: one dual-channel recording per call, on the customer's leg, started through Twilio's REST API when someone answers (`src/recording.ts`). Anything else: no announcement and no recording for anyone; recordings already made still play and still expire. Needs migration 263 (and 287 for the default). Set the Supabase function secret `CALL_RECORDING` to the same value every time (SETUP.md 7c): portal-settings reads it so the Settings card says whether calls really are recorded. Turning it on for the first time is SETUP.md 7d: the privacy policy and store listings come first. |
| `CALL_TRANSCRIBE` | `off` | Release B2. Exactly `on` transcribes recorded calls with Workers AI (Deepgram nova-3, through the `ai` binding) on the minute tick, for businesses that left transcripts on, and asks the `phone-call-summary` edge function for each summary. The announcement says "and transcribed" only while this is on. Set the Supabase function secret `CALL_TRANSCRIBE` to the same value every time: portal-settings reads it, so the Settings card says "and transcribed", and promises transcripts, only while they are made. Stays `off`: transcripts are a separate decision (SETUP.md 7d). |

The `ai` binding (`"ai": { "binding": "AI" }` in `wrangler.jsonc`) is Workers AI, billed to the Cloudflare account; there is no key to set. It is used only while `CALL_TRANSCRIBE` is `on`.

## Secrets (`npx wrangler secret put <NAME>`)

| Secret | Required | Used for |
|---|---|---|
| `SUPABASE_URL` | yes | The project URL. JWKS, issuer check, PostgREST, Auth. Kept as a secret so the project ref stays out of this public repo. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | The Worker's own Supabase secret key, under the name the shared code reads. Every database call, and Auth's global sign-out. |
| `SUPABASE_JWT_SECRET` | no | Only if the project still signs logins with the legacy HS256 secret. Unset means HS256 tokens are refused. |
| `TWILIO_ACCOUNT_SID` | yes | Access Tokens (`sub`), REST paths, texting. |
| `TWILIO_AUTH_TOKEN` | strongly recommended | X-Twilio-Signature. With it, a Twilio webhook needs the `?key=` AND a valid signature. Twilio's API cannot hand the token out, so the Worker also runs without it: webhooks are then accepted on the `?key=` alone (their `AccountSid` must be ours) and `twilio_signature_skipped` is logged at `warn` once per isolate. Copy it from the Console and set it as soon as you can (DEVIATIONS 30 says what the key alone leaves open). |
| `TWILIO_API_KEY` | yes | API key SID (SK...). Signs Access Tokens; authenticates REST calls and texts. |
| `TWILIO_API_SECRET` | yes | That key's secret. |
| `TWILIO_TWIML_APP_SID` | yes | The calls TwiML App (outgoing grant). |
| `TWILIO_ECHO_APP_SID` | yes | The setup-test TwiML App that answers `<Echo/>` (preflight tokens). |
| `TWILIO_PUSH_CREDENTIAL_APNS_DEV` | iPhone dev client | Push credential (a Twilio `apn` credential, Sandbox UNTICKED) for the iPhone development client (`build_type: dev`), made from the development bundle id's VoIP Services certificate. Unticked because EAS signs the development client ad hoc, and ad hoc builds get production push tokens (DEVIATIONS 75). Replaces `TWILIO_PUSH_CREDENTIAL_APNS_SANDBOX`, which is no longer read. |
| `TWILIO_PUSH_CREDENTIAL_APNS_PROD` | iPhone release | Push credential (a Twilio `apn` credential, Sandbox unticked) for preview, TestFlight and App Store builds (`build_type: prod`), made from the store bundle id's VoIP Services certificate. |
| `TWILIO_PUSH_CREDENTIAL_FCM` | phase 4 | Push credential for Android. |
| `PHONE_WEBHOOK_SECRET` | yes | The `?key=` on every Twilio URL this Worker serves. Use letters and digits only (32 or more). If it is missing, every Twilio request is refused (503), and Twilio falls back to the number's Voice Fallback URL. |
| `SMS_INBOUND_SECRET` | yes | Same value as on the edge functions. Texts sent from the apps carry it on their `sms-status` callback URL. |
| `PUSH_WEBHOOK_SECRET` | yes | The `x-push-secret` header the database webhooks send to `/push/text` and `/push/email` (one value, Vault's `sss_phone_push_secret`). |
| `LOG_PSEUDONYM_KEY` | yes | The HMAC key for the Chrome extension's error reports: they store `user_ref` and `client_ref` (keyed pseudonyms) instead of the user and business ids (DEVIATIONS 64). 32 characters or more. Keep a copy in the password manager: `scripts/log-ref.mjs` needs it to find a person's reports when they ask for help, and Cloudflare never shows a secret again. Unset or shorter, those reports are saved with no refs at all and `log_pseudonym_key_missing` is logged at `warn` once per isolate. Changing it starts new refs: older reports keep the old ones. |
| `FCM_SERVICE_ACCOUNT_JSON` | phase 4 | The Firebase service account JSON, whole. Android text and email alerts. Unset means they are skipped and logged once an hour. |
| `APNS_KEY_P8` | iPhone release | The APNs auth key (the whole .p8 file). iPhone text and email alerts. Create it team scoped (all topics, so it serves both bundle ids) and enabled for **Production**: every alert goes to Apple's production host, because every EAS build, the development client included, has production push tokens (DEVIATIONS 75). A Sandbox-only key is refused (`push_apns_auth_failed`, `BadEnvironmentKeyIdInToken`); a topic-specific key must list both bundle ids. |
| `APNS_KEY_ID` | iPhone release | That key's id. |
| `APNS_TEAM_ID` | iPhone release | The Apple team id. |
| `APNS_BUNDLE_ID` | iPhone release | The `apns-topic` for devices registered with `build_type: prod` (TestFlight, App Store): the store bundle id. A secret rather than a var because bundle ids stay out of this repo (plan D7). |
| `APNS_BUNDLE_ID_DEV` | iPhone dev client | The `apns-topic` for `build_type: dev` devices: the development bundle id. Set it. Unset means `APNS_BUNDLE_ID` + `.dev`, the app's own rule for its development builds (an `APNS_BUNDLE_ID` that already ends in `.dev` is used as it is), but a Worker from before that rule sends `dev` devices `APNS_BUNDLE_ID` itself; with both set, the order of setting secrets and deploying doesn't matter. |

A push credential unset: that platform and build still gets a token and signs in, but without a push credential it can't register for incoming calls. `/token` then answers `incoming_push: false` and logs `token_no_<secret name>` (for example `token_no_twilio_push_credential_apns_prod`) at `warn`, every 10 minutes at most per isolate.

An `APNS_*` secret a build needs unset: that build's iPhones get no text or email alerts, and `push_apns_not_configured` is logged at `warn`, naming the missing secrets, once an hour per isolate. Android is unaffected.

## Endpoints

App endpoints take `Authorization: Bearer <Supabase access token>` and answer `{ok:true, ...}` or `{ok:false, error:{code, message}}`. The codes are the SPEC's stable strings; the message is plain English. Twilio endpoints answer TwiML or 204.

| Endpoint | Notes |
|---|---|
| `POST /token` | Local JWT check, then one parallel round: `phone_caller_context`, the person's settings, and Auth's session check. Answers `recording: {on}` (the business recorded AND `CALL_RECORDING` on) and `features.recordings`. `incoming_push` is whether a phone's token carries its build's push credential (false: that secret is unset, so registering for incoming calls would fail; null for Chrome and preflight). `number` is the number this person's calls show (their own first, migration 266) and `numbers` every number of the business (DEVIATIONS 74). |
| `POST /voice/outbound` | 911/933/112 block, team and generation re-check, tenant check on `ContactId`, daily minute cap, caller ID = the builder's number, `answerOnBridge`, status callback on the `<Number>`. On a recorded business the `<Number>` also carries the announcement as its whisper `url` (`/voice/notice`) and the row is armed. |
| `POST /voice/inbound` | DND, busy, access, business hours in the route's time zone, `all_at_once` or `in_order`, the 911 callback rule, straight to voicemail when nobody is available. A member on DND who chose a cover hands their place to that teammate, who need not be on the answer list (migration 264, DEVIATIONS 70). Outside their own hours (`ring_hours`, in their zone, else the number's) a member is away in the same way; the business hours stay the outer gate (DEVIATIONS 71). On a recorded business the announcement is said before the first ring (or an after-hours forward), every `<Client>` carries `recorded=1`, and the row is armed; never for voicemail-only answers or the 911 callback window. |
| `POST /voice/notice` | The outbound whisper: the business's announcement, `<Say>` only. A read that fails still says the standard sentence. |
| `POST /voice/recording` | A call recording's status callback (204): `in-progress`, `completed` (queues the transcript), `absent`. Taken only for the row's own recording. |
| `GET /recordings/:id/audio` | A finished call recording, streamed from Twilio (one channel, both voices) after the voicemail rule for who may see the call. Bearer header only, Range passed through, never cached; 404 once retention deleted it. |
| `GET /calls/:id/transcript` | The call's transcript, read when someone presses "Show transcript" (`GET /calls` never carries it: the apps save those rows on the device, where a copy would outlive the business's retention). Same rule. |
| `POST /voice/after-dial` | Plan section 8 steps 1 to 4, decided by `DialBridged`. |
| `POST /voice/screen` | The press-1 screen for forwarded cells. |
| `POST /voice/status` | 204 first, then writes `phone_calls` in `waitUntil`. |
| `POST /voice/voicemail` | Record action (hangs up) and recording status callback (204). Files `phone_voicemails`. |
| `POST /voice/transcription` | `TRANSCRIBE=on` only: Twilio's transcribeCallback (204). Stores `phone_voicemails.transcript`. |
| `POST /voice/conference` | The conference status callback (`start`, `leave`), 204. `start` is recorded as `conference_started`: that, or the participant list, is how the Worker knows a conference has started, because Twilio's REST status can't say (DEVIATIONS 56). A customer left alone in the call's conference goes to voicemail (if they were waiting) or is hung up (if they were talking). The holding leg's own final status on `/voice/status` runs the same check as a backstop. |
| `POST /voice/greeting` | The ring that records someone's own voicemail greeting (migration 264, DEVIATIONS 72): `stage=ask` says what to do and `<Record>`s up to 60 s; `stage=saved` (the action, and with `cb=status` the recording's status callback) stores it over the old one and deletes that at Twilio; under 2 s is dropped; `stage=status` is the ring's own callback (204). |
| `GET /voice/greeting-audio` | What a voicemail's `<Play>` fetches for a person's own greeting: `?u=<user>&v=<recording sid>&key=`. The only GET Twilio path: its own constant-time key check, and only the sid stored for that person plays (404 otherwise). Streamed from Twilio as `audio/mpeg`. |
| `GET /voicemails/:id/audio` | Streams the MP3 from Twilio after checking the caller may see the call. Also takes `?access_token=`, only for extension builds from before 2026-09-29 that play it through `<audio src>` (DEVIATIONS 53). |
| `POST /calls/:id/transfer` | Cold transfer. `:id` may be the call id or the app leg's CallSid. Works from a plain call or from its conference. A teammate on DND, or outside their own hours, is not rung: their cover is, when they chose one who can take it, otherwise the customer goes to voicemail (DEVIATIONS 70, 71). That voicemail, and the one after a transfer nobody answers, plays the teammate's own greeting when they recorded one (DEVIATIONS 72). |
| `POST /calls/:id/hold`, `/resume` | Hold moves the call into a conference named after it (the customer hears hold music, you hear silence), or, in one already, holds the customer through the Participants API (also when nothing proves it started); resume brings you back. Answers `{ok, held, call_id}`. A Hold pressed while a Resume is still landing holds the customer as a participant, or says they are not held (DEVIATIONS 50). |
| `POST /calls/:id/warm-transfer` | `{to_user_id}`. Rings the teammate into the call's conference. From a plain call, when they answer all three of you talk, and you hang up when ready. From hold, the customer stays on hold while you and the teammate talk; Resume brings them in, and hanging up hands them to the teammate off hold. A teammate on DND, or outside their own hours (DEVIATIONS 71), is refused. Answers `customer_held` (a private consult or not); the teammate's app gets `customer_e164` and `contact_id`. A teammate who doesn't answer touches the row, so the apps hear at once and read `warm` on `GET /calls` (DEVIATIONS 47 to 51). A customer left alone because nobody answered goes to voicemail. Hold and both transfers are refused on inbound calls for an hour after a 911 call from the number. |
| `GET /media/:messageId/:index` | An inbound photo (or other file) from a text, streamed from Twilio after the thread's scope check. Bearer header only (SPEC section 3); `?access_token=` is refused. |
| `POST /calls/:id/events` | Client timing marks into `phone_call_events`. |
| `POST /calls/:id/handoff`, `/handoff/cancel`, `GET /calls/:id/handoff` | Move a live call to the person's other device (migration 260; apply it before deploying). `{to: chrome|mobile, leg_sid}` from the device holding the call. The phone is rung through Twilio (25 s, `handoff=1` custom parameters), the computer through the row's realtime broadcast. Nothing about the call changes until the other device answers; then the new leg joins the call's conference, a plain call is moved in, `client_call_sid` passes to the new leg, and only then is the old leg ended. A failure leaves the call where it was. Hold, Resume and both transfers are refused while a move is under way (`handoff_in_progress`). Outcomes are `device_switch` events (DEVIATIONS 57 to 60). |
| `GET /handoff/pending?for=chrome` | The computer's ring: a move to it, still ringing (45 s), on a call the caller holds. |
| `POST /voice/handoff` | Twilio: the phone answering a move. `/voice/outbound` with `HandoffCall` + `HandoffKey` is the computer answering, before every outbound rule (no new row, no minute cap, no wallet floor). |
| `POST /sms/send` | The CRM's checks, then `sendTenantSms` with `bypassQuietHours: true`, then tags the row with `client_temp_id` and `sent_via`. `media_urls` is refused: sending photos isn't built (the shared send has no media). |
| `GET /threads`, `/threads/:key`, `/calls`, `/search`, `/team` | Contacts row scope and phone level applied. Lists return `cursor` when there is another page. A live call in its conference carries `warm` (how its latest warm transfer stands). `/threads/:key` also returns the contact's `emails`, both ways and oldest first: mail stamped with the contact or about one of their designs, never sign-in codes, bodies as plain text cut at 8000 characters (`body_truncated`). Beside them, `compose`: the contact's `email_to`, and `email_block` when this person can't email them from the thread (`no_edit`, `no_crm`, `not_set_up`, `no_address`; `unknown_number` for an `n:` key, which has no email). Email is sent through portal-settings `crm_send_email`, not here. `GET /threads?channels=sms,email` builds the list from email too: `last.channel` says which, an email's `last.body` is its subject, and `e164` is null for someone who has only emailed and has no number on their record. `e164_source` says where the number came from: `sms` (their texts) or `contact` (their record). A `last` that is a customer's email carries `sender_verified` (false: its sender failed SPF, DKIM or DMARC; null: no verdict), so the apps skip alerting on a forged From, as `/push/email` does. Without the param the list is texts alone, exactly as before. Both read columns from migration 261: apply it before deploying. `GET /search?q=` finds contacts by name or 3+ digits of their number, and only ones with a number. With `&email=1` (2026-10-05, the phone app's New message) it matches the email address too and keeps a contact who has only an email: each row then carries `email` (null when there is none), and `e164` is null for an email-only one. Addresses are a second read whose matches come after the name and number ones, and only from 3 characters (or 2 with an `@`); a `+` in the address counts. Without the param the answer is exactly as before; the extension and the app's Contacts tab read it that way. |
| `POST /settings/me`, `/devices`, `/devices/signout-all` | Settings take `dnd`, `dnd_until`, `forward_to_cell`, `dnd_cover_user_id` (migration 264: a teammate with phone access on the same business, or null), and `ring_hours` with `ring_hours_tz` (migration 264: the hours your phone rings, null = always, checked by `_shared/phoneHours.ts`; hours need a zone and at least one day). Sign-out-all bumps `device_generation`, forgets push tokens and ends every Auth session. |
| `GET /settings/me` | Your own `{dnd, dnd_until, forward_to_cell, dnd_cover_user_id, ring_hours, ring_hours_tz, greeting}`, for the portal's "Your calls" card (the apps read them from `/token`, and here again after recording a greeting). `greeting` is `{set, updated_at}`, never the recording's sid. Phone access needed, the tenant's switch not. |
| `POST /settings/me/greeting/record`, `GET /settings/me/greeting/audio`, `POST /settings/me/greeting/clear` | Your own voicemail greeting (migration 264, DEVIATIONS 72). Record rings your own app (purpose=greeting, from the business number) to record it by phone: calling switched on and a business number needed, once per 30 s. Audio streams it, bearer header only. Clear goes back to the standard greeting and deletes the recording at Twilio, answering your settings. |
| `GET /quick-sends`, `POST /quick-sends`, `POST /quick-sends/:id`, `/:id/delete`, `/:id/used` | Each person's saved messages (migration 258; apply it before deploying these). The list gives the starter set first, once ever (`phone_seed_quick_sends`; a failure there is logged as `quick_send_seed_failed` and the list still answers). Add takes `{name, body, category?}`, at most 100 per person (`phone_add_quick_send` counts and inserts under a per-person lock, so a burst of adds can't pass it); change takes any of them. Every query is narrowed to the caller's `user_id` and `client_id`: someone else's id, or one that isn't a uuid, is `not_found`. `used` counts an Insert, not a send. Phone access is needed, the tenant's switch is not. |
| `POST /push/text` | Database webhook on new inbound `sms_messages` rows. |
| `POST /push/email` | Database webhook on new `email_inbound` rows (migration 267; deploy this Worker before applying it). The body carries `{id, client_id}` only; the Worker reads the row again by both, and alerts the people a text from that contact would (its owner, else everyone with phone access who can see them) with the contact's name and "Email: <subject>", `type` `email`, on the `texts` channel. Nothing for mail with no contact of the business (its own, or its design's), a sender whose SPF, DKIM or DMARC failed or that was flagged as spam, or a business whose phone is off. Never reads or sends the body. |
| `POST /log` | App errors into `app_errors`, severity kept. Sources `my-synergy-phone-extension` and `my-synergy-phone-mobile`, plus the two codes builds from before the 2026-10-01 rename still send (SETUP.md section 9: deploy this Worker before any renamed build ships). A report from the Chrome extension carries no direct identifier: `client_id` is null, `context` has `user_ref` and `client_ref` instead of `user_id`, only the context keys the extension is known to send (others are dropped and listed by name in `dropped`), and emails, phone numbers, uuids, Twilio identities and SIDs are `[redacted]` in the message, code and context (DEVIATIONS 64). Those rows are pseudonymous, not anonymous, so they and the Worker's own `edge:phone-api` rows are read only in summary (SETUP.md section 10). A mobile app report keeps `client_id` and `context.user_id`. |
| `GET /turn` | Twilio Network Traversal Service credentials. |
| `GET /health` | `{ok, version, deployment}`. |

Call recording (release B2, migration 263) adds to every call in `GET /calls` and `GET /threads/:key`: `recording` (`{id, duration_s, state: live | paused | processing | ready | failed}`, or null), `summary` (kept after retention deletes the audio and transcript) and `transcript_status` (`pending | done | failed`, or null; `done` means `GET /calls/:id/transcript` has words). The transcript itself is never on a call row, because both apps save those rows on the device. Hold pauses the recording and Resume resumes it; every redirect to voicemail stops it first. A transcript or summary is never logged, never put in `phone_call_events` and never put in `app_errors`.

Faults are logged through the shared `logEdgeError` and land in `app_errors` with source `edge:phone-api`. They carry business, call and sometimes contact or user ids, and they are written while the Worker serves the Chrome extension's users too, so they are read only in summary unless the person asks for help, for security or for the law (SETUP.md section 10). Refusals a stranger can trigger (a bad webhook key or signature) are logged at `info` and throttled. A fault on a Twilio endpoint answers 500 with no body so Twilio uses the Voice Fallback URL.
