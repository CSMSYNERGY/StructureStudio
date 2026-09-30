# phone-api

The SSS Phone Worker. It answers Twilio's call webhooks, mints Twilio Access Tokens for the Chrome extension and the phone app, sends texts through the shared texting rules, serves the apps' read endpoints, pushes text alerts to phones, and runs two crons: a recording sweep, and a daily job for voicemail retention and (once armed) billing. It also handles hold and warm transfer (plan 9C, design b), voicemail transcription, and inbound photos.

The contract is `docs/SPEC.md` in the private `structure-studio-phone` repo, section 3. The product plan is `_Extras/Structure Studio Phone Plan 2026-09-28.md` in the vault. Where this Worker reads the contract a particular way, `DEVIATIONS.md` says so. The one-time setup is in `SETUP.md`.

This repo is public. No secret, client name, phone number or SID goes in any file here, tests included. Every credential below is a `wrangler secret`.

## Layout

```
src/index.ts          router: /voice/* (Twilio), /push/text (DB webhook), everything else (apps), crons
src/routes/voice.ts   outbound, inbound, after-dial, screen, status, voicemail
src/routes/token.ts   POST /token
src/routes/calls.ts   cold transfer, call events, voicemail audio
src/routes/conference.ts  hold, resume, warm transfer (the app endpoints)
src/routes/media.ts   GET /media/:messageId/:index (inbound photos)
src/routes/sms.ts     POST /sms/send
src/routes/reads.ts   /threads, /threads/:key, /calls, /search, /team
src/routes/me.ts      /settings/me, /devices, /devices/signout-all, /log, /turn, /health
src/routes/push.ts    /push/text (FCM HTTP v1, APNs)
src/cron/             sweep.ts (*/15), retention.ts and usageDebit.ts (daily, 09:00 UTC: minute debit, monthly line fee)
src/conference.ts     the conference design: TwiML, which leg is which, the transfer_state machine, /voice/conference
src/callEvents.ts     what phone_call_events say that the row cannot: a warm transfer's state, a Resume still landing
src/voicemail.ts      the greeting + <Record> TwiML (and transcription)
src/wallet.ts         the wallet floor for outbound calls
src/jwt.ts            Supabase login check (ES256 via JWKS, cached per isolate)
src/twilioSignature.ts  ?key= always, X-Twilio-Signature whenever TWILIO_AUTH_TOKEN is set
src/accessToken.ts    Twilio Access Token (HS256, cty twilio-fpa;v=1)
src/scope.ts          contacts row scope and "mine", reusing _shared/access.ts
```

It imports three files from `supabase/functions/_shared`: `smsSend.ts` (and through it `twilioSms.ts`, `smsQuietHours.ts`, `logError.ts`) and `access.ts`. Those files are written for Deno. Wrangler's `alias` maps their `jsr:@supabase/supabase-js@2` import onto the npm package installed here, and `src/env.ts` installs a `Deno.env.get` shim over the Worker's env, so they read the same secret names they read on the edge functions. Nothing under `supabase/functions` is edited for this. After a change to any of those shared files, redeploy this Worker along with the edge functions that import them.

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

## Vars (wrangler.jsonc, not secret)

| Var | Default | What it does |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://phone.structurestudiosuite.com` | Every URL handed to Twilio is built from it. Use the workers.dev URL until the phone. routes exist. |
| `EMERGENCY_MODE` | `block` | `block` answers 911, 933 and 112 with "For emergencies, call 9 1 1 from your cell phone." Only the exact value `allow` lets 911 and 933 through (phase 6, needs registered emergency addresses). |
| `DAILY_MINUTE_CAP` | `600` | Outbound minutes per builder per UTC day, each call rounded up. `0` turns the cap off. |
| `EXTENSION_ORIGINS` | empty | Chrome extension ids (or full `chrome-extension://` origins), comma separated, allowed by CORS. The portal origins (app., beta., beta-2-0.) are built in. |
| `PHONE_USAGE_METERS` | `off` | Release 2. The daily minute debit runs only when this is `on` and the `voice_minute` meter is active and priced; the monthly line fee only when this is `on` and `phone_line_monthly` is active and priced. |
| `VOICEMAIL_RETENTION_DAYS` | `365` | Recordings older than this are deleted at Twilio by the daily job. Minimum 30. |
| `TRANSCRIBE` | `off` | Release 2. `on` adds Twilio transcription to every voicemail (`<Record transcribe>`, about $0.05 a minute, English, 2 s to 2 min); the text lands in `phone_voicemails.transcript` and on the call's `voicemail` summary. |
| `WALLET_FLOOR_CENTS` | `500` | Outbound calls are refused ("Your Structure Studio wallet is empty...") when the wallet's spendable balance is below this, but only while the `voice_minute` meter is active and priced. Exempt tenants, inbound calls and 911 are never refused. |

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
| `TWILIO_PUSH_CREDENTIAL_APNS_SANDBOX` | phase 4 | Push credential for iPhone development-profile builds. |
| `TWILIO_PUSH_CREDENTIAL_APNS_PROD` | phase 4 | Push credential for TestFlight and App Store builds. |
| `TWILIO_PUSH_CREDENTIAL_FCM` | phase 4 | Push credential for Android. |
| `PHONE_WEBHOOK_SECRET` | yes | The `?key=` on every Twilio URL this Worker serves. Use letters and digits only (32 or more). If it is missing, every Twilio request is refused (503), and Twilio falls back to the number's Voice Fallback URL. |
| `SMS_INBOUND_SECRET` | yes | Same value as on the edge functions. Texts sent from the apps carry it on their `sms-status` callback URL. |
| `PUSH_WEBHOOK_SECRET` | yes | The `x-push-secret` header the database webhook sends to `/push/text`. |
| `FCM_SERVICE_ACCOUNT_JSON` | phase 4 | The Firebase service account JSON, whole. Android text alerts. Unset means they are skipped and logged once an hour. |
| `APNS_KEY_P8` | phase 4 | The APNs auth key (.p8 text). iPhone text alerts. |
| `APNS_KEY_ID` | phase 4 | That key's id. |
| `APNS_TEAM_ID` | phase 4 | The Apple team id. |
| `APNS_BUNDLE_ID` | phase 4 | The `apns-topic` for devices registered with `build_type: prod`. A secret rather than a var because bundle ids stay out of this repo (plan D7). |
| `APNS_BUNDLE_ID_DEV` | later | The `apns-topic` for `build_type: dev` devices. Unset means `APNS_BUNDLE_ID` is used for them too, which is right while both builds share the `.dev` bundle id (the individual Apple account). Set it when production moves to the final bundle id. |

