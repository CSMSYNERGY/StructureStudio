-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 369 — ADD A CARD: a fifth agreement kind, card_add
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger read immediately before writing this (2026-11-05): max(version::int) = 368, while
-- this clone's folder ended at 355 (356–367 were pushed by other sessions and pulled before this
-- was written; 368 is applied live and still uncommitted in another clone). So 369. Re-read BOTH
-- before applying — a file numbered from memory overwrites someone else's work.
--
-- ── WHY (Carolyn, 2026-11-05) ─────────────────────────────────────────────────────────────
-- Builders who pay for StructureStudio by bank transfer have nothing at the gateway, so their
-- usage wallet had no card and no way to get one short of buying $20 of credit. Settings >
-- Billing > Wallet gains "Add a card": a $0 validate that stores the card (portal-billing
-- add_card, update_card's sibling). The agreement the owner ticks for it is a new kind of
-- billing_consents row, card_add, beside card_update (Replace card). 317's CHECK listed four
-- kinds and refuses a fifth; recordConsent throws on the refusal and nothing reaches the gateway,
-- so without this the button is an honest failure, but a failure.
--
-- ── WHAT ─────────────────────────────────────────────────────────────────────────────────
-- Re-issue the CHECK on billing_consents.kind with card_add added. Nothing else: no column, no
-- backfill, no change to the table's posture (service-role only, RLS on, revoked from the API
-- roles). The existing constraint is found by what it constrains rather than by name, because
-- 317 declared it inline on the column and left Postgres to name it.
--
-- ── APPLY ────────────────────────────────────────────────────────────────────────────────
-- By hand, like every migration here (supabase db query --linked, or the SQL editor), then:
--   insert into supabase_migrations.schema_migrations (version, name)
--     values ('369', '369_card_add_consent_kind');
-- Deploy portal-billing AFTER this is applied. Proven offline by tests/sql/migration369.test.cjs.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Re-issue the CHECK with the four kinds. Postgres refuses that while any card_add row exists;
-- those rows are evidence of agreements, so move them aside rather than delete them.

begin;
set local lock_timeout = '5s';

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.billing_consents'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ '\mkind\M'
  loop
    execute format('alter table public.billing_consents drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.billing_consents
  add constraint billing_consents_kind_check
  check (kind in ('subscription_card', 'topup_card', 'auto_topup', 'card_update', 'card_add'));

commit;
