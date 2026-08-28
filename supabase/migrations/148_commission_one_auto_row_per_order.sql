-- 148 — One auto commission row per order, enforced by the database.
--
-- THE BUG THIS CLOSES: `compute` in portal-commissions reads every existing
-- commission_entries row ONCE into `existByOrder`, then, for each order it did not find,
-- issues a bare `.insert()`. There is no upsert, no advisory lock, and (until now) no
-- unique constraint. Two computes that both snapshot before either inserts BOTH insert:
-- the order carries two pending lines, the period total double-counts it, and because
-- mark_paid freezes a paid row forever (`if (ex.some(e => e.status === 'paid' …)) continue`)
-- approving and paying that period pays the rep TWICE, with nothing flagging it.
--
-- Overlapping computes are ordinary, not exotic: the tab unmounts when you navigate away
-- without aborting its request, so leaving Commissions mid-compute and coming back starts a
-- second one. Two browser tabs, a reload, or two admins do the same. FOUR client-side guards
-- were attempted and each was rejected in review — a re-entrancy ref covers one mount, a
-- timeout re-arms the buttons while the server is still inserting, and refusing to re-arm
-- locks out a slow tenant whose only escape restarts the very compute at issue. Every one
-- was a browser-side approximation of an invariant only the database can hold. This is that
-- invariant.
--
-- WHY THE PREDICATE IS `is_override = false` AND NOT A PLAIN UNIQUE KEY: a plain unique
-- index on (client_id, order_id) WOULD BREAK SPLITS. `split_order` deliberately deletes an
-- order's unpaid lines and re-inserts SEVERAL rows for that one order, one per rep — all
-- with `is_override = true` (see portal-commissions/index.ts). Compute never touches an
-- order that has an override row, so the two populations are disjoint by construction, and
-- constraining only the auto rows leaves splits, manual adjustments and paid history alone.
-- `is_override` is `not null default false` (078), so there is no NULL that slips past.
--
-- Verified before applying: zero existing violations (18 auto rows, 2 override rows, no
-- duplicate pair) — so this is a latent race being closed, not damage being papered over.
--
-- Apply by hand (SQL editor / MCP / `supabase db query --linked -f`) and record as 148.
-- NEVER `supabase db push` — see the migration ledger note on 126.

create unique index if not exists commission_entries_one_auto_per_order
  on public.commission_entries (client_id, order_id)
  where kind = 'commission' and is_override = false;

comment on index public.commission_entries_one_auto_per_order is
  'At most one AUTO (non-override) commission line per order. The guard against two '
  'overlapping computes each inserting a line for the same order, which double-counts the '
  'period and pays the rep twice once that period is approved and paid. Scoped to '
  'is_override = false on purpose: split_order creates several override rows per order and '
  'must keep working. The losing insert now fails with 23505, which portal-commissions '
  'treats as "another compute already created this row" and skips.';
