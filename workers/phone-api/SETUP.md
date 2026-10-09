# Setting up phone-api (runbook for a person)

No agent deploys, configures Twilio or touches the live database for this build. Everything below is for Ahsan to do by hand, in this order. Placeholders in angle brackets are values you hold; none of them belong in this repo.

`<BASE>` below is the Worker's public URL: `https://phone.structurestudiosuite.com` once step 5 is done, `https://phone-api.<your-subdomain>.workers.dev` before that.

## 0. Before you start

- The Cloudflare account is on Workers Paid ($5/month). The free plan's 10 ms CPU and 50-subrequest caps are too tight for this.
- Migration `254_sss_phone.sql` is applied, and `portal-settings` with the `phone` access area (`_shared/access.ts`) is deployed. The Worker calls `phone_caller_context`, `phone_route_for_number` and `crm_visible_contact_ids`, and reads the new columns.
- The pilot tenant's switch is on (and nobody else's):
  ```sql
  update public.client_settings set phone_status = 'on' where client_id = '<pilot client id>';
  ```

## 1. Build and test locally

From `workers/phone-api`:

```
npm ci
npm test
npm run typecheck
npx wrangler deploy --dry-run --outdir dist
```

All four must pass. The dry run prints the bindings and "exiting now"; it uploads nothing.

## 2. Twilio console

1. The auth token (Console, Account info). Twilio's API never returns it, so only a person can copy it. If you can, set `TWILIO_AUTH_TOKEN` in step 3: the Worker then requires the `?key=` AND a valid `X-Twilio-Signature` on every webhook. Without it the Worker still works, on the `?key=` alone (the request's `AccountSid` must also be ours), and logs `twilio_signature_skipped` at `warn` once per isolate so the gap stays visible. `PHONE_WEBHOOK_SECRET` is what it can never run without. This deployment has had an empty token on the edge functions before, so check the value is real, not just present.
2. Create a Standard API key (Account, API keys). Keep its SID and secret for step 3.
3. Create the calls TwiML App, "My Synergy Phone calls":
   - Voice request URL: `<BASE>/voice/outbound?key=<PHONE_WEBHOOK_SECRET>`, POST
   - Voice status callback URL: `<BASE>/voice/status?leg=client&key=<PHONE_WEBHOOK_SECRET>`
   - Voice fallback URL: a TwiML Bin that says "Calling is having a problem. Please try again or use your cell." and hangs up.
4. Create the setup-test TwiML App, "My Synergy Phone setup test", whose voice URL is a TwiML Bin containing `<Response><Echo/></Response>`.
5. Voice geo permissions: United States and Canada only, with premium and high-risk numbers blocked.
6. The pilot number (Phone numbers, the number, Voice configuration):
   - A call comes in: Webhook `<BASE>/voice/inbound?key=<PHONE_WEBHOOK_SECRET>`, POST
   - Call status changes: `<BASE>/voice/status?leg=pstn&key=<PHONE_WEBHOOK_SECRET>`
   - Primary handler fails: a TwiML Bin that plays the standard greeting and records, with the `<Record action>` pointing at a second Bin that only hangs up. The every-15-minutes sweep files those messages.
   Leave the messaging configuration exactly as it is; texts stay on `sms-inbound` and `sms-status`.
7. Phase 4 only: the push credentials (FCM; and for iPhone, one `apn` credential per bundle id, each from that id's VoIP Services certificate, both with Sandbox UNTICKED: EAS signs every iPhone build, the development client included, for production push. README's secret table says which is which).

## 3. Secrets

From `workers/phone-api`, run `npx wrangler secret put <NAME>` for each secret in README.md. For the webhook secrets, generate letters and digits only, 32 or more (a character that needs URL encoding makes signature checks fragile):

```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

`SMS_INBOUND_SECRET` must be the same value the edge functions use. The phase 4 secrets (push credentials, Firebase, APNs) can wait; until they are set, text alerts are skipped and logged once an hour.

`LOG_PSEUDONYM_KEY` is the key for the Chrome extension's error reports (section 10). Generate it the same way, save it in the password manager FIRST (Cloudflare never shows a secret again, and without the copy nobody can find a person's reports when they ask for help), then set it:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put LOG_PSEUDONYM_KEY
```

Paste the value at the prompt. Set it once and leave it: a new key gives everyone new refs, so a person's reports from before the change can only be found with the old key.

APNs: set `APNS_BUNDLE_ID` to the App Store bundle id, the topic for `prod` devices (preview, TestFlight and App Store builds), and `APNS_BUNDLE_ID_DEV` to the development client's id, the topic for `dev` devices. Unset, the Worker derives the dev topic as `APNS_BUNDLE_ID` + `.dev`, but an older Worker doesn't, so set both. The key (`APNS_KEY_P8`, `APNS_KEY_ID`): in the Apple Developer account, Certificates, IDs & Profiles, Keys, a new key with Apple Push Notifications service, team scoped (all topics) and enabled for Production. Every iPhone alert goes to Apple's production host, so a key made for Sandbox alone is refused. Secrets set with a pasted newline are trimmed.

## 4. First deploy, on workers.dev

```
npx wrangler deploy --var PUBLIC_BASE_URL:https://phone-api.<your-subdomain>.workers.dev
```

Then check it answers:

```
curl https://phone-api.<your-subdomain>.workers.dev/health
```

## 5. The phone. hostname

The zone's tenant wildcard route (`*.structurestudiosuite.com/*`) outranks a custom domain, which is what broke `beta-2-0` and `www` before. So the Worker needs both a custom domain and an explicit zone route:

1. In `wrangler.jsonc`, uncomment the `routes` block (both lines).
2. Deploy again without the `--var` override: `npx wrangler deploy`.
3. Check the Worker answers, not the portal's 404 page:
   ```
   curl https://phone.structurestudiosuite.com/health
   ```
   You should see `{"ok":true,"version":...}`.
4. Make sure `phone` can never be taken as a tenant subdomain.
5. Update the Twilio URLs from step 2 to `https://phone.structurestudiosuite.com/...` if you set them to workers.dev.

## 6. The database webhooks for text and email alerts

The webhooks are triggers in the repo, not Dashboard webhooks:

1. Put the push secret in Supabase Vault, the SAME value as the Worker's `PUSH_WEBHOOK_SECRET`:
   `select vault.create_secret('<PUSH_WEBHOOK_SECRET>', 'sss_phone_push_secret', 'x-push-secret for phone-api /push/text');`
