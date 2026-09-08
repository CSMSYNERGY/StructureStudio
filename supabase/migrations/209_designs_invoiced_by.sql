-- 209_designs_invoiced_by (renumbered from 207 — upstream took that number the same day): who invoiced a design, denormalised onto the design so the board
-- can filter on it (Carolyn, 2026-09-07 — "a filter option to see quoted created by: (person)
-- or updated by: (person) or invoiced by: (person)").
--
-- 206 added created_by_user_id and updated_by_user_id. This is the third of the three, and it
-- is the ONLY one that already has history: `invoice_sends.sender_user_id` has been written on
-- the GHL branch since the beginning and on the SS branch since 2026-09-02.
--
-- ── WHY A COPY AND NOT A JOIN ───────────────────────────────────────────────────────────
-- `invoice_sends` is service-role only. `authenticated` has NO select privilege on it at all
-- (verified: has_table_privilege('authenticated','invoice_sends','select') = false), and that
-- is deliberate — it carries gateway ids, QuickBooks ids and send failures. The Pipeline board
-- reads `designs` over direct PostgREST, so it cannot see the invoicer where it lives, and
-- opening that table to the browser to power a filter would be a bad trade.
--
-- With the copy, all three roles are three columns on one table and the filter is the same
-- client-side predicate the other facets use. No join, no second round trip, no new read path.
--
-- ⚠️ AN OPERATOR-SENT INVOICE BELONGS TO NOBODY, and that rule is not invented here — it is
--    copied from portal-commissions/index.ts:811, which decides who gets paid:
--        if (iv.sender_user_id && !iv.sent_by_operator) senderByCode.set(...)
--    CSM Synergy staff sending an invoice on a builder's behalf must not make it a rep's deal,
--    in the payout OR in the filter. If these two ever disagree, someone is looking at a list
--    of "their" sales that does not match their commission statement.

alter table public.designs
  add column if not exists invoiced_by_user_id uuid;

comment on column public.designs.invoiced_by_user_id is
  'Who sent the invoice, copied from invoice_sends.sender_user_id (which the browser cannot '
  'read). NULL when an operator sent it — same rule portal-commissions uses to decide the '
  'commission earner, and the two must never disagree.';

-- ⛔ THE BACKFILL MATCHES NOTHING TODAY, AND THE REGEX BELOW IS WHY IT DOES NOT CRASH.
--
-- `invoice_sends.sender_user_id` is TEXT, and a plain `::uuid` cast on it FAILS on live data:
--     ERROR: invalid input syntax for type uuid: "sSwnnDQe6turi4MI29Dj"
--
-- That is a GoHighLevel user id. Measured on live while writing this migration:
--     issued_by='ghl'             10 rows, 10 senders, 0 of them a uuid
--     issued_by='structurestudio'  7 rows,  0 senders
--     senders matching a portal user:                  0
--
-- The GHL branch has always stored the GHL account's own user id, which is a different
-- namespace from Supabase auth uids and has no mapping to `client_users`. So there is no
-- historical invoicer that can be resolved to a person in this product, and this column
-- starts empty exactly like created_by/updated_by in 206. It fills from the StructureStudio
-- branch, which writes a real auth.uid().
--
-- The regex is therefore not defensive padding — it is the thing that stops a GHL id being
-- forced into a uuid column and, worse, matched against a portal person it is not.
--
-- ⚠️ WORTH KNOWING BEYOND THIS MIGRATION: portal-commissions:858 already discards these the
--    same way (`if (earner && !teamSet.has(earner)) earner = null`), so every GHL-sent invoice
--    resolves to no commission earner. Live right now: 21 commission_entries, 3 with an earner,
--    ZERO with an amount. Commission attribution is not working today, and it is not this
--    filter's job to fix it — but the filter cannot be more accurate than the data under it.
update public.designs d
   set invoiced_by_user_id = s.sender_user_id::uuid
  from public.invoice_sends s
 where s.client_id = d.client_id
   and s.short_code = d.short_code
   and s.sender_user_id is not null
   and s.sent_by_operator is null
   and s.sender_user_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   and d.invoiced_by_user_id is null;

-- Rollback:
--   alter table public.designs drop column if exists invoiced_by_user_id;