## Endpoints

App endpoints take `Authorization: Bearer <Supabase access token>` and answer `{ok:true, ...}` or `{ok:false, error:{code, message}}`. The codes are the SPEC's stable strings; the message is plain English. Twilio endpoints answer TwiML or 204.

| Endpoint | Notes |
|---|---|
| `POST /token` | Local JWT check, then one parallel round: `phone_caller_context`, the person's settings, and Auth's session check. |
| `POST /voice/outbound` | 911/933/112 block, team and generation re-check, tenant check on `ContactId`, daily minute cap, caller ID = the builder's number, `answerOnBridge`, status callback on the `<Number>`. |
| `POST /voice/inbound` | DND, busy, access, business hours in the route's time zone, `all_at_once` or `in_order`, the 911 callback rule, straight to voicemail when nobody is available. |
| `POST /voice/after-dial` | Plan section 8 steps 1 to 4, decided by `DialBridged`. |
| `POST /voice/screen` | The press-1 screen for forwarded cells. |
| `POST /voice/status` | 204 first, then writes `phone_calls` in `waitUntil`. |
| `POST /voice/voicemail` | Record action (hangs up) and recording status callback (204). Files `phone_voicemails`. |
| `POST /voice/transcription` | `TRANSCRIBE=on` only: Twilio's transcribeCallback (204). Stores `phone_voicemails.transcript`. |
| `POST /voice/conference` | The conference status callback (`start`, `leave`), 204. `start` is recorded as `conference_started`: that, or the participant list, is how the Worker knows a conference has started, because Twilio's REST status can't say (DEVIATIONS 56). A customer left alone in the call's conference goes to voicemail (if they were waiting) or is hung up (if they were talking). The holding leg's own final status on `/voice/status` runs the same check as a backstop. |
| `GET /voicemails/:id/audio` | Streams the MP3 from Twilio after checking the caller may see the call. Also takes `?access_token=`, only for extension builds from before 2026-09-29 that play it through `<audio src>` (DEVIATIONS 53). |
| `POST /calls/:id/transfer` | Cold transfer. `:id` may be the call id or the app leg's CallSid. Works from a plain call or from its conference. |
| `POST /calls/:id/hold`, `/resume` | Hold moves the call into a conference named after it (the customer hears hold music, you hear silence), or, in one already, holds the customer through the Participants API (also when nothing proves it started); resume brings you back. Answers `{ok, held, call_id}`. A Hold pressed while a Resume is still landing holds the customer as a participant, or says they are not held (DEVIATIONS 50). |
| `POST /calls/:id/warm-transfer` | `{to_user_id}`. Rings the teammate into the call's conference. From a plain call, when they answer all three of you talk, and you hang up when ready. From hold, the customer stays on hold while you and the teammate talk; Resume brings them in, and hanging up hands them to the teammate off hold. A teammate on DND is refused. Answers `customer_held` (a private consult or not); the teammate's app gets `customer_e164` and `contact_id`. A teammate who doesn't answer touches the row, so the apps hear at once and read `warm` on `GET /calls` (DEVIATIONS 47 to 51). A customer left alone because nobody answered goes to voicemail. Hold and both transfers are refused on inbound calls for an hour after a 911 call from the number. |
| `GET /media/:messageId/:index` | An inbound photo (or other file) from a text, streamed from Twilio after the thread's scope check. Bearer header only (SPEC section 3); `?access_token=` is refused. |
| `POST /calls/:id/events` | Client timing marks into `phone_call_events`. |
| `POST /sms/send` | The CRM's checks, then `sendTenantSms` with `bypassQuietHours: true`, then tags the row with `client_temp_id` and `sent_via`. `media_urls` is refused: sending photos isn't built (the shared send has no media). |
| `GET /threads`, `/threads/:key`, `/calls`, `/search`, `/team` | Contacts row scope and phone level applied. Lists return `cursor` when there is another page. A live call in its conference carries `warm` (how its latest warm transfer stands). |
| `POST /settings/me`, `/devices`, `/devices/signout-all` | Sign-out-all bumps `device_generation`, forgets push tokens and ends every Auth session. |
| `POST /push/text` | Database webhook on new inbound `sms_messages` rows. |
| `POST /log` | App errors into `app_errors`, severity kept. |
| `GET /turn` | Twilio Network Traversal Service credentials. |
| `GET /health` | `{ok, version, deployment}`. |

Faults are logged through the shared `logEdgeError` and land in `app_errors` with source `edge:phone-api`. Refusals a stranger can trigger (a bad webhook key or signature) are logged at `info` and throttled. A fault on a Twilio endpoint answers 500 with no body so Twilio uses the Voice Fallback URL.
