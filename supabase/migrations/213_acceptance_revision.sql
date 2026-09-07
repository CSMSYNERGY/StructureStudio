-- 213_acceptance_revision.sql — the customer can sign the order again, once per amendment.
--
-- WHY. Carolyn: "when an order gets opened up after signed, we need to either get another
-- signature or fill in the details we already have in place for it ... it just needs to happen
-- with the entire order, not just a change order." Today `design_acceptances_invoice_once` is
-- `unique (client_id, short_code) where subject = 'invoice'` — ONE invoice signature per
-- design, forever. A revised order therefore cannot be signed at all.
--
-- THE REVISION IS `change_orders.co_no`, NOT A NEW COUNTER. co_no is already a
-- server-assigned, advisory-locked, per-design sequence that nothing may change (126). A
-- second counter beside it is a second thing to keep in step, and the day they disagree the
-- customer signs a document numbered differently from the change it describes. Revision 0 is
-- the original signature; revision N is the signature on the order as amended by CO-N.
--
-- ONE ROW DOES BOTH JOBS. The signature is against the WHOLE revised order, so the row is
-- `subject='invoice'`, `revision=N` **and** `change_order_id=<the CO>`. That satisfies the
-- existing `design_acceptances_co_once` (unique on change_order_id) and the new invoice index
-- at the same time, with no third shape to reason about. `subject='change_order'` stays in the
-- CHECK for the rows that already carry it and is not used by anything new.
--
-- EVIDENCE STAYS APPEND-ONLY. Nothing is updated and nothing is deleted: revision 0 keeps its
-- own consent sentence, total, tax freeze, IP and user agent verbatim, which is the whole
-- point of the table. Readers asking "is this signed, and for how much" take the HIGHEST
-- revision — `order by revision desc, accepted_at desc limit 1`.
--
-- WHY NOT WIDEN change_orders_ack_shape. It already admits both shapes this needs: a signature
-- with an acceptance_id, or a verbal attestation with a rep name and a conversation date. The
-- rep-attested path writes `method='rep'` on the ACCEPTANCE row (178) while the change order
-- itself stays `ack_method='verbal'`. No constraint change is required, and adding one would
-- be inventing a state.
--
-- Rollback (only while no design has been signed twice — check first):
--   drop index if exists public.design_acceptances_invoice_once;
--   create unique index design_acceptances_invoice_once
--     on public.design_acceptances (client_id, short_code) where subject = 'invoice';
--   alter table public.design_acceptances drop column if exists revision;

-- ── PART 0 — blast radius ──────────────────────────────────────────────────────────────
--   select subject, count(*) from public.design_acceptances group by subject;
--   -- Every existing invoice acceptance becomes revision 0 by the column default, so the new
--   -- index is satisfied by construction and no row moves.

-- ── PART 1 ─────────────────────────────────────────────────────────────────────────────
alter table public.design_acceptances
  add column if not exists revision integer not null default 0;

drop index if exists public.design_acceptances_invoice_once;
create unique index design_acceptances_invoice_once
  on public.design_acceptances (client_id, short_code, revision)
  where subject = 'invoice';

comment on column public.design_acceptances.revision is
  'Migration 213. 0 = the original invoice signature; N = the signature on the order as amended by change order CO-N (revision IS co_no). The highest revision governs. Append-only: earlier revisions keep their own consent text, total and tax freeze.';

-- ── PART 2 — apply-time assertions. These RAISE, aborting the transaction. ─────────────
do $$
declare n int; idx text;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='design_acceptances'
                    and column_name='revision') then
    raise exception '213: the revision column is missing';
  end if;

  -- Nothing moved: every acceptance that already existed is revision 0.
  select count(*) into n from public.design_acceptances where revision <> 0;
  if n <> 0 then raise exception '213: % pre-existing acceptances are not revision 0', n; end if;

  select indexdef into idx from pg_indexes
   where schemaname='public' and indexname='design_acceptances_invoice_once';
  if idx is null then raise exception '213: the invoice-once index is missing'; end if;
  if idx not like '%UNIQUE%' then raise exception '213: the invoice-once index is not unique'; end if;
  if idx not like '%revision%' then raise exception '213: the invoice-once index does not include revision'; end if;
  if idx not like '%subject%' then raise exception '213: the invoice-once index is no longer partial on subject'; end if;

  -- The per-change-order claim must still stand, or one amendment could be signed twice.
  if not exists (select 1 from pg_indexes
                  where schemaname='public' and indexname='design_acceptances_co_once') then
    raise exception '213: design_acceptances_co_once has gone — an amendment could be signed twice';
  end if;

  -- 178's whole safety argument: a browser cannot mint evidence. Re-asserted because this
  -- file touches the table and a widened index invites a widened policy next.
  select count(*) into n from pg_policies
   where schemaname='public' and tablename='design_acceptances' and cmd <> 'SELECT';
  if n <> 0 then raise exception '213: design_acceptances has % non-SELECT policies — writes must stay service-role only', n; end if;
end $$;
