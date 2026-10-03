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
7. Phase 4 only: the push credentials (APNs sandbox, APNs production, FCM).

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

APNs topics: `APNS_BUNDLE_ID` is the topic for `prod` devices, `APNS_BUNDLE_ID_DEV` for `dev` ones. While both builds use the `.dev` bundle id (the individual Apple account), set only `APNS_BUNDLE_ID` to it; dev devices fall back to it. When the store build moves to the final bundle id, set `APNS_BUNDLE_ID` to that and `APNS_BUNDLE_ID_DEV` to the `.dev` id.

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

## 6. The database webhook for text alerts

The webhook is a trigger in the repo, not a Dashboard webhook:

1. Put the push secret in Supabase Vault, the SAME value as the Worker's `PUSH_WEBHOOK_SECRET`:
   `select vault.create_secret('<PUSH_WEBHOOK_SECRET>', 'sss_phone_push_secret', 'x-push-secret for phone-api /push/text');`
2. Apply `supabase/migrations/256_sss_phone_push_webhook.sql` (by hand, `--file`, then record 256 in the ledger).
3. Set the Worker's `FCM_SERVICE_ACCOUNT_JSON` (Android) and the APNS_* secrets (iPhone).

Do NOT also create a Dashboard "Database Webhook" on sms_messages: 256 already is that webhook, and a second one sends every alert twice (and stores the secret in plain text). Never add the `net` schema to the API's exposed schemas.

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
- **Call and text charges (migration 259):** apply 259 BEFORE deploying a Worker that has `src/cron/usageCharge.ts`. From deploy day the Worker records each call's and text's Twilio cost as a `shadow` row in `usage_charges` (`PHONE_USAGE_COST_CAPTURE`, ships `on`) and charges nothing. To charge, ALL of: `PHONE_USAGE_METERS` = `on` (wrangler.jsonc, then deploy; and as a Supabase function secret for texts sent from the portal), `phone_billing_settings.markup` and `armed_at` set, and the meter (`voice_minute`, `voice_minute_in`, `sms_segment`, `sms_in`) active or the tenant in `pilot_client_ids`. **Order matters: turn `PHONE_USAGE_METERS` on (Worker and function secret) FIRST, then set `armed_at`.** With `armed_at` still empty the rail charges nothing, but a call or text after `armed_at` that the Worker settles while its rail is still `off` becomes a final `shadow` row and is never charged. The arming SQL is at the bottom of migration 259. Check first that the Billing tab understands `pricing = 'cost_plus'`.
- **Wallet floor:** outbound calls and texts are refused below `phone_billing_settings.floor_cents` (default 500), on the same rails as the charges above. Exempt tenants, inbound calls and 911 are never refused.
- **Auto top-up from the Worker:** the charges and the refusals ask the `wallet-autotopup` edge function for a top-up. Set the Supabase function secret `WALLET_AUTOTOPUP_SECRET` to the exact value of this Worker's `SUPABASE_SERVICE_ROLE_KEY`. If that key is a new-format `sb_secret_...` key (not a JWT), set `verify_jwt = false` for `wallet-autotopup` in `supabase/config.toml`, or the gateway refuses every request.
- **Monthly line fee:** needs BOTH `PHONE_USAGE_METERS` = `on` and `phone_line_monthly` active and priced. Check first that the Billing tab labels that meter kind.
- **Hold and warm transfer** need nothing switched on, but prove them on a real call in both directions (step 8) before anyone uses them with a customer.

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
- After every deploy, check `app_errors` for source `edge:phone-api` and resolve our own test rows:
  ```sql
  select created_at, severity, code, message from public.app_errors
   where source = 'edge:phone-api' and not resolved order by created_at desc limit 50;
  ```

## 9. The rename to My Synergy Phone (2026-10-01)

The extension and the app send their errors to `/log` with a source code, and the rename changed those codes: `my-synergy-phone-extension` and `my-synergy-phone-mobile` replace `sss-phone-extension` and `sss-phone-mobile`. This Worker accepts all four (`LOG_SOURCES` in `src/routes/me.ts`).

1. Deploy this Worker FIRST, before anyone installs a renamed extension or app build. The Worker from before the rename knows only the two old codes and answers any other source with 400 "Unknown log source.", so every error a renamed build reported would be dropped and nothing would reach `app_errors`. To check, have a renamed build send one error and find its row in `app_errors`.
2. While both kinds of build are installed, look for app errors under both names (`like`, not `in`, because these are patterns):
   ```sql
   select created_at, source, severity, code, message from public.app_errors
    where (source like 'sss-phone-%' or source like 'my-synergy-phone-%') and not resolved
    order by created_at desc limit 50;
   ```
3. Once no installed build sends the old codes, drop them from `LOG_SOURCES` and redeploy.

## 10. Error reports from the Chrome extension (2026-10-03)

The extension's privacy policy claims the Chrome Web Store's Limited Use rules, so its error reports store no user id, no business id and no Twilio identity, call SID, email or phone number (DEVIATIONS 64). Each report has `context.user_ref` and `context.client_ref` instead: a keyed pseudonym that groups one person's errors without saying who they are.

1. Set `LOG_PSEUDONYM_KEY` (section 3) before deploying this Worker. Without it the reports are still saved, with no refs, and `log_pseudonym_key_missing` appears in `app_errors` at `warn`.
2. Triage reads the rows as before. To see how many people one error hits, count refs, not rows:
   ```sql
   select code, message, count(*) as reports, count(distinct context->>'user_ref') as people
     from public.app_errors
    where source in ('my-synergy-phone-extension', 'sss-phone-extension') and not resolved
    group by code, message order by people desc, reports desc limit 50;
   ```
3. When someone asks for help with the extension, find THEIR reports, and only theirs. From this directory, with the key from the password manager:
   ```
   $env:LOG_PSEUDONYM_KEY = "<the key>"
   node scripts/log-ref.mjs --user <their user id> --client <their client id>
   Remove-Item Env:LOG_PSEUDONYM_KEY
   ```
   It prints their `user_ref` and `client_ref` and the query to run. It reads and writes nothing itself. Use it only for the person who asked, for security, or when the law requires it.
4. Deleting a business (admin-catalog's tenant wipe) removes its rows by `client_id`, so it no longer reaches the extension's reports. Those rows name nobody; if a business asks for its reports to be deleted, find them with `--client` and delete them by hand.

## Rolling back

- Stop everything for a tenant at once: `update public.client_settings set phone_status = 'off' where client_id = '<id>';`
- Previous Worker version: `npx wrangler rollback` from this directory.
- If the Worker is down, callers still reach voicemail through the number's fallback Bin.
