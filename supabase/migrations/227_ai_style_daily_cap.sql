-- 227 — The AI drafting daily cap becomes per-tenant, and CSM Synergy's own tenant is unlimited.
--
-- WHY. `calibrate_style_ai` has had a hard-coded DAILY_CAP of 10 since 086. That number exists to
-- bound spend on a paid model call reachable by any owner or admin, and for a real builder it is
-- the right shape — nobody calibrates one style eleven times in a day by accident.
--
-- It is the wrong shape for the tenant we DEVELOP on. Building the video/photos calibration on
-- 2026-09-10/11 burned all ten on `structure-studio` inside a day, and the eleventh press was
-- refused with "Daily limit reached" — while the meter was disarmed, so those generations cost
-- nothing and the cap was protecting nothing. Ahsan: "unlimited limit for only structure studio".
--
-- ⛔ NOT A HARD-CODED CLIENT ID IN THE EDGE FUNCTION. Putting "structure-studio" in a `if`
-- branch would make one tenant special in code that every tenant runs, and the next exemption
-- would add a second branch. `client_settings` is where per-tenant policy already lives and it is
-- SERVICE-ROLE ONLY — a tenant can neither read nor raise their own cap, exactly as with
-- `billing_exempt` (057), which this deliberately mirrors.
--
-- THE VALUES, and note that 0 is the interesting one:
--   NULL  use the built-in default (10). Every existing tenant reads this and is unchanged.
--   0     UNLIMITED — skip the count entirely. Chosen over "a very large number" because the
--         function can then skip the COUNT query altogether rather than running one whose answer
--         cannot matter, and because "0" reads as a deliberate switch where "99999" reads as a
--         value somebody guessed.
--   n>0   that many per rolling 24 hours.
--
-- ⚠️ THIS DOES NOT DISABLE THE WALLET. The $20 hold is taken by `wallet_hold` further down the
-- same branch and is untouched by this column: an unlimited tenant with an armed meter still pays
-- per generation. The cap and the charge are two different controls and confusing them would be
-- an expensive mistake — raise the cap, and the spend limit is the WALLET BALANCE, nothing else.

alter table public.client_settings
  add column if not exists ai_style_daily_cap integer;

comment on column public.client_settings.ai_style_daily_cap is
  'AI style drafts allowed per rolling 24h. NULL = the built-in default (10); 0 = unlimited '
  '(the count is skipped); n = that many. Service-role only, like billing_exempt — a tenant '
  'must not be able to raise their own spend cap. Does NOT affect the per-generation wallet '
  'hold: an unlimited tenant with an armed meter still pays for every generation.';

-- CSM Synergy's own tenant: unlimited. This is the development and demo account — the one that
-- runs a style calibration twenty times in an afternoon because somebody is building the feature.
update public.client_settings set ai_style_daily_cap = 0 where client_id = 'structure-studio';

-- Refuse to report success if either half did not land. A missing column fails SILENTLY in the
-- edge function — the select returns an error, the code falls back to the default, and the cap
-- stays at 10 while this migration claims to have lifted it.
do $$
declare got integer;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'client_settings' and column_name = 'ai_style_daily_cap'
  ) then
    raise exception '227 did not add client_settings.ai_style_daily_cap';
  end if;
  select ai_style_daily_cap into got from public.client_settings where client_id = 'structure-studio';
  if got is null or got <> 0 then
    -- Not fatal: a project without that tenant (a fresh clone, a branch database) is legitimate.
    raise notice '227: structure-studio not set to unlimited (value %). Set it by hand if this is the live project.', got;
  end if;
end $$;