2. Apply `supabase/migrations/256_sss_phone_push_webhook.sql` (by hand, `--file`, then record 256 in the ledger).
3. Set the Worker's `FCM_SERVICE_ACCOUNT_JSON` (Android) and the APNS_* secrets (iPhone).
4. Email alerts (2026-10-05), once texts work: deploy a Worker that has `POST /push/email`, check the live copy has it (the marker `push_email_failed` in the downloaded bundle) and `/health`, make sure the app's privacy page says what an email alert shows, then apply `supabase/migrations/267_phone_push_email.sql` the same way. It uses the same Vault secret: nothing new to create. Its own probe prints what it checked; its AFTER APPLYING block has the read-backs.

Do NOT also create a Dashboard "Database Webhook" on sms_messages or email_inbound: 256 and 267 already are those webhooks, and a second one sends every alert twice (and stores the secret in plain text). Never add the `net` schema to the API's exposed schemas.

## 7. The pilot line

Mark the number as a voice line and give it a route. Until a `phone_routes` row exists, every inbound call goes to voicemail.

```sql
update public.sms_numbers
   set voice_enabled = true, voice_configured_at = now()
 where phone_number = '<pilot number, E.164>' and released_at is null;

insert into public.phone_routes (client_id, number_id, members)
select n.client_id, n.id, array['<owner user_id>'::uuid]
  from public.sms_numbers n
 where n.phone_number = '<pilot number, E.164>' and n.released_at is null;
```

Once the portal's Phone tab ships, it owns these settings.

## 7b. Release 2 switches (all off until you turn them on)

- **Voicemail transcription:** set the var `TRANSCRIBE` to `on` (wrangler.jsonc, then deploy). Twilio charges about $0.05 a minute; nothing bills the `voicemail_transcription` meter yet.
- **Call and text charges (migration 259):** apply 259 BEFORE deploying a Worker that has `src/cron/usageCharge.ts`. From deploy day the Worker records each call's and text's Twilio cost as a `shadow` row in `usage_charges` (`PHONE_USAGE_COST_CAPTURE`, ships `on`) and charges nothing. To charge, ALL of: `PHONE_USAGE_METERS` = `on` (wrangler.jsonc, then deploy; and as a Supabase function secret for texts sent from the portal), `phone_billing_settings.markup` and `armed_at` set, and the meter (`voice_minute`, `voice_minute_in`, `sms_segment`, `sms_in`) active or the tenant in `pilot_client_ids`. **Order matters: turn `PHONE_USAGE_METERS` on (Worker and function secret) FIRST, then set `armed_at`.** With `armed_at` still empty the rail charges nothing, but a call or text after `armed_at` that the Worker settles while its rail is still `off` becomes a final `shadow` row and is never charged. Arm on Admin › Billing (section 7e has the order and Carolyn's prices), not with the SQL at the bottom of migration 259, which predates the card. The Billing tab already labels `cost_plus` meters ("Billed per call minute", "Billed per text").
- **Wallet floor:** outbound calls and texts are refused below `phone_billing_settings.floor_cents` (default 500), on the same rails as the charges above. Exempt tenants, inbound calls and 911 are never refused.
- **Auto top-up from the Worker:** the charges and the refusals ask the `wallet-autotopup` edge function for a top-up. Set the Supabase function secret `WALLET_AUTOTOPUP_SECRET` to the exact value of this Worker's `SUPABASE_SERVICE_ROLE_KEY`. If that key is a new-format `sb_secret_...` key (not a JWT), set `verify_jwt = false` for `wallet-autotopup` in `supabase/config.toml`, or the gateway refuses every request.
- **Monthly line fee:** needs BOTH `PHONE_USAGE_METERS` = `on` and `phone_line_monthly` active and priced. Check first that the Billing tab labels that meter kind. ⚠️ It charges for the same number the monthly number fee below already charges for: before pricing it, make it skip numbers that pay `sms_number_monthly` (`src/cron/lineFee.ts` header).
- **Monthly number fee (months 2 and on):** `src/cron/numberFee.ts`, at 09:00 UTC, on ONE switch: `usage_prices` `sms_number_monthly` active and priced. That is the same row the purchase's first month is held on, so arming it (`update public.usage_prices set active = true where kind = 'sms_number_monthly';`) arms every month at once; `PHONE_USAGE_METERS` is not read. Each live number is charged on the day of the month it was bought (clamped to the month's last day), keyed `sms_number_monthly:<number id>:m<n>`, current month only: arming late never bills the months before. After the first 09:00 run, look for `sms_number_fee_failed` (a charge to retry; the next run does) and `sms_number_fee_no_tenant` (a live number whose tenant was deleted: release it at Twilio) in the grouped error query (section 10).
- **Hold and warm transfer** need nothing switched on, but prove them on a real call in both directions (step 8) before anyone uses them with a customer.

## 7c. Call recording, transcripts and summaries (release B2, all off until you turn them on)

Nothing records until ALL of: migration 263 applied, this Worker deployed with `CALL_RECORDING` = `on`, and the business's own switch on in Settings › Phone. Transcripts and summaries also need `CALL_TRANSCRIBE` = `on` and the business leaving transcripts on.

> **Since migration 287 (Carolyn, 2026-10-06) every business's switch is ON by default**, so the steps below that assume "nobody has turned it on yet" (step 4's check, and turning it on for the test business only) no longer hold: with the rail on, every business with calling on is recorded from its next call. The first time the rail goes on is section 7d, not step 4.

`CALL_RECORDING` lives in two places, always set together: this Worker's var (the rail that records) and a Supabase function secret of the same name, which `portal-settings` reads so the Settings card can say whether calls really are recorded (the database can't see the Worker's vars). `CALL_TRANSCRIBE` lives in two places the same way: its function secret is what lets the card say "and transcribed" and promise transcripts. Unset reads as off. In this order:

