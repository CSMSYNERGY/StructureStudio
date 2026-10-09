# Bringing a builder's number to Structure Studio (runbook for a person)

Workstream 2, phase 8. A builder who already has a business number asks for it on the Phone tab ("Bring your number"). An operator moves it by hand, as below, and then lands it on the builder's account. There is no in-app port wizard yet: Twilio's Port In API is still in Public Beta, and doing it in Twilio's Console keeps every PIN, account number and bill out of our code. Carolyn has to agree to that deferral (she expects most new builders to need a move).

Placeholders in angle brackets are values you hold; none of them belong in this repo, an email thread, Monday or a chat.

## 0. The request

1. The builder fills in "Bring your number" on Settings, Phone: the numbers, the company they are with now, whether it is a GoHighLevel (LC Phone) number, who can approve the move (the account holder's name and email), and when it may move. portal-settings `phone_port_request` stores it in `phone_number_requests` (migration 297). It holds no PIN, password, account number or bill: the server refuses any of them, and a run of five or more digits in a free-text box is refused too.
2. The request shows on Admin, Builders, **Bring-your-number requests**, with what booking it needs. Press **Take it** (status "Being moved"), so the next operator knows someone has it.
3. Call the contact named on it. Confirm the numbers, who the carrier is, and the timing. If it is a carrier number, ask for the PIN (mobile) or the account number (landline) on that call and type it straight into Twilio's Console in step 3. Never write it anywhere else.

## 1. Decide where the number goes (the target account)

One builder, one Twilio account (SETUP.md 7f; migrations 292 and 295 enforce it):

- **Our own business (`structure-studio`)**: the parent account. Target Account SID = the parent's.
- **Any other builder**: their own sub-account. Open Admin, the builder, Account, **Twilio account**. If it says "None yet", press Create (it needs can_bill, and `TWILIO_SUBACCOUNTS` must be `manual` or `on` before the number is used). Note the masked SID there and copy the full SID from Twilio's Console (Account, Subaccounts). That is the target Account SID.
- A builder who already has a number or a texting registration on our main account stays there (the card says why). Target = the parent.

Never move a number into an account other than the builder's own: `phone_adopt_number` refuses it later anyway.

## 2. Texting first, if they text

A moved number does NOT keep its texting (A2P 10DLC) registration. It belongs to the brand and campaign of the account it left, and brands and campaigns cannot move between accounts. So:

- Before the move, have the builder submit the Text Messaging tab in Structure Studio (it registers their brand and campaign in the target account, which takes days).
- When the number lands, adopting it puts it into that texting setup; its own carrier registration then runs on its own (usually within a few days). Until then calls work and texts from it do not.
- Expect texts on that number to be down from the cutover until its registration clears (a few days to three weeks). Tell the builder before the date.

## 3a. A GoHighLevel (LC Phone) number: a HighLevel ticket, not a port

An LC Phone number already lives in HighLevel's own Twilio account, so Twilio's Port In does not apply. HighLevel moves it between Twilio accounts.

1. Open a support ticket with HighLevel (from the builder's GoHighLevel account, or ask them to). Give, exactly:
   - the gaining Twilio **Account SID** (step 1's target);
   - the builder's HighLevel **Location ID**;
   - the numbers in E.164 (`+1XXXXXXXXXX`);
   - the cutover window the builder asked for.
2. No Twilio ticket is needed. HighLevel usually finishes in 1 to 2 business days and says so on the ticket.
3. The A2P registration does not carry over (section 2). Their GoHighLevel texting on that number stops at the move.

## 3b. Any other carrier: a Twilio Port In, made in the Console

1. In Twilio's Console, Phone Numbers, Port & Host, **Port In**. Start the request so the numbers land in the TARGET account (step 1): choose that sub-account in the request (the Port In request carries an `account_sid`), or switch to the sub-account first. The parent receives the port's status emails and webhooks either way.
2. Fill in what Twilio asks, from your call with the account holder: the service address, the PIN (mobile) or the account number (landline), and the authorised person's name and email. Type the PIN or account number here and nowhere else.
3. Upload a recent bill from the current carrier (Twilio's Documents upload in the same request). Delete your local copy afterwards.
4. Twilio emails the Letter of Authorization (LOA) to the authorised person. They must e-sign it within 30 days, or the request lapses.
5. The target date is at least 7 days out, and Twilio does not guarantee it. Only US local and mobile numbers, no toll-free (up to 1,000 per request).
6. To cancel, do it more than 72 hours before the port date. After that it goes ahead.
7. Twilio's Port In pricing: check it in the Console before submitting. Nothing in Structure Studio bills the port itself.

## 4. When the number has arrived: adopt it

1. Check the number is in the TARGET account (Console, that account, Phone Numbers, Active numbers). A HighLevel move or a completed port shows it there.
2. In Structure Studio, view as the builder, Settings, Phone, **Bring your number**, **Adopt a moved number**. Enter the number and press it. (Operator only, with can_bill: portal-settings `phone_adopt_number`.)
3. It finds the number in the builder's own account and refuses one that is anywhere else (another builder's, or our main account while the builder has their own). Then it records it the way a bought number is recorded, sets its Twilio FriendlyName to the builder's id, points its calls at My Synergy Phone (calling on) or at voicemail (calling off), its texts at Structure Studio, joins it to their texting setup if texting is on, and marks the request done.
4. Set who answers it on the Phone tab, then caller ID (SHAKEN/STIR, Voice Integrity, CNAM) on the Caller ID card. A builder who only calls needs "Add the business details" first (SETUP.md 7f step 6.5).
5. Money: the number bills monthly at Twilio from the day it lands. Adopting takes no first-month wallet hold (it is not a purchase); from the second month the daily number-fee cron charges it like any other number, once that meter is armed (SETUP.md 7b).

## 5. If something goes wrong

- **Adopt says "isn't in this builder's Twilio account yet"**: the move has not finished, or it landed elsewhere. Check the port status or the HighLevel ticket.
- **Adopt says it "landed on Structure Studio's main Twilio account"**: it went to the parent instead of the sub. Moving a number between our own accounts is a transfer by the parent (`POST IncomingPhoneNumbers/{PN}` with the target `AccountSid`, parent's auth token): its webhooks are cleared and any texting registration must be redone. Do it on purpose, never as a guess, then adopt.
- **A port is rejected** (wrong PIN, wrong address, name mismatch): Twilio says why in the Console. Fix it there and resubmit. Nothing here changes.
- **Cancel a request** the builder no longer wants: Admin, Builders, Bring-your-number requests, **Cancel**. Tell them first.

## 6. Never

- Store a PIN, password, account number, bill or LOA in our database, an email, Monday, a chat or a file in this repo.
- Port a number into an account other than the builder's own.
- Close a sub-account that still holds numbers (closing releases them for good).
