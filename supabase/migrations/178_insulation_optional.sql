-- 178_insulation_optional.sql — insulation becomes genuinely opt-in, per type, with the same
-- internal-only switch every other priced thing has (Carolyn, 2026-09-02).
--
-- Three asks, and two of them were only IMPLICIT in 177:
--
-- 1. "Optional for builders to offer." 177 made insulation vanish when no rate was filled in,
--    which is true but not the same thing: it is discovered by accident rather than chosen, and
--    a builder could not switch it off for a season without wiping their rates. A master flag
--    on client_settings, DEFAULT FALSE, makes it an explicit decision. Same shape as
--    ramp_enabled, which is the closest precedent in the file.
--
-- 2. "Specify if they offer batt or spray foam or both." That is what insulation_offerings.
--    `active` was always for — 177 filtered on it but never exposed it, so the portal had no
--    way to say "we don't do spray foam" except by clearing three rates. The portal now edits
--    it per TYPE; no schema change needed, which is why there is none here.
--
-- 3. internal_only, which I simply missed. Semantics copied from style_wall_heights, not
--    invented: offered in the REP designer, hidden from the customer-facing page, and
--    VISIBILITY ONLY — a rep-selected area still prices, exactly as an already-placed
--    internal-only item still prices. Edited per type, so all three areas of a type agree.

begin;

alter table public.insulation_offerings
  add column if not exists internal_only boolean not null default false;

alter table public.client_settings
  add column if not exists insulation_enabled boolean not null default false;

comment on column public.insulation_offerings.internal_only is
  'Offered in the REP designer only, hidden from the customer-facing page. Visibility only: a rep-selected area still prices. Edited per TYPE in the portal, so all three areas of a type carry the same value.';
comment on column public.client_settings.insulation_enabled is
  'Master switch. Defaults FALSE so insulation is genuinely opt-in — a builder turns it on rather than discovering it because a rate happens to be filled in. Off hides the whole option without wiping the rates.';

-- get_config: gate the whole key on the switch, and emit internalOnly sparsely. Spliced onto
-- 177's own block, so 177 must be applied first — the anchor check below says so out loud.
do $mig$
declare
  src text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text; new_blk text;
begin
  old_blk := $anchor$    'insulation', coalesce((
      select jsonb_agg(jsonb_build_object('type', io.ins_type, 'area', io.area) order by io.ins_type, io.area)
      from public.insulation_offerings io
      where io.client_id = cc.client_id and io.active and io.rate_per_sqft is not null), '[]'::jsonb),$anchor$;

  new_blk := $repl$    'insulation', case when coalesce((select cs.insulation_enabled from public.client_settings cs where cs.client_id = cc.client_id), false)
      then coalesce((
        select jsonb_agg(jsonb_build_object('type', io.ins_type, 'area', io.area)
                 || case when coalesce(io.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
               order by io.ins_type, io.area)
        from public.insulation_offerings io
        where io.client_id = cc.client_id and io.active and io.rate_per_sqft is not null), '[]'::jsonb)
      else '[]'::jsonb end,$repl$;

  if position('insulation_enabled' in src) > 0 then
    raise notice '178: get_config already gates insulation on the master switch.';
    return;
  end if;
  if position(old_blk in src) = 0 then
    raise exception '178: 177''s insulation block was not found in the LIVE get_config body — '
                    'apply 177 first, or re-derive the anchor from a fresh pg_get_functiondef dump.';
  end if;
  execute replace(src, old_blk, new_blk);
end
$mig$;

commit;

-- The switch defaults FALSE, so EVERY tenant's insulation key becomes [] on apply — including
-- the one whose rates were seeded in 177. That is the point: nobody offers it until they say so.
-- Turn it on per tenant:  update client_settings set insulation_enabled = true where client_id = '…';
