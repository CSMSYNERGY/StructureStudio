-- 182_insulation_rate_to_browser.sql — insulation prices its own quote line (Carolyn,
-- 2026-09-02: "I need all the pricing to show in the quote, line by line").
--
-- This REVERSES a decision from 177, deliberately and with her say-so. 177 emitted no rate at
-- all — "no price until the quote" — so the designer's quote breakdown showed insulation as a
-- measurement with an empty money column while every other line carried a total. Insulation was
-- the ONLY line in the whole breakdown that could not price itself, and it was this omission
-- that caused it: the browser had nothing to multiply.
--
-- The rate is gated on show_pricing exactly like layoutPricing and the electrical package —
-- NULLED rather than dropped (the colors[] idiom), so a tenant who hides prices still gets the
-- choice, still sees the square footage, and simply gets no number. That is why this does not
-- reintroduce a leak: an unpriced-to-them tenant's browser learns nothing it did not already
-- know from layoutPricing.
--
-- The server is unchanged and remains the authority: submit-estimate re-reads rate_per_sqft
-- from insulation_offerings and re-derives the square footage. This only lets the PREVIEW show
-- the same arithmetic the estimate will do, which is the whole point — a customer should not
-- meet the insulation price for the first time in an email.

begin;

do $mig$
declare
  src text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text; new_blk text;
begin
  old_blk := $anchor$        select jsonb_agg(jsonb_build_object('type', io.ins_type, 'area', io.area)
                 || case when coalesce(io.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
               order by io.ins_type, io.area)$anchor$;

  new_blk := $repl$        select jsonb_agg(jsonb_build_object('type', io.ins_type, 'area', io.area,
                 'ratePerSqft', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
                                     then io.rate_per_sqft else null end)
                 || case when coalesce(io.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
               order by io.ins_type, io.area)$repl$;

  if position('ratePerSqft' in src) > 0 then
    raise notice '182: insulation already emits its rate.';
    return;
  end if;
  if position(old_blk in src) = 0 then
    raise exception '182: the 178 insulation block was not found in the LIVE get_config body — '
                    're-derive the anchor from a fresh pg_get_functiondef dump.';
  end if;
  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- Every tenant's get_config md5 moves. What must NOT change is which combinations are OFFERED:
-- the where-clause is untouched, so a blank rate still means not offered and a hide-prices
-- tenant still gets every row they had before, with a null rate.
