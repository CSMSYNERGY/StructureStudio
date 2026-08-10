-- 106_billing_grant_release_note: What's New entry for owner-granted Billing (commit 6446ac4).
--
-- This one IS publishable, unlike the pricing work the same audit produced. The rule
-- (CLAUDE.md, Carolyn 2026-07-26) bars notes about what we charge or what we are willing
-- to reveal about it. This is neither: it is a permission an owner can now hand out, which
-- is something a tenant gains and can USE. The note says nothing about prices.
--
-- Worded around the OWNER's decision rather than the mechanism — "you can let one admin
-- handle the subscription" is the thing they act on; ownerGranted vs ownerOnly is ours.
-- The default is stated explicitly because "no admin has this unless you say so" is the
-- reassurance an owner needs before they trust the switch at all.
--
-- status = 'beta' (migration 103): on beta, not yet on main. Monday's merge workflow flips
-- it to 'shipped' — do not hand-set it.
--
-- Hand-apply via the SQL editor / MCP and record as version 106 — NEVER `supabase db push`.

insert into public.release_notes (released_at, kind, title, detail, status, sort_order)
values
  (current_date, 'feature',
   'Let an admin handle your subscription',
   'Billing used to be owners-only. Now an owner can hand it to one trusted admin: open '
   || 'Settings → Team, pick the person, and switch Billing on for them. No admin gets it '
   || 'unless you grant it — it stays off by default for everyone — and an admin who has it '
   || 'cannot pass it on to anyone else. Change that person''s job title away from Admin and '
   || 'their billing access ends with it.',
   'beta', 10);