1. **Migration 263** (`supabase/migrations/263_phone_call_recording.sql`), by hand, as its header says. It must land BEFORE this Worker (which reads `phone_calls.recording_armed` on every call and embeds `phone_call_recordings` in `GET /calls`) and before the edge function.
2. **The edge function `phone-call-summary`** (`npx supabase functions deploy phone-call-summary`). It reads `ANTHROPIC_API_KEY` (already a project secret) and answers only the service role. Set the function secret `PHONE_SUMMARY_SECRET` to the exact value of this Worker's `SUPABASE_SERVICE_ROLE_KEY` (the Worker holds its own key; the runtime's may differ). If that key is a new-format `sb_secret_...` key (not a JWT), the gateway refuses every request while `verify_jwt = true`. Then, in this order: set `PHONE_SUMMARY_SECRET` to that key, change `gatewayVerified: true` to `false` in `phone-call-summary/summary.ts` (with `verify_jwt` off, its service_role claim door is forgeable by anyone), and only then set `verify_jwt = false` for `phone-call-summary` in `supabase/config.toml` and deploy. `tests/phone/callSummary_test.ts` refuses the one without the other.
   Then **portal-settings** (`npx supabase functions deploy portal-settings`), with its `CALL_RECORDING` secret still unset: it saves the owner's settings (`phone_recording_save`) and builds the contact timeline, whose `_shared/crmFeed.ts` now reads each call's recording and summary. crmFeed's other importer is this Worker (`src/emailThread.ts`), deployed next; so is that of the new `_shared/recordingNotice.ts` (the announcement rule: portal-settings' `phone.ts` and this Worker's `src/recording.ts`).
   And **admin-catalog** (`npx supabase functions deploy admin-catalog`), the only importer of the changed `_shared/phoneBillingAdmin.ts`: the phone usage report counts call minutes from calls only (a recording and its transcript are per minute too) and leaves transcript costs (Workers AI, Claude) out of the comparison with Twilio's bill.
3. **This Worker**, with `CALL_RECORDING` and `CALL_TRANSCRIBE` still `off` and the `ai` binding in `wrangler.jsonc` (Workers AI; billed to the account, no key). Deploy and check `app_errors` as usual.
   Then the phone app (its player, summary, transcript and "Recorded call" chip); it is safe against a Worker that has nothing to show yet. NOT the portal yet: its Settings card is where owners turn recording on, and every business that does is recorded the moment the rail goes on in step 4.
4. **The verification call** (plan section 13, step 8; it places a real call on our own test tenant, so it needs a go-ahead). Superseded by 7d, where recording goes on for everyone and transcripts stay off; kept as the record of what B2 set out to prove. First check that nobody but the test business has turned recording on:
   `select client_id from public.client_settings where phone_record_calls;`
   It must return no rows, or only the test business. If any other business shows up, stop and ask before going on. Then turn `CALL_RECORDING` and `CALL_TRANSCRIBE` on, deploy, set both function secrets too (`npx supabase secrets set CALL_RECORDING=on CALL_TRANSCRIBE=on`), turn recording on for the test business only (`update public.client_settings set phone_record_calls = true, phone_recording_updated_at = now() where client_id = '<the test business>';`), and prove: one recording through hold, resume, warm and cold transfer and a device switch; it stops before a voicemail redirect; which channel is the customer (`CHANNEL_MAP` in `src/recording.ts`, change it if Twilio puts them the other way); the MP3 downloads as two channels with `RequestedChannels=2`; nova-3 takes it, and how it bills two channels; the outbound whisper plays inside the recording; the time from hang-up to summary.
5. **The portal** (the Settings › Phone "Call recording" card and the timeline's player, summary and transcript) on beta, once the call is proved. Ask before promoting. With the rails on, an owner who turns recording on is recorded from their next call, and the card says so.
6. Leave both rails `on` (the Worker var and the function secret) once proved; each business's owner decides for their own calls. The meters `call_recording` and `call_transcription` ship inactive and invisible: until Carolyn prices and activates them (the 259 ARMING notes, plus `update public.usage_prices set active = true where kind in ('call_recording', 'call_transcription')`), each recording and transcript is a `shadow` row with its cost. A pilot of call and text billing (259 ARMING step 2) does not charge them: migration 263 limits the pilot list to the four call and text meters.

To stop everything at once: set `CALL_RECORDING` (and `CALL_TRANSCRIBE`, if it is on) to `off` in `wrangler.jsonc`, deploy (every other rail as the live version has it), commit that file to beta, staged by name, so the next deploy of this Worker by anyone keeps them off (7e, "One file, two rails"), and set the function secrets to `off` too (`npx supabase secrets set CALL_RECORDING=off`, plus `CALL_TRANSCRIBE=off` if it was set) so the Settings card stops saying calls are recorded or transcribed. Calls are no longer announced or recorded; recordings already made still play and still expire with each business's retention (daily, 09:00 UTC).

## 7d. Recording on by default (migration 287; Carolyn, 2026-10-06)

Carolyn's answers of 2026-10-06: recording is on for every builder unless the business owner turns it off; callers hear "This call may be recorded."; recordings are kept one year (365 days, as voicemail: already the column default and the value on every row, and the daily job deletes them on that day); transcripts and summaries stay off; and the recording cost is absorbed, not billed (the `call_recording` meter stays inactive and invisible; each recording is still written to `usage_charges` with its cost, as `shadow`, or as `exempt` on a business that isn't billed).

With 287 applied and the rail on, EVERY business with calling on is announced and recorded from its next call, with no click of its own. So the rail goes on last, and only after the disclosures say so. Each numbered step below waits for the one before it.

0. **Prerequisites (Ahsan; publishing needs his explicit OK).** Until all of these are live, the rail stays `off`:
   - the updated My Synergy Phone privacy policy (phone repo `site/public/my-synergy-phone/privacy.html`, and `docs/extension-privacy-policy.md` for the Chrome listing): recording is on unless the business owner turns it off, and callers hear "This call may be recorded.";
   - Google Play: the description's "Calls are not recorded." line, and the Data safety Audio row (call recordings are collected and stored, not ephemeral); the Chrome Web Store listing if it says the same; the App Store description's privacy paragraph and App Privacy Audio row;
   - recommended, not blocking: `TWILIO_AUTH_TOKEN` set on this Worker, so recording callbacks are signed and each one skips the extra Twilio read (DEVIATIONS 66).
1. **Migration 287** (`supabase/migrations/287_phone_record_calls_default_on.sql`), by hand, as its header says. Live for beta and production at once. Nothing records (the rail is off); the one business with calling on now shows "On, not started yet" on its card. Read back:
   `select column_default from information_schema.columns where table_schema = 'public' and table_name = 'client_settings' and column_name = 'phone_record_calls';` gives `true`, and
   `select count(*) filter (where phone_record_calls) as rec_on, count(*) filter (where phone_recording_updated_at is not null) as touched, count(*) as total from public.client_settings;` gives rec_on = total and touched 0 (unless an owner has saved since).
