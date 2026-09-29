# phone-api: deviations from docs/SPEC.md

Where the Worker reads the contract a particular way, adds to it, or departs from the plan. Everything here is additive for clients unless it says otherwise.

## Contract additions the clients should know about

1. `/calls/:id/transfer` and `/calls/:id/events` accept a Twilio CallSid (`CA...`) as `:id`, as well as the `phone_calls` id. An outbound call cannot receive custom parameters, so the app only knows its own leg's CallSid there; the Worker resolves it through `client_call_sid` or `twilio_call_sid`, always inside the caller's tenant. On inbound calls (and transfers) every `<Client>` carries a `call_id` custom parameter with the `phone_calls` id, and transfers add `transferred_by`.
2. `GET /threads` and `GET /calls` return `cursor` when there is another page. Pass it back as `?cursor=`. It is an ISO timestamp.
3. `GET /health` returns `{ok, version, deployment}`; `deployment` is the Cloudflare version id.
4. `POST /settings/me` returns `settings: {dnd, dnd_until, forward_to_cell}` (phone-core's `MySettings`). `dnd` is the effective value: a passed `dnd_until` reads as off.
5. `sent_via` on `sms_messages` is `extension` when the request's Origin is `chrome-extension://...`, otherwise `mobile`. An `x-sss-client: extension|mobile` header overrides it. The SPEC does not say how the Worker knows.
6. A preflight `/token` lasts 600 s, not 3600; the response's `ttl` says which.
7. HTTP statuses for the error codes: `unauthorized` 401; `no_phone_access`, `phone_off`, `retired_device`, `not_your_customer`, `emergency_blocked` 403; `no_consent`, `opted_out`, `number_not_registered`, `no_number` 409; `wallet_empty` 402; `minute_cap` 429; `not_found` 404; `bad_request` 400 (405 for a wrong method); `twilio_error` 502; `internal` 500. Clients switch on `code`, never the status.

## Choices where the SPEC or plan left room

8. `/token` asks Auth whether the session still exists (`GET /auth/v1/user`), in parallel with the context read, so it adds no round trip. The plan says the Worker never calls `auth.getUser()`; this is the one exception, and only on `/token`. Without it, "Sign out all devices" could not stop a lost phone from minting a fresh line while its access token lives (up to an hour). It fails open if Auth is down (logged, throttled) and closed if Auth says the session is gone. The call webhooks never call Auth.
9. The phone_calls id is generated in the Worker, and the row is written in `waitUntil` after TwiML is returned, so `/voice/inbound` stays at one database round trip before the answer. The status, voicemail and after-dial handlers retry briefly when a callback beats the insert.
10. Outbound refusals are TwiML (`<Say>` in plain English, then `<Hangup/>`), because the Voice SDK cannot read a JSON error. Where there is a tenant, the attempt is written as a `failed` `phone_calls` row with `error_code` (`not_your_customer`, `minute_cap`, `emergency_blocked`), so the app can show the reason when it re-reads the call.
11. 911 while `EMERGENCY_MODE=block`: the attempt is recorded with `is_emergency = false`. Nothing reached a dispatcher, so the 60-minute "ring only this person" rule must not switch on. It is also logged at `warn`. In `allow` mode only 911 and 933 pass (the numbers Twilio supports); 112 is still refused.
12. The 911 callback rule re-rings the person who dialed 911 for at most 10 rounds, then says "We could not reach anyone. Please call back." and hangs up. It never goes to voicemail, and it never rings forever.
13. When nobody is available, calls go straight to voicemail even if the route's `no_answer` is `forward`, as the plan says. Forwarding applies after a ring that nobody answered. A number with no `phone_routes` row rings nobody.
14. A member's `forward_to_cell` rings at the same time as their app, through the press-1 screen (the plan's "forward to a cell with a press 1 screen"). A `<Dial>` holds at most 10 nouns; apps come first, member by member.
15. Transfers: a teammate on DND is not rung at all, and the customer goes straight to the builder's voicemail. `transfer_state` is cleared when the teammate answers or when voicemail is reached (as well as by after-dial), so the teammate can transfer the call on again. `answered_by` moves to the teammate on answer; `transferred_from` keeps the person who handed it on, and both see the call in "My calls".
16. When the customer's leg of an inbound call ends while the row still says `in_progress` (a transfer that ended in voicemail), the Worker closes it as `completed` with the talk time. An outbound customer leg that is canceled before it answers is recorded as `no_answer`.
17. The daily minute cap counts outbound minutes on the UTC day, each call rounded up to a whole minute, plus the elapsed minutes of calls still going. It reads at most 1000 rows (PostgREST's cap), which is far above a builder's day.
18. `/sms/send`: portal-settings' contact/short-code match has no twin here because the API carries no short code. Its twin is the number: the recipient is read from the contact row, and the `to_e164` the app sent must match it or the send is refused. A contacts `view` user may not text a saved contact (the CRM gate is contacts `edit`), but may reply to an unknown number that texted first, as plan section 8 says. An unknown-number reply is refused when that number has since been saved as a contact.
19. `/sms/send` tags the row with `client_temp_id` and `sent_via` in a second update after `sendTenantSms` returns (SPEC section 2). `smsSend.ts` is unchanged. The insert's realtime event can arrive before the tag, so the apps should also match their optimistic bubble on the `id` this endpoint returns.
20. "Mine" for threads: a thread is mine when the contact's owner is me, when the contact has no owner, or when I sent a text in it. Unknown numbers count as unowned. Phone level `own` always gets "mine"; `view` and `edit` get it with `?mine=1`.
21. Calls with no contact (unknown numbers) are visible to contacts `view`/`edit`, and to anyone else only if they took part in the call.
22. `/voicemails/:id/audio` marks the voicemail heard (`listened_at`, `listened_by`) the first time it is played. There is no separate endpoint for that in the SPEC.
23. `/log` is rate-limited to 30 rows a minute per person per isolate, so a crash loop cannot flood `app_errors`. It stores `app_version` and `user_id` inside `context`.
24. The usage debit has a second rail, env `PHONE_USAGE_METERS` (default `off`), on top of the `voice_minute` meter being active and priced. It has not been run against the live `wallet_credit`; see the header of `src/cron/usageDebit.ts`. The monthly line fee runs from the same cron on the same two rails (item 37).
    - **Catch-up (added 2026-09-29, plan 17 "retried, never dropped").** Each daily run looks at the last 7 UTC days, not only yesterday, and charges every tenant-day with minutes whose key (`voice_minute:<client_id>:<YYYY-MM-DD>`) is not on the ledger yet. A failed charge, or a whole run that failed or never happened, is charged by a later run for up to a week. One ledger read skips the days already charged.
    - The window never reaches back before the earliest `phone_minutes` debit on the ledger, so the first run after arming charges only yesterday, never calls made while the meter was off. Known edge: disarming for a few days and arming again charges any of those days still inside the window.
25. Voicemail retention is one Worker-wide setting (`VOICEMAIL_RETENTION_DAYS`), not per builder yet.
26. `SUPABASE_URL` is a secret, not a var, so the project ref stays out of this public repo.

## Not imported, on purpose

27. The Worker does not import `@sss/phone-core`. This repo is public and cannot depend on the private phone repo. `src/identity.ts` is a twin of phone-core's identity and E.164 helpers, and `test/identity.test.ts` compares the two on every case when `PHONE_CORE_DIR` points at a checkout (it passed against phone-core 0.1.0 on 2026-09-29).

## Not verified here

28. APNs requires HTTP/2. The APNs sender is unit-tested against a stub, but whether a Worker's `fetch` reaches `api.push.apple.com` over HTTP/2 has to be proved on a real iPhone in phase 4. If it cannot, iPhone text alerts need another path.
29. Android text alerts use notification channel `texts`. The phone app must create that channel, or Android files the alerts under its default channel.

## Added 2026-09-29: the auth-token gap and phase 5

30. **`TWILIO_AUTH_TOKEN` is optional (departs from SPEC section 1 and plan section 8, which say a missing token refuses everything).** Twilio's API never returns the auth token, so a Worker set up from API credentials may start without it. Now:
    - `PHONE_WEBHOOK_SECRET` is always required. Without it every Twilio request gets 503 (`twilio_no_webhook_secret`, error).
    - With the token set, a webhook needs both the `?key=` and a valid `X-Twilio-Signature`, as before.
    - Without the token, a webhook is accepted on the `?key=` alone, and its `AccountSid` must be present and equal `TWILIO_ACCOUNT_SID`. The first such request in each isolate logs `twilio_signature_skipped` at `warn`.

    What someone who learned the key could do while the token is unset (corrected 2026-09-29): post fake status, after-dial, voicemail, transcription and conference callbacks. That lets them write fake `phone_calls` rows, mark real calls ended in the database, and put invented text on a voicemail as its transcript. Webhook answers go back to whoever posted, so they cannot place a call.
    - **Checked against Twilio when unsigned:** the conference callback and the holder-leg backstop act only when Twilio's own call record says the leg has ended; a warm-transfer answer (`leg=warm`, which moves `answered_by` and with it the right to hold and transfer) counts only when Twilio says that leg is live, rang that user's identity, and is in this call's conference (`warm_answer_unverified` at `warn` otherwise).
    - **Not checked, so an insider could still listen in:** the `leg=client` answer and the `/voice/screen` press-1 set `answered_by` from the request while a call is ringing (the first ring, or a cold transfer's 20 s). Someone with the key, a login on the same tenant and the call's id could claim a ringing call that way and then transfer the customer to an account they control. Checking those two against Twilio would put a REST read on the answer path of every call, so it is not done; the token closes it.
    - The key rides in the query string of every webhook URL, so it also shows in Twilio's request inspector and in Workers Logs (observability is on in `wrangler.jsonc`). Set the token as soon as someone can copy it from the Console.
31. **New endpoints (not in SPEC section 3):** `POST /calls/:id/hold`, `POST /calls/:id/resume` and `POST /calls/:id/warm-transfer {to_user_id}`. `:id` works as it does for `/transfer`. Each one answers `{ok:true, held, call_id}`:
    - `held` is `true` after hold and `false` after resume. After warm transfer it is `true` when the call had to be moved (the customer hears hold music until the teammate answers, then all three talk) and `null` when the hold state did not change:
      - the customer was on hold: they STAY on hold while you and the teammate talk, and Resume brings them in. From a plain Hold (a conference nobody has started) the Worker first puts the customer on a Participants hold, because the teammate starting the conference would otherwise connect them into the consult (fixed 2026-09-29);
      - you were talking to the customer in the conference (after Resume): the teammate joins the two of you. SPEC section 3 describes only the first case; the clients already read `null` as "unchanged" and show the right line for both.
    - `call_id` is the `phone_calls` id. An outbound app should switch to it. Once a warm transfer is answered, `client_call_sid` moves to the teammate's leg, and the app's own CallSid no longer finds the call.

    Refusals use the usual codes: `not_found` (not on the call), `bad_request` (ended, a cold transfer ringing, an emergency call, not on hold, still moving, teammate on DND, the 911 callback window), and `twilio_error`. Warm transfer refuses a teammate on DND. A cold transfer sends them to voicemail instead, but here you are still on the line and can choose. A warm transfer pressed while the legs are still moving in after Hold asks for a moment ("The call is still being put on hold. Try again in a moment.") and rings nobody.

    **The 911 callback window (added 2026-09-29, plan section 14).** For 60 minutes after a 911 call from a number, hold, warm transfer and cold transfer are refused on inbound calls to it ("For an hour after a 911 call from this number, its calls can't be put on hold or transferred."). Each could end in the builder's voicemail (a customer left alone in the conference, a teammate on DND), and the dispatcher's callback must never go there. Resume is never refused. Outbound calls are not affected.
32. **Design (b) of plan 9C, as built.**
    - **Outbound calls:** the Dial now has an action URL, `/voice/after-dial?stage=out`. That branch never rings anyone and never plays voicemail. If the call is in its conference, the app's leg joins it; otherwise the leg hangs up, which is what the Dial did before.
    - **Inbound calls:** after-dial has a new step 0. When `transfer_state = 'conference'`, the customer gets the same `<Conference>`, never voicemail or a hang-up.
    - **Moving a call into its conference:** the Worker redirects the **child** leg of the plain Dial. Inbound, that is whoever answered. Outbound, it is the customer, or the teammate once a cold transfer has handed the call on. The parent leg follows through the Dial's action.
    - **The conference:** it is named after the `phone_calls` id.
      - Customer: `startConferenceOnEnter=false`, `endConferenceOnExit=true`, Twilio's default hold music.
      - Our person: `start=false`, `end=false`, silence (`waitUrl=""`). A call that has just been moved is therefore on hold.
      - Teammate (warm transfer): `start=true`, `end=false`, added with the Participants API.
    - **Hold and resume:**
      - Hold in a conference that has started uses Participants `Hold=true`.
      - Resume in a conference that has not started brings our leg back in with `start=true`, after taking the customer off a Participants hold if a warm transfer put one on.
      - Resume in a started conference uses `Hold=false`.
    - **A move that fails** (added 2026-09-29). The claim is written before the redirect, so after-dial can already have answered the parent with the conference. What the failed redirect left behind decides:
      - the leg being moved had already ended (a hang-up or drop as the button was pressed): the claim goes back and the parent leg is ended too, as a plain call ends when one side hangs up. Never a customer alone in a conference nobody will join. Skipped if a cold transfer took the call meanwhile. The app gets `bad_request` "That call has already ended."
      - the request got no answer (network) but the leg is in the conference: the claim is kept and the press succeeds (`hold_answer_lost` / `warm_transfer_answer_lost` at `warn`).
      - otherwise: the claim goes back, as before.
    - **Once in the conference:** the call stays there until it ends. A cold transfer is allowed from the conference (`transfer_state` goes from `conference` to `transferring`). It redirects the customer, which ends the conference for everyone else.
    - **When someone leaves:** every conference reports `leave` to `/voice/conference`. When someone other than the customer really hangs up (a leg that was only redirected is still live and is ignored) and the customer is alone:
      - The customer goes to voicemail if they were waiting, meaning held or in a conference that never started.
      - Otherwise the customer is hung up.
      - A warm-transfer teammate who never answers (`/voice/status?leg=warm`) leaves a customer who is alone in voicemail.
      - A conditional clear of `transfer_state` means only one of those events acts.
      - **Second trigger (added 2026-09-29):** the status callback of the leg that holds the call (`client_call_sid`: `leg=client`, `cell`, `warm`, or the outbound app leg) reporting a final status runs the same check, leaving that leg out of Twilio's list. The leave event alone could strand the customer: it is skipped while Twilio still reports the leg live, and a failed REST read was only logged. Failures log `conference_backstop_failed`.
    - **Handed over on hold (added 2026-09-29).** SPEC: the transferrer hanging up leaves the customer with the teammate. When the customer is on a Participants hold and the only other person left is the teammate who answered the warm transfer, the customer is taken off hold (`handed_over` event): when the transferrer leaves mid-consult, or when the teammate answers after the transferrer has gone. If the teammate is the one who leaves, the customer stays on hold for the transferrer to Resume.
33. **Row semantics in the conference.**
    - **Teammate answers a warm transfer:** `answered_by` moves to them, `transferred_from` keeps whoever handed the call on, and `client_call_sid` becomes the teammate's leg. This only happens while `transfer_state = 'conference'`. A teammate who answers after the call has left its conference is hung up.
    - **Our person's leg ending:** while the call is in its conference, this no longer closes the row. The customer's leg ending closes it. The outbound customer leg now also clears `transfer_state`.
    - **Warm transferrer:** they may hold, resume or transfer while the call is in its conference, not after.
    - **Events:** `hold`, `resume`, `warm_transfer`, `warm_transfer_missed`, `handed_over`, `conference_voicemail` and `conference_ended` go into `phone_call_events`.
34. **Voicemail transcription** is behind env `TRANSCRIBE=on` (default `off`). It adds `<Record transcribe="true" transcribeCallback=".../voice/transcription?call=...">`, and the callback stores `phone_voicemails.transcript`.
    - If the transcript arrives before the voicemail row, it retries briefly and then creates the row with the transcript. The later voicemail upsert keeps it.
    - `GET /calls` and `GET /threads/:key` add `transcript` to the `voicemail` summary. This is additive.
    - Twilio only transcribes English recordings of 2 s to 2 min, so a longer message gets no text.
    - The `voicemail_transcription` meter is not charged by anything yet.
35. **Wallet floor.**
    - **When it applies:** only while `voice_minute` is active and priced, as asked. It does **not** also need `PHONE_USAGE_METERS=on`, because a refusal moves no money.
    - **The check:** outbound calls are refused below env `WALLET_FLOOR_CENTS` (default 500). The balance compared is `balance_cents - held_cents`, and no wallet row counts as zero.
    - **Exempt:** tenants with `metered_exempt` or `billing_exempt` are never refused.
    - **The refusal:** TwiML `<Say>` ("Your Structure Studio wallet is empty. Top up in Settings, Billing.") and a `failed` row with `error_code = wallet_empty`, logged at `info`.
    - **Failures:** a failed read allows the call and logs `wallet_floor_check_failed` at `warn`.
    - **Latency:** the three reads run in the same parallel round as the minute cap, so they add no round trip. Inbound calls and 911 never reach this check.
36. **MMS.** **Sending photos is not built.** `_shared/smsSend.ts` → `twilioSms.ts sendSms` posts `Body` only, and a second send path would mean a second set of texting rules. `POST /sms/send` therefore refuses a non-empty `media_urls` with `bad_request` ("Sending photos isn't available yet. Send the text on its own.") instead of dropping the photos without saying so.

    **Viewing** works: `GET /media/:messageId/:index` streams one inbound file.
    - **Scope and login:** it applies the same thread scope as `GET /threads/:key` and answers `not_found` for outbound texts. The login is the `Authorization` header only, as SPEC section 3 says ("Bearer only"); `?access_token=` is refused (changed 2026-09-29: no client used it, and a token in a URL lands in logs).
    - **Twilio fetch:** it uses the API key against `api.twilio.com`, with the path built from SIDs only. It follows Twilio's redirect to the signed file by hand, **without** our Authorization header.
    - **Headers:** only image, video or audio types are shown inline; everything else is sent as an `application/octet-stream` attachment. Every response gets `nosniff` and `CSP: default-src 'none'; sandbox`.
    - **Where the media SID comes from:** `sms_messages.media` when that column exists (proposed, below). Otherwise Twilio's list of the message's media, read through `provider_sid`, whose order may not be the order the photos were attached in (it cannot differ for a single photo).

    **Proposed column, for the backend lane:** `alter table public.sms_messages add column if not exists media jsonb;`. It holds an array in `MediaUrl{N}` order of `{"sid":"ME...","content_type":"image/jpeg"}`. `sms-inbound` would write it from `MediaUrl{N}` (keeping only the `ME` SID from the URL) and `MediaContentType{N}`, with the same retry-without-the-column fallback `numMedia.ts` uses. Store SIDs, never full URLs.
37. **Monthly line fee (`phone_line_monthly`).**
    - **When it runs:** in the daily cron, but only when `PHONE_USAGE_METERS=on` **and** its meter is active and priced. That is one rail more than asked, matching the minute debit so that no cent moves on a DB flag alone. Arming it means turning on both.
    - **Who pays:** once per tenant per UTC month, charged in advance with no proration. A tenant has a line when its phone switch is on and it holds a voice-enabled number that has not been released.
    - **Idempotency:** the key is `phone_line_monthly:<client_id>:<YYYY-MM>`. One ledger read skips tenants already charged that month. Exempt tenants are skipped.
    - **Failures:** a failed charge is logged (`phone_line_fee_failed`) and retried by the next day's run.
    - **Cron:** each job now runs on its own, so a retention failure no longer skips billing.
38. **APNs topic per build type.**
    - A `dev` device uses `APNS_BUNDLE_ID_DEV`, or `APNS_BUNDLE_ID` if that is unset. For the whole individual-account period both builds share the `.dev` bundle id, so one secret is enough.
    - A `prod` device uses `APNS_BUNDLE_ID` only. It never falls back to the dev topic.
    - A build type with no topic is skipped and logged (`push_apns_not_configured_dev` / `_prod`).
    - Apple's `DeviceTokenNotForTopic` / `TopicDisallowed` is logged as our misconfiguration (`push_apns_wrong_topic`), and the device is kept.
    - What this does not cover: the `.p8` key belongs to one Apple team. If dev builds stay on the individual team after production moves to the organisation team, the Worker will also need a per-build-type key, key id and team id.

## Not verified here (phase 5, needs a real call)

39. That Twilio requests the parent leg's `<Dial action>` when the **child** leg is redirected, on both inbound and outbound calls. The plan's design (b) depends on this. If it does not happen, the parent would fall off the end of its TwiML and hang up. Test hold on both directions before anyone uses it with a customer.
40. That `waitUrl=""` gives silence. That Twilio's default `HoldUrl` / `waitUrl` music plays (`HOLD_MUSIC` in `src/conference.ts` is the documented default `waitUrl`). That a conference that has not started gives neither side the other's audio.
41. That the Participants API accepts the conference's friendly name when adding a participant. That custom parameters on `To=client:<identity>?call_id=...&transferred_by=...` reach the teammate's Voice SDK the way `<Parameter>` does.
42. That a leg redirected out of a conference (resume) reports `participant-leave` while its call is still `in-progress`, which is how it is told apart from a hang-up.
43. That Twilio's media redirect target accepts a request with no Authorization header (it is a signed URL), and that `GET /Messages/{MM}/Media.json` lists media in attachment order.
44. That the Participants API accepts `Hold=true` on a participant in a conference that has **not started** (warm transfer from a plain Hold), and that the teammate starting it then leaves that customer on hold music. If Twilio refuses, the warm transfer fails with `twilio_error` and rings nobody, so the consult never leaks; it would just not be offered from a plain Hold.
45. That a teammate the Participants API is still ringing appears in the conference's participant list (status `queued`, `ringing` or `connecting`). "The customer is alone" relies on it: if a ringing teammate is not listed, the transferrer hanging up during the ring sends the customer to voicemail instead of waiting for the teammate.
46. That a Participants-API call to `client:<identity>?call_id=...` reports `to` as `client:<identity>` (with or without that query; both parse). The unsigned warm-answer check (item 30) depends on it; if Twilio reports something else, key-only mode refuses every warm hand-over (`warm_answer_unverified`) until the token is set.
