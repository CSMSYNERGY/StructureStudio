-- 175_wall_height_internal_only.sql — wall-height increases gain the same "internal only"
-- switch every other priced thing already has (Carolyn, 2026-09-01).
--
-- SEMANTICS, matched deliberately to client_layout_items.internal_only rather than invented:
-- the increase is offered in the REP designer (the embedded portal mount) and hidden from the
-- customer-facing page. It is a VISIBILITY rule, not a pricing one — an increase a rep
-- selected still prices normally, exactly as an already-placed internal-only item does.
--
-- No server-side gate, and that is considered: an internal-only wall height is a CHARGE, so a
-- forged payload selecting one would only bill the customer MORE. The staff gate in
-- submit-estimate exists for the opposite shape (discounts, a self-applied tax exemption),
-- where the customer's incentive runs against the builder's.

begin;

alter table public.style_wall_heights
  add column if not exists internal_only boolean not null default false;

comment on column public.style_wall_heights.internal_only is
  'Offered in the REP designer only (embedded portal mount), hidden from the customer-facing page. Visibility only: a rep-selected increase still prices normally, matching client_layout_items.internal_only.';

-- get_config: sparse, like every other flag here — the key appears only when it is true, so
-- no tenant's payload changes until somebody ticks the box.
do $mig$
declare
  src text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text; new_blk text;
begin
  old_blk := $anchor$                 || case when swh.widths_ft is not null then jsonb_build_object('widthsFt', to_jsonb(swh.widths_ft)) else '{}'::jsonb end$anchor$;

  new_blk := $repl$                 || case when swh.widths_ft is not null then jsonb_build_object('widthsFt', to_jsonb(swh.widths_ft)) else '{}'::jsonb end
                 || case when coalesce(swh.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end$repl$;

  if position('swh.internal_only' in src) > 0 then
    raise notice '175: get_config already emits the wall-height internalOnly flag.';
    return;
  end if;

  if position(old_blk in src) = 0 then
    raise exception '175: the widthsFt anchor was not found in the LIVE get_config body — '
                    'migration 173 must be applied before this one, and the anchor re-derived '
                    'from a fresh pg_get_functiondef dump if it has since been rewritten.';
  end if;

  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;
