-- Backfill: Junior Barns' pre-existing Monday submissions into the portal (2026-07-26)
--
-- WHY: everything Nevin filed before this date went through the old Monday WorkForm
-- iframe, which left NO record on our side — so "My Submissions" would have opened
-- empty for the one tenant who has actually been using it. This links his existing
-- Monday items to `feedback_submissions` so the portal shows real history, and so any
-- future status change or /client reply on those items syncs through normally.
--
-- NOT a schema migration — one-off tenant data. Idempotent (ON CONFLICT on the
-- monday_item_id partial unique index), so re-running is a no-op.
--
-- Two editorial decisions worth knowing about:
--
--   1. `detail` is CLIENT-VISIBLE. The Monday descriptions carry internal asides
--      ("Carolyn to locate where this is edited", "Carolyn's UI notes from the 7/1
--      call", implementation notes). Those are rewritten here into the substance of
--      the request in client-facing language. Do not "fix" this by re-copying the raw
--      Monday text — that is exactly the leak the /client marker exists to prevent.
--
--   2. Monday item 12461925094 ("Reverse swing option on single doors", from the 7/1
--      call notes) is DELIBERATELY OMITTED: it duplicates 12536439038, which is the
--      same request in Nevin's own words and carries his own priority ("Critical for
--      me"). Backfilling both would show him the same item twice. If you'd rather he
--      saw it, add it with status 'duplicate' so it reads as "Already tracked".
--
-- Statuses are the client-facing ladder, mapped from each item's current Monday label
-- exactly as the sync functions would map it. `status_changed_at` is left NULL: we
-- don't know when each transition actually happened, and inventing a date would show
-- a wrong "Last update" in the portal.

insert into public.feedback_submissions
  (client_id, submitted_by, submitter_name, submitter_email, kind, title, detail,
   severity, status, monday_item_id, monday_board_id, created_at)
values
-- ── Bugs Queue (18419456589) ────────────────────────────────────────────────
('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'bug', 'Door on end wall mislabels LEFT and RIGHT',
 $d$When placing a door on the end wall of a shed, it mislabels the LEFT/RIGHT sides. LEFT and RIGHT should be based on where you enter the shed, not the view from above on the floor plan.$d$,
 'High', 'planned', '12536425892', '18419456589', '2026-07-15T04:47:54Z'),

('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'bug', 'Page overflow when selecting colors, and building image missing from the estimate',
 $d$Page overflows while selecting the colors.

The building image is not showing in the estimate.$d$,
 'Critical', 'shipped', '12457130259', '18419456589', '2026-07-06T16:02:35Z'),

('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'bug', 'Paint, loft and discount issues on the quote',
 $d$Paint shows up in Structure Studio when the color is TBD, but the quote shows no charge.

Loft area is included in Northwood, but the customer is charged when one is placed.

Discounts are showing twice in the verbiage, which is confusing.

The Details section is great — if it added up and showed a subtotal that would be even better.$d$,
 null, 'shipped', '12490706217', '18419456589', '2026-07-09T15:15:44Z'),

-- ── Feature Requests (Intake) (18420525473) ─────────────────────────────────
('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'feature', 'Live pricing / "Show calculations" toggle in the designer',
 $d$Show running prices as options are selected, before the estimate is sent, with a hide/show toggle — so you can build silently and then reveal the price to the customer.

Ideally prices would be editable live in front of the customer (e.g. override a $200 loft to $300 on the spot). A workable fallback is showing prices read-only and adjusting via a custom option or discount line.$d$,
 'Would really help', 'shipped', '12461924801', '18420525473', '2026-07-07T00:03:29Z'),

('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'feature', 'Show paint as its own line item',
 $d$Keep the painted/unpainted selector, but move paint pricing so it appears as a separate line on the estimate (e.g. "Northwood 8x16 — $5,800" then "Paint — $1,120"). Paint is priced at 20% of the base building price.

This fixes the recurring customer confusion where the shed price looks like it jumped.$d$,
 'Would really help', 'shipped', '12461924802', '18420525473', '2026-07-07T00:03:30Z'),

('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'feature', 'Embed the floor plan image in the estimate email',
 $d$The floor plan currently goes out only as a PDF attachment, which is clunky — many customers never open it. Show the floor plan as an image inside the body of the estimate email, not just as an attachment.$d$,
 'Would really help', 'in_review', '12461934189', '18420525473', '2026-07-07T00:03:29Z'),

('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'feature', 'Single/double door pricing and decline-for-credit',
 $d$The included single door isn't truly free — about $100 is baked into the base price. Let the customer place the included single door, or cross it out to decline it and get a $100 credit.

Also add both single ($100) and double ($200) doors as chargeable add-on options, so extra doors can be added and charged (e.g. a 24 ft build with several doors down the side).$d$,
 'Would really help', 'shipped', '12461925547', '18420525473', '2026-07-07T00:03:30Z'),

('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'feature', 'Manual delivery & setup fee field',
 $d$Add a "Delivery and Setup" field where you type the dollar amount yourself — not a mileage-based auto-calculation, since mileage isn't comparable around Humboldt due to terrain and road construction.

It should populate into the estimate total, ideally as a distinct third section: included / extra options / delivery.$d$,
 'Would really help', 'shipped', '12461924971', '18420525473', '2026-07-07T00:03:30Z'),

('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'feature', 'Per-size included loft square footage',
 $d$Loft currently just shows "included." Each building size includes a specific loft square-footage allowance that varies by size — enter that allowance per size and charge for any loft beyond it.$d$,
 'Would really help', 'shipped', '12461925409', '18420525473', '2026-07-07T00:03:30Z'),

('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'feature', 'Editable estimate email template',
 $d$A way to customize the estimate email — add a personal note (e.g. "please see the attached floor plan") so it sounds more like you.$d$,
 'Nice to have', 'submitted', '12461925566', '18420525473', '2026-07-07T00:03:30Z'),

-- Logged by CSM Synergy off the 7/1 call rather than submitted by Nevin — attributed
-- honestly so it doesn't read as something he filed.
('junior-barns', null, 'CSM Synergy', null,
 'feature', 'Included-options UI polish',
 $d$Separate the included items (single door, loft) with a divider line, and gray out an included item once it has been placed so it's obvious it has been used. Move the additional paid options below.$d$,
 'Nice to have', 'submitted', '12461934190', '18420525473', '2026-07-07T00:03:30Z'),

('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'feature', 'Custom line-item options I can manage myself',
 $d$Ability to add options for customers to choose from — similar to how we can add shed styles with pricing and photos for that style. For example, "Tall Wall option priced by perimeter ft" or "Insulation Package priced by sq ft".

I understand that an item needing placement on the floor plan would require staff involvement. I'm talking about line-item options I want to make available and easily add or subtract from the form.$d$,
 'Nice to have', 'in_review', '12535889415', '18420525473', '2026-07-15T02:25:55Z'),

('junior-barns', 'b89da2e7-1ff8-4bd6-8910-3f37f54c6e94', 'Nevin Friesen', 'info@jrbarns.com',
 'feature', 'Reverse swing option on single doors',
 $d$Ability to reverse the swing on a single door (left/right hand). Single doors only — double doors are always done the same way.

Swing direction is currently marked by hand with a red pen after printing.$d$,
 'Critical for me', 'planned', '12536439038', '18420525473', '2026-07-15T04:44:11Z')

on conflict (monday_item_id) where monday_item_id is not null do nothing;