2. **portal-settings** (the new sentence, and the card's transcripts rail). Re-fetch origin/beta, diff the live function against it (other sessions edit `index.ts`), deploy (`npx supabase functions deploy portal-settings`), then download the live copy and grep it for `This call may be recorded.` `phone.ts` has no other importer, and `_shared/recordingNotice.ts` did not change. Leave the function secrets `CALL_RECORDING` and `CALL_TRANSCRIBE` unset (unset reads off).
3. **The portal** (the Settings › Phone card) to beta, where it auto-deploys. Production only on a promotion, which needs Ahsan, and step 4 waits for it. Until then production's card builds the old sentence itself: "This call will be recorded and transcribed." for a business with transcripts on (every business, by default), with a promise of transcripts a minute or two after each call. With the rail on, callers would hear "This call may be recorded." and no transcript would ever be made.
4. **This Worker with the rail on** (after step 0 and step 3's production promotion, on Ahsan's go). From a fresh origin/beta tree that holds the live version's source (re-fetch, and diff the live version against the branch first: other batches deploy this Worker too, so deploy one at a time, from a tree holding every merged change), set `CALL_RECORDING` to `"on"` in `wrangler.jsonc` and change nothing else (`CALL_TRANSCRIBE` stays `"off"`; every other rail, `PHONE_USAGE_METERS` included, as the live version has it). Commit that file to beta, staged by name, so the next deploy of this Worker by anyone keeps the rail on (7e, "One file, two rails"). Deploy with an explicit config path (`npx wrangler deploy --config <absolute path>/workers/phone-api/wrangler.jsonc`). Confirm with `npx wrangler versions view <new version id>`: `CALL_RECORDING` "on", `CALL_TRANSCRIBE` "off". `/health` answers 200.
5. **Immediately after**, from the repo root: `npx supabase secrets set CALL_RECORDING=on`, so the card says "Calls are recorded". Never before step 4: the card must not say calls are recorded before the Worker records them. Do NOT set `CALL_TRANSCRIBE` or `PHONE_SUMMARY_SECRET`. `npx supabase secrets list` shows `CALL_RECORDING`.
6. **One verification call, own numbers only** (Ahsan places it). Never call or text a customer, and never ring Carolyn's line. One OUTBOUND call from Ahsan's own My Synergy Phone login on the business with calling on, to a phone he controls (and that Twilio's geo permissions allow). Outbound rings no teammate, so any hour works. Prove, reading statuses and counts only, never content:
   - the callee hears "This call may be recorded." on pickup;
   - Hold, then Resume: the `phone_call_recordings` row goes `paused`, then `recording`;
   - after hang-up: `phone_calls.recording_armed` is true; the recording row is `completed` with `recording_sid` set, `channels` 2, `duration_s` > 0 and `transcript_status` `off`;
   - `phone_call_events` has `recording_notice`, `recording_started` and `recording_completed`;
   - Play works on the contact's timeline in the portal and in the app;
   - within about 10 minutes, a `usage_charges` row with source `recording`, state `pending` at first. Twilio prices nothing on this account today, so it waits out `fallback_after_hours` (6 hours now, 1 hour after 7e step 1) and then settles on the estimate (`cost_source` `estimate`, `RECORDING_MIN_MICROS` a minute), or sooner with `cost_source` `twilio` if Twilio prices it first. On the demo business, which isn't billed, it settles as `exempt`; `shadow` only on a business that is billed. Then check `cost_micros` > 0.
   Note which channel Twilio put the customer on (`CHANNEL_MAP` in `src/recording.ts`); it only matters once transcripts are on. The inbound announcement is covered by `test/recording.test.ts`; a live inbound check rings everyone on the route (Carolyn too), so only in her US daytime and with a heads-up.
   Then the section 10 summary query for `edge:phone-api`, codes `recording_start_failed`, `recording_callback_unverified` and `recording_notice_read_failed`: counts only, and resolve only our own test rows. Optional clean-up: delete the test call's row (its recording row goes with it) and its audio at Twilio by SID; otherwise retention deletes it in 365 days.
7. **The work log** (`SSS Phone.md`): the arming time, the verification result, and that the platform default turned recording on by Carolyn's decision of 2026-10-06 (287 leaves `phone_recording_updated_by` NULL on those rows), for any later question about consent.

**Kill switch.** `CALL_RECORDING` back to `"off"` in `wrangler.jsonc` (every other rail as the live version has it), deploy, commit that file to beta, staged by name, so the next deploy of this Worker by anyone keeps it off (7e, "One file, two rails"), then `npx supabase secrets set CALL_RECORDING=off`. Until that commit lands, anyone about to deploy this Worker stops and asks first: a tree that still says "on" turns recording back on for every business without a word, while the Settings card says it hasn't started. Calls stop being announced and recorded at once; recordings already made still play and still expire. The database default can stay: it does nothing while the rail is off (287's ROLLBACK is there if it has to go too, and then the rail goes off FIRST).

**Transcripts and summaries stay off.** Turning them on later is a separate decision with its own cost: Workers AI at about $0.0052 an audio minute, both channels billed (about $0.0104 a call minute), plus about $0.005 to $0.02 per call for the Claude summary. It needs `CALL_TRANSCRIBE` "on" here AND the function secret `CALL_TRANSCRIBE=on` (portal-settings mirrors it, so the card's sentence and its transcripts promise follow), `PHONE_SUMMARY_SECRET` (section 7c, step 2), the App Store's in-app third-party AI notice (guideline 5.1.2(i)) in a new app build, and the privacy pages' transcript paragraph checked again. Callers would then hear "This call may be recorded and transcribed.", which Carolyn has not approved. Every business's `phone_transcribe_calls` defaults to true, so that rail would transcribe everyone at once.

**What we absorb.** Twilio charges about $0.0025 a recorded minute, plus storage once past Twilio's free allowance, which builds up under one-year retention. At today's volume (about 22 talk minutes in 30 days) that is under $0.10 a month. The `usage_charges` rows with source `recording` show the running cost (`exempt` on the demo business, `shadow` on any other).

## 7e. Call and text charges go live (Carolyn, 2026-10-06)

Carolyn's answers of 2026-10-06: each call and text is charged to the builder's wallet at its cost × 1.25. The cost is Twilio's own price when Twilio returns one, and otherwise Twilio's published US rate (the fallback rates, which already equal it; checked 2026-10-06). The 25% is the whole margin. `phone_billing_settings.markup` is the only multiplier and nothing stacks on it. It applies to the whole cost: every leg, the carrier fee, and the conference and voicemail estimates. It stays 1.25 when Twilio starts returning real prices. Not charged: call recordings and transcripts (`call_recording` and `call_transcription` stay inactive; we absorb about $0.0025 a recorded minute, section 7d), missed calls that left no voicemail (`bill_unanswered_calls` stays off; a voicemail is charged, as now), and the monthly number fee (`sms_number_monthly` and `phone_line_monthly` stay inactive). No caps.

What a builder pays at ×1.25 on the published rates:

| | Our cost | Charged |
|---|---|---|
| Outgoing call from the app, a minute | $0.014 + $0.004 (app leg) | $0.0225 |
| Incoming call answered in the app, a minute | $0.0085 + $0.004 | $0.015625 |
| Voicemail left on a missed call, a minute | $0.0085 + $0.0025 (recording) | $0.01375 |
| Text sent, a segment | $0.0083 + $0.0045 (carrier fee) | $0.016 |
| Text received, a segment | $0.0083 + $0.0035 (carrier fee) | $0.01475 |
| Photo text received (MMS), a message | $0.0165 + $0.0035 (carrier fee) | $0.025 |

Each call or text is one line under the builder's Transactions. Whole cents move; the fraction is carried in `wallet_accounts.usage_remainder_micros`. Under $5 available (`floor_cents` 500) a builder can't place calls or send texts until they add funds (auto top-up runs first, if it's on). Incoming calls and texts, 911 and non-billable builders are never refused, and a gate that fails allows the call. The app shows "low" under $10.

None of this is a migration or SQL. The markup, the wait, the pilot list, `armed_at` and the four meters are operator data, written on Admin › Billing › Phone & text billing. The card uses admin-catalog `phone_billing_set` and `phone_billing_arm`, which validate, audit to `admin_audit`, and make the narrowing writes first. The UPDATEs in migration 259's ARMING notes predate the card, so don't use them. Each step waits for the one before it, and each needs Ahsan's go.

0. **Prerequisites.**
   - **A pilot business.** A NEW test business, not billing-exempt or metered-exempt, with a voice number of its own (a local number, about $1.15 a month at Twilio). None exists today (checked 2026-10-07). The one live number belongs to the demo business, which is billing-exempt, has a real card on file with auto top-up, and carries Carolyn's live line: never un-exempt it or pilot it. `testtttttt` has no `client_configs` row. A new number can call straight away, but its texts fail (Twilio 30034) until it is 10DLC-registered, so verify texts live only if it is. Leave its wallet's auto top-up OFF, with no card on file.
   - **The privacy pages** must say the call and text records are used to charge the business. The drafts are in the phone repo and uncommitted: `site/public/my-synergy-phone/privacy.html` and `docs/extension-privacy-policy.md`, the same files as 7d step 0. Publish them before step 5 (everyone), not before the pilot.
   - **This Worker's MMS estimate** (`MMS_IN_MICROS` in `src/cron/usageCharge.ts`, 2026-10-07), merged to beta. It ships in step 3's deploy. Not blocking.
1. **Save the prices** on the card. Set Markup to `1.25`. Under "Carrier fees and fallback rates", set Wait (hours) to `1` (it was 6). Change nothing else: the fallback rates and carrier fees already equal Twilio's published rates, there are no caps, "Charge for missed calls" stays off and the minimum balance stays $5.00. Press Save prices. This does nothing while charging is off (`armed_at` empty), and the card says "Saved. Charging is off". The `admin_audit` row reads `markup (none) -> 1.25; fallback_after_hours 6 -> 1`, and the report's "Would have charged" now prices at ×1.25. Why 1 hour: Twilio returns no per-call or per-text price on this account today, so every item waits out the whole window before it is estimated. 6 hours delays each wallet line by 6 hours and lets an armed builder keep calling for about 6 hours past the floor. 1 is the lowest the card accepts. Read back:
   `select markup, fallback_after_hours, armed_at, pilot_client_ids from public.phone_billing_settings;` gives 1.250, 1, null, {}.
2. **The edge rail**, from the repo root: `npx supabase secrets set PHONE_USAGE_METERS=on`. It arms and gates texts sent from the portal and the edge functions (portal-settings, sms-status and submit-estimate, through `_shared/smsSend.ts` and `_shared/usageGate.ts`). It is also what the card's "server switch" reads. No redeploy is needed, because the secret is read at run time, but a warm isolate can keep the old value for a few minutes. With `armed_at` still empty it charges and refuses nothing.
3. **This Worker with `PHONE_USAGE_METERS` "on"**, one deploy at a time, because other batches deploy this Worker too. Work from a fresh origin/beta tree holding every merged Worker change:
   - read the live version's vars first (`npx wrangler deployments status`, then `npx wrangler versions view <live version id>`), and make every other rail in `wrangler.jsonc` match them. `CALL_RECORDING` matters most: it must be what live has ("on" once 7d is live, "off" after its kill switch);
   - set `PHONE_USAGE_METERS` to `"on"` and change nothing else;
   - commit `workers/phone-api/wrangler.jsonc` to beta, staged by name, so the next deploy by anyone keeps it on;
   - diff the live version's source against the branch;
   - deploy with an explicit config path: `npx wrangler deploy --config <absolute path>/workers/phone-api/wrangler.jsonc`.

   Then confirm on the new version: `PHONE_USAGE_METERS` "on", `PHONE_USAGE_COST_CAPTURE` "on", `CALL_RECORDING` as live had it, `CALL_TRANSCRIBE` "off". `/health` must answer 200, and the downloaded live bundle must contain `num_segments, num_media, created_at` (the MMS estimate's read). The card's server switch is the edge secret from step 2; the Worker's own var shows only in `wrangler versions view`.
   **Both rails go on before step 4.** If charging starts (`armed_at` is set) before both are on, every call and text in between settles as a final `shadow` row. That loses the charge but never doubles one. The Worker's rail alone would arm calls and app texts while portal texts stayed ungated.
4. **The pilot**, on Ahsan's go. Choose "Only these pilot builders", add the test business alone, and press Start charging. The card then shows "On for 1 pilot builder". Then prove it live on the test business only. Ahsan places the calls and texts from his own phone; never use Carolyn's line or a customer's number. If anything is off, press Stop charging and stop here.
   1. Before: `select count(*) from public.wallet_reconcile where stored_balance_cents <> ledger_balance_cents or stored_balance_exact_micros <> ledger_balance_exact_micros;` gives 0.
   2. Fund the test wallet with $10 using the operator's wallet credit (`wallet_credit`, no card). Auto top-up stays off.
   3. Sign in to the app as the test business. Place one outbound call of about 2 minutes and send one text, both to Ahsan's own cell. Reply to the text from the cell.
   4. After about 1 hour plus one 5-minute run, run `select source, direction, state, cost_source, cost_micros, charge_micros, markup, units, wallet_tx_id is not null as posted from public.usage_charges where client_id = '<test business>' and occurred_at >= '<armed_at>' order by occurred_at;`. Every row: state `charged`, cost_source `estimate` (or `twilio`, if Twilio priced it), markup 1.250, charge_micros = round(cost_micros × 1.25), and posted true.
   5. Run `select meter_kind, amount_exact_micros, idempotency_key, memo from public.wallet_transactions where client_id = '<test business>' and idempotency_key like 'usage:%' order by created_at desc limit 10;`. The lines are `voice_minute`, `sms_segment` and `sms_in`, with amount_exact_micros = −charge_micros and keys `usage:call:<id>` / `usage:sms:<id>`. The query in 1 still gives 0.
   6. The test business's Billing tab › Transactions shows "Outbound call to (xxx) xxx-xxxx · 2 min" and "Text to … · 1 segment". Check it headless with a stubbed login, or signed in.
   7. Bring available under $5 with `wallet_adjust`. An outbound call is refused with "Your wallet is empty. Add funds in Structure Studio under Settings, Billing.", an outbound text answers `wallet_empty`, and `/token` reports `wallet.state` `blocked`, but an inbound call to the test number still rings. Credit it back: calls and texts are allowed again.
   8. Press Stop charging. New items then settle as `shadow`.
   9. Run the section 10 summary query for `edge:phone-api` and look at `app_errors` for the edge functions. Read counts only, expect no new `severity = 'error'` rows, and resolve only our own test rows.
5. **Everyone**, only on Ahsan's go after the pilot, and after the privacy pages in step 0 are published. Choose "Every builder" and press Start charging. This activates exactly `voice_minute`, `voice_minute_in`, `sms_segment` and `sms_in`. Read back with `select kind, active from public.usage_prices where kind in ('voice_minute', 'voice_minute_in', 'sms_segment', 'sms_in', 'call_recording', 'call_transcription', 'sms_number_monthly', 'phone_line_monthly', 'voicemail_transcription') order by kind;`: true for exactly those four. Today this charges nobody, because no non-exempt business has a number (checked 2026-10-07). After that, every builder who turns calling on is charged from their first call, and one with auto top-up on has their card charged when the wallet runs low. Non-billable builders, the demo business among them, are never charged: their rows settle as `exempt`, with the would-be charge recorded.
6. **Afterwards**: the error check from 4.9 again. Then the work log `SSS Phone Usage Billing & Handoff.md`: markup 1.25 and the 1-hour wait, each arming time, and the pilot's result.

**Stop charging** (the panic button, on the card) deactivates the four meters and clears the pilot list. `armed_at` is kept as the record. New calls and texts settle as `shadow` with their cost, charges already made stay on the wallets, and nobody is refused for a low balance. The env rails can stay on. To turn them off as well: set `PHONE_USAGE_METERS` to "off" in `wrangler.jsonc`, deploy (with the other rails as live has them), commit, then run `npx supabase secrets set PHONE_USAGE_METERS=off`.

**One file, two rails.** `CALL_RECORDING` (7d) and `PHONE_USAGE_METERS` (here) are both vars in this Worker's `wrangler.jsonc`, and a deploy sets every var to what the tree says. A deploy from a tree that still says "off" for a live rail turns that rail off without a word. Then recording stops, or every call and text settles as a final `shadow` row and is never charged. The other way round too: a tree that says "on" for a rail the live version has "off" (after a kill switch) turns it back on without a word. So commit each flip to beta when it happens, and before ANY deploy of this Worker compare `npx wrangler versions view <live version id>` with the tree. If they disagree on any rail, stop and ask before deploying.

**Watch for real prices.** When Twilio starts pricing calls and texts, `cost_source` turns to `twilio` and the same ×1.25 applies to the real cost, with no alert. Check now and then: `select date_trunc('week', occurred_at) as week, count(*) from public.usage_charges where cost_source = 'twilio' and cost_micros > 0 group by 1 order by 1 desc;`. When rows appear, compare them with Twilio's own bill (the card's report does this) and tell Carolyn. The markup stays 1.25 unless she says otherwise. The estimate has known gaps:
- An incoming call to a toll-free number is estimated at the local $0.0085 (Twilio charges $0.022). There are no toll-free numbers today.
- The carrier fee on a text received (3,500 micros) is not on Twilio's published page, which lists fees on sent texts only. Check it against the carrier-fee line in `twilio_usage_daily` once Twilio prices it.
- The fee on a text sent is T-Mobile's ($0.0045). Verizon's is $0.005 and AT&T's $0.0035.
- With a 1-hour wait, an item Twilio prices later than that keeps its estimate, because the ledger wins.

## 7f. One Twilio sub-account per builder (Workstream 2; off until you turn it on)

Every builder but our own texts and calls from a Twilio sub-account of their own, billed to ours. The switch is `TWILIO_SUBACCOUNTS`, an edge secret AND a var of this Worker (one file, many rails: see 7e), with three values (DEVIATIONS 76 to 78):
- **unset (off):** today. Nothing is looked up anywhere. The operator console can still make a TEST sub, but nothing uses it.
- **`manual`:** every sub-account that exists is used (its numbers, texts, calls, `/token`, webhooks), but none is made by itself. Only the console's Create makes one. A builder without one is refused rather than put on our main account for good. This is the pilot and the rollback.
- **`on`:** as `manual`, and a builder's sub-account is made by itself the first time they buy a number on the Phone tab or first submit their texting registration (`_shared/twilioProvision.ts`).

1. **Before deploying (reads only).**
   - `npx supabase secrets list`: `PHONE_SELF_SERVE` must be unset. It now opens only when `TWILIO_SUBACCOUNTS` is `on` too, so if it is set today, builder self-serve would quietly close.
   - Saved texting drafts. A draft's first submit is refused until the switch is on, because it would put the builder on our main account for good:
     `select status, count(*) from public.sms_registrations where status in ('intake', 'aup_pending', 'ready') and coalesce(customer_profile_sid, a2p_profile_sid, brand_sid, messaging_service_sid, campaign_sid) is null group by 1;`
     For each builder it finds, either pin them to our main account (if they should stay there) or tell them it waits.
2. **Migrations 292 and 295** applied (renumbered at apply), each with its RECORD row read back. 295 must read `holdings_guarded` true and `split_today` 0. From then on the database itself refuses a number or a registration on our main account for a builder that has a sub-account.
3. **Deploy order:** the migrations, then admin-catalog and the rest of the deploy list, then this Worker, and only then push the portal bundle to beta. Until admin-catalog is deployed, the console card only says the server doesn't have the tools yet.
4. **Edge secrets.**
   - `TWILIO_AUTH_TOKEN`: the parent's auth token, required. A parent API key can neither create a sub-account nor reach one, so with only a key, Create names the secret to set.
   - `TWILIO_SUB_APP_FALLBACK_URL` and `TWILIO_SUB_VOICEMAIL_URL`, both required: static TwiML that ANY account may fetch, fetched with GET. ⚠️ **Never a TwiML Bin.** A Console Bin answers only the account that owns it (Twilio's TwiML Bin migration page: "you'll have to replicate it to each account"). The parent's Bins (`PHONE_FALLBACK_URL`, the calls app's fallback from 2.3) would answer every sub with 401: no voicemail for a sub's numbers when calling is off or the Worker is down. A `handler.twilio.com` or `webhooks.twilio.com` URL is refused. One way to host them: in the parent's Twilio console, Functions and Assets, a new Service with three Assets whose visibility is **Public** (Protected checks the request's signature, the same problem as a Bin). Deploy it and copy their `https://<service>.twil.io/...` URLs. Any static https host that doesn't depend on this Worker works too.
     - `voicemail.xml` (`TWILIO_SUB_VOICEMAIL_URL`): the same greeting as the parent's voicemail Bin, then `<Record action="<the hangup.xml URL>" method="GET" .../>`. The recording sweep files those messages per account.
     - `hangup.xml`: `<Response><Hangup/></Response>`.
     - `calling-problem.xml` (`TWILIO_SUB_APP_FALLBACK_URL`): `<Response><Say>Calling is having a problem. Please try again or use your cell.</Say><Hangup/></Response>`.
   - Optional: `PHONE_API_BASE`, and `TWILIO_EVENT_TYPES` (comma-separated `type` or `type@version`, to copy the parent subscription's list exactly from the phase 0 inventory; without it, the A2P brand, campaign and number-registration types twilio-events acts on, at version 1).
   - Already set: `TWILIO_ACCOUNT_SID`, `PHONE_WEBHOOK_SECRET`, `TWILIO_EVENTS_SECRET`.
5. **Push material, into Vault by hand** (the SQL editor, never a file), under exactly these names. A missing one is skipped and shown on the console card. That sub's phones then sign in without incoming-call push until it is loaded and "Add the missing push credentials" is pressed.
   - `twilio_push_apns_dev_certificate`, `twilio_push_apns_dev_private_key`: the development bundle id's VoIP Services certificate and key, PEM.
   - `twilio_push_apns_prod_certificate`, `twilio_push_apns_prod_private_key`: the store bundle id's, PEM.
   - `twilio_push_fcm_secret`: the Firebase service account JSON the parent's FCM credential was made from.
   - `select vault.create_secret('<the PEM or JSON>', '<name>', 'Twilio push material (migration 295)');` Both APNs credentials are made with Sandbox unticked (item 75's one APNs environment). The VoIP certificate expires 2027-11-05: renew the two apns secrets then, and each sub's own credential.
6. **The test builder, in this order.**
   1. Admin, the test builder, Account, "Twilio account", Create (needs can_bill). While the switch is not `on`, it asks you to type the builder's id. Then Check token: both should read accepted. A builder on our main account (our own, or one already holding a number or registration there) is never offered Create.
   2. Set `TWILIO_SUBACCOUNTS=manual` on the edge (`npx supabase secrets set TWILIO_SUBACCOUNTS=manual`) and in this Worker's `wrangler.jsonc`, then deploy. Nothing changes for any builder without a sub-account. **Everything below needs `manual` or `on`:** with the switch off, buying a number for a builder that has a sub-account is refused (it would land on our main account and split them), and their `/token` and calls still run on the parent.
   3. Buy a number for the test builder. It lands in the sub, and `sms_numbers.twilio_account_sid` is set. Then mint `/token` for a test user (the issuer is the sub's key, the app the sub's), place a call, and point the number's voice URL at a dead address: the caller still reaches the sub's voicemail TwiML, and within 15 minutes the sweep files the message.
   4. The phase 6 spike (A2P inside the test sub).
7. **Switch on:** `TWILIO_SUBACCOUNTS=on` on the edge and in the Worker. From then on, a builder's first number or first texting submit makes their sub-account. New registrations are refused while the switch is not `on` (portal-sms registrationGate.ts), and the Phone tab's `PHONE_SELF_SERVE` opens only with it on.
8. **Rollback.**
   - Before any real builder is on a sub-account: unset it.
   - After that, set it to `manual`. **Never unset it.** Off, this Worker refuses every webhook from a sub's numbers (`wrong_account`), texts go out with our main account's credentials and fail, and registrations in a sub-account wait. `manual` stops new sub-accounts and keeps every existing one working.
   - Never close a sub that still has numbers: Close refuses, because closing releases them for good. Deleting a builder checks everything first, closes their sub only after the payment-gateway step, and refuses with nothing done while it has a number.
   - A closed sub-account keeps its builder off calls and texts while its row is on record. To let them start again: `select public.twilio_account_forget('<client id>');` in the SQL editor (it removes only a closed, never-made or pinned row).

## 8. Prove it (plan section 20, phase 1b)

- A test page calls your cell, and your cell calls the test page. Timing marks appear in `phone_call_events`.
- The builder hangs up first on an inbound call, and no voicemail is created.
- Send a text and receive one; check the rows and the live events. A typed text sends at night.
- Try each refusal: no consent, STOP, another salesperson's customer. Check the reason shown.
- Point the number's voice URL at a dead address: the caller still reaches voicemail, and within 15 minutes the sweep files the message.
- Post to `/voice/inbound` with a wrong `?key=` and get 403 (and, with the token set, a wrong signature too).
- Phase 5, on real calls, inbound AND outbound (DEVIATIONS 39 to 43 are exactly what this proves):
  - Hold: the customer hears hold music, you hear silence, neither hears the other; Resume reconnects you. Nobody drops when the call moves.
  - Warm transfer: the teammate's app rings with the call's name on it; when they answer all three talk; you hang up and they carry on. A teammate who doesn't answer after you've hung up leaves the customer in voicemail, not in silence.
  - With `TRANSCRIBE=on`, leave a 10-second message and see the text on the call.
  - Text a photo to the number and open it from the thread.
- After every deploy, check `app_errors` for source `edge:phone-api` with the summary query in section 10 step 2, not a list of rows: these rows are written while the Worker handles everyone's calls and texts, the Chrome extension's users included. Your own test rows you may list and resolve by your test business:
  ```sql
  select created_at, severity, code, message from public.app_errors
   where source = 'edge:phone-api' and client_id = '<your test business>' and not resolved
   order by created_at desc limit 50;
  ```

## 9. The rename to My Synergy Phone (2026-10-01)

The extension and the app send their errors to `/log` with a source code, and the rename changed those codes: `my-synergy-phone-extension` and `my-synergy-phone-mobile` replace `sss-phone-extension` and `sss-phone-mobile`. This Worker accepts all four (`LOG_SOURCES` in `src/routes/me.ts`).

1. Deploy this Worker FIRST, before anyone installs a renamed extension or app build. The Worker from before the rename knows only the two old codes and answers any other source with 400 "Unknown log source.", so every error a renamed build reported would be dropped and nothing would reach `app_errors`. To check, have a renamed build send one error and find its row in `app_errors`.
2. While both kinds of build are installed, look for app errors under both names. The mobile app's you may list:
   ```sql
   select created_at, source, severity, code, message from public.app_errors
    where source in ('my-synergy-phone-mobile', 'sss-phone-mobile') and not resolved
    order by created_at desc limit 50;
   ```
   The Chrome extension's (`my-synergy-phone-extension`, `sss-phone-extension`) only in summary (section 10 step 2).
3. Once no installed build sends the old codes, drop them from `LOG_SOURCES` and redeploy.

## 10. Error reports and the Chrome extension's Limited Use rules (2026-10-03)

The extension's privacy policy claims the Chrome Web Store's Limited Use rules: people here may read an extension user's data only with that person's consent (they ask for help), for security, or when the law requires it, and for running the service only aggregated and anonymised. So the extension's error reports store no user id, no business id and no Twilio identity, call SID, email or phone number (DEVIATIONS 64). Each has `context.user_ref` and `context.client_ref` instead: a keyed pseudonym that groups one person's errors.

Pseudonymous is not anonymous. Anyone who can query the database can line a report's time and its `where: "call"` or `twilio_code` up with `phone_calls` or `phone_call_events`, which name the person, and one match names every report under that ref. The Worker's own rows (`edge:phone-api`) say more still: business ids, call ids, sometimes a contact id or a number in `url` or `message`, and a row does not say whether the extension or the app was involved. What keeps the policy true is how both are read:

1. Set `LOG_PSEUDONYM_KEY` (section 3) before deploying this Worker. Without it the reports are still saved, with no refs, and `log_pseudonym_key_missing` appears in `app_errors` at `warn`.
2. Routine triage (after a deploy, a daily look, an agent doing it for us) reads the extension's reports and the Worker's own rows only in summary, with this query, and never lists them. It shows no ref, no id and no time, and it scrubs emails, ids, SIDs and numbers out of the message as it groups:
   ```sql
   select source, code, severity, s.message, count(*) as reports,
          count(distinct context->>'user_ref') as people, count(distinct client_id) as businesses
     from public.app_errors,
          lateral (select regexp_replace(regexp_replace(regexp_replace(regexp_replace(message,
                     '[^\s@]+(@|%40)[^\s@]+', '[email]', 'g'),
                     '\w*[0-9a-fA-F]{32}\w*', '[id]', 'g'),
                     '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '[id]', 'g'),
                     '\+?\(?\d[\d\s().-]{8,}\d', '[number]', 'g') as message) s
    where source in ('my-synergy-phone-extension', 'sss-phone-extension', 'edge:phone-api')
      and not resolved and created_at > now() - interval '7 days'
    group by 1, 2, 3, 4
    order by reports desc limit 50;
   ```
   `people` counts the extension's reporters, `businesses` the businesses in the Worker's rows. Change the window to suit, but keep times out of the output. Resolve a whole group at once (`update public.app_errors set resolved = true, resolved_at = now(), resolution_note = '<why>' where source = '<source>' and code = '<code>' and not resolved`) rather than reading its rows. Never join these rows to `phone_calls`, `phone_call_events` or the user list by time. The same rule covers the Worker's Cloudflare logs (`observability` is on in `wrangler.jsonc`): their request URLs and console lines carry the same ids.

   Open single rows (`select *`) only for the person who asked for help (step 3, and only theirs), for a security incident, when the law requires it, or for your own test rows (the Worker's by your test business, section 8; the extension's by step 3 with your own test user).
3. When someone asks for help with the extension, find THEIR reports, and only theirs. From this directory, with the key from the password manager:
   ```
   $env:LOG_PSEUDONYM_KEY = "<the key>"
   node scripts/log-ref.mjs --user <their user id> --client <their client id>
   Remove-Item Env:LOG_PSEUDONYM_KEY
   ```
   It prints their `user_ref` and `client_ref` and the query to run. It reads and writes nothing itself. With their consent the Worker's rows about their own calls may be read too (`context->>'callId'` of a call they name).
4. Once, when this ships: the extension's reports from before it hold user ids, business ids, Twilio identities, numbers and emails, in `context` AND in `message`, so stripping keys is not enough. Keep a summary, then delete every one of them, resolved or not. They are the extension rows with `context.user_id`, a key no new report has, so rows the old Worker wrote during the deploy are caught too:
   ```sql
   -- a. the summary to keep: paste the output into the work log
   select source, code, severity, count(*) as reports, count(distinct context->>'user_id') as people
     from public.app_errors
    where source in ('my-synergy-phone-extension', 'sss-phone-extension') and context ? 'user_id'
    group by 1, 2, 3 order by reports desc;
   -- b. delete them
   delete from public.app_errors
    where source in ('my-synergy-phone-extension', 'sss-phone-extension') and context ? 'user_id';
   -- c. must say 0 (run it again a few minutes later, after the last old isolate is gone)
   select count(*) from public.app_errors
    where source in ('my-synergy-phone-extension', 'sss-phone-extension')
      and (context ? 'user_id' or context ? 'identity' or client_id is not null);
   ```
   The summary keeps what the rows were good for: which errors came back, and how often.
5. Deleting a business (admin-catalog's tenant wipe) removes its rows by `client_id`, so it no longer reaches the extension's reports. Those rows hold no business id; if a business asks for its reports to be deleted, find them with `--client` and delete them by hand.

## Rolling back

- Stop everything for a tenant at once: `update public.client_settings set phone_status = 'off' where client_id = '<id>';`
- Previous Worker version: `npx wrangler rollback` from this directory.
- Stop email alerts only (texts keep theirs): `drop trigger if exists phone_push_email on public.email_inbound;` (267's ROLLBACK has the rest).
- If the Worker is down, callers still reach voicemail through the number's fallback Bin.
