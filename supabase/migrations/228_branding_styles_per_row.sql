-- 228_branding_styles_per_row.sql — each builder picks how many style photos sit side by side.
--
-- WHY. Carolyn, 2026-09-14 @7:10 (screen share): the designer's style bar holds 8 tiles, and a
-- ninth style (Playhouse) wrapped to a second row. The bar now scrolls sideways (SSStyleStrip,
-- 3bd794a) and reads `config.branding.stylesPerRow`, clamped to 5..8, defaulting to 8. This
-- migration is where that number comes from. It is set in the portal under Settings → Branding
-- ("Building styles per row", portal/03-catalog.jsx) through portal-settings `save_branding`.
--
-- WHAT.
--   1. client_configs.styles_per_row smallint, CHECK 5..8, NULL = never chosen = 8. On
--      client_configs beside accent_color/header_bg because it is the same kind of thing — how the
--      tenant's PUBLIC designer looks — and get_config already reads that row.
--   2. get_config's `branding` object gains `stylesPerRow` SPARSELY: the key is emitted only when
--      the column is set. Until a builder picks a value, their get_config payload is BYTE-IDENTICAL
--      to today's — that is the verification (md5 of every tenant's output, before and after), and
--      it is why a NULL does not emit `"stylesPerRow": null`. jsonb `||` with '{}' is a no-op on
--      the serialised text; checked read-only against all 9 live tenants on 2026-09-15.
--
-- NO NEW TABLE, NO NEW FUNCTION → no grants to revoke. client_configs keeps its posture (015):
-- anon has no table grant at all; authenticated reads its own row through
-- client_configs_owner_read (SELECT only, no write policy), so the new column is readable by the
-- owner and writable only by the service role — exactly like accent_color. get_config is REPLACED
-- in place, and CREATE OR REPLACE keeps its ACL, owner, SECURITY DEFINER and search_path=""; the
-- post-check below still re-asserts anon EXECUTE, because a designer that cannot read its config
-- is every tenant's public page down.
--
-- NUMBERING. 228 was claimed up front for this workstream (229-231 belong to the login session).
-- The live ledger mixes plain versions ('224') with timestamps ('20260908031748'), and on
-- 2026-09-15 it had NO rows for 225, 226 or 227 even though 227's column is live — so "the
-- highest prefix" answers nothing. Check the ledger by NAME before applying.
--
-- ORDER (⛔ this is the part that bites). Apply THIS FIRST, verify it, and only then deploy
-- portal-settings. The function's status read-back names styles_per_row; before this column
-- exists that select fails, and it swallows its error by design. The function now retries with the
-- old column list so the Branding card still loads — but do not lean on the seatbelt.
--
-- SPLICED, NOT REWRITTEN — 110's rule, 205/207's mechanism. get_config has been rewritten wholesale
-- on branches this clone cannot see; pasting a body from a file (159 is the last full one) would
-- silently drop whatever landed since. This reads the LIVE body, inserts one expression after one
-- anchor, and re-executes it. Three guards, and the migration does nothing rather than half a thing:
--   1. Already spliced (`stylesPerRow` in the body) → notice and skip. A re-run is safe.
--   2. The anchor `'accentColor', cc.accent_color)` must occur EXACTLY ONCE. Confirmed against
--      pg_get_functiondef on the live project 2026-09-15 (count 1; body md5
--      7544dac8e99ba4c5be83a7b6466180fd, 16123 chars). If get_config changed shape, this raises.
--   3. The new body is longer by exactly the inserted text: one insertion, no deletion.
--
-- get_config is LANGUAGE sql, so its body is validated at CREATE time: the column must exist
-- before the splice executes, which is why the ALTER comes first inside the same transaction.
--
-- ROLLBACK — in THIS order, or every tenant's designer breaks:
--   1. Un-splice first. A LANGUAGE sql function that names a dropped column fails on every call,
--      and get_config is what every public designer page loads before it can render anything:
--        do $$ declare s text := pg_get_functiondef('public.get_config(text)'::regprocedure);
--               a text := $a$ || case when cc.styles_per_row is not null then jsonb_build_object('stylesPerRow', cc.styles_per_row) else '{}'::jsonb end$a$;
--        begin if position(a in s) = 0 then raise exception 'splice not found'; end if;
--              execute replace(s, a, ''); end $$;
--   2. Then: alter table public.client_configs drop column styles_per_row;
--   3. Then delete the ledger row. Deploy the pre-228 portal-settings first if it is already live
--      (its fallback select keeps the card loading, but a Save Branding that carries stylesPerRow
--      would fail on the missing column).
--
-- HAND-APPLY: pipe this file to `supabase db query --linked` (NOT `--file`, which auth-fails,
-- retries and still exits 0), then record it:
--   insert into supabase_migrations.schema_migrations (version, name) values ('228', '228_branding_styles_per_row');
-- The rehearsal (begin … rollback) and the md5 before/after checks are written out for the
-- integrator separately; run them first.

begin;

-- LOCK TIMEOUT (review, 2026-09-15). The ALTER below takes an ACCESS EXCLUSIVE lock on
-- client_configs. Without a timeout it waits behind any open transaction touching that table, and
-- every get_config call — the boot read for every tenant's public designer, beta AND production —
-- then queues behind the waiting ALTER. 5 s fails fast and rolls the whole file back instead of
-- stalling every designer page; just run it again. `set local` ends with this transaction.
set local lock_timeout = '5s';

-- ── 1. The column ────────────────────────────────────────────────────────────────────────────
alter table public.client_configs
  add column if not exists styles_per_row smallint;

-- The CHECK is added separately rather than inline: `add column if not exists … check (…)` skips
-- the WHOLE subcommand when the column already exists, so a half-applied first run would leave the
-- column with no constraint and a re-run would never add it.
do $con$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.client_configs'::regclass
       and conname  = 'client_configs_styles_per_row_range'
  ) then
    alter table public.client_configs
      add constraint client_configs_styles_per_row_range check (styles_per_row between 5 and 8);
  end if;
end
$con$;

comment on column public.client_configs.styles_per_row is
  'Building styles per row on the public designer''s style bar, 5..8. NULL = never chosen = 8. '
  'Emitted by get_config as branding.stylesPerRow ONLY when set (228). Written by portal-settings save_branding.';

-- ── 2. get_config: branding.stylesPerRow, sparse ─────────────────────────────────────────────
do $splice$
declare
  v_src    text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  v_anchor text := $anchor$'accentColor', cc.accent_color)$anchor$;
  v_add    text := $add$ || case when cc.styles_per_row is not null then jsonb_build_object('stylesPerRow', cc.styles_per_row) else '{}'::jsonb end$add$;
  v_hits   int;
  v_new    text;
begin
  -- GUARD 1 — idempotent.
  if position('stylesPerRow' in v_src) > 0 then
    raise notice '228: get_config already emits stylesPerRow — nothing to splice';
    return;
  end if;

  -- GUARD 2 — the anchor must be unique. It closes the branding jsonb_build_object; if a later
  -- migration added a second object ending in accentColor, a blind replace would splice both.
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '228: anchor % found % time(s), expected exactly 1 — get_config has changed shape; re-derive the anchor from a fresh pg_get_functiondef before retrying', v_anchor, v_hits;
  end if;

  v_new := replace(v_src, v_anchor, v_anchor || v_add);

  -- GUARD 3 — one insertion, no deletion.
  if length(v_new) <> length(v_src) + length(v_add) then
    raise exception '228: spliced body is % chars, expected % — refusing to execute', length(v_new), length(v_src) + length(v_add);
  end if;

  execute v_new;
  raise notice '228: spliced stylesPerRow into get_config branding (% -> % chars)', length(v_src), length(v_new);
end
$splice$;

-- ── 3. Post-checks: raise (and so roll the whole file back) rather than commit a surprise ────
do $check$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_configs' and column_name = 'styles_per_row'
  ) then
    raise exception '228: client_configs.styles_per_row is missing after the ALTER';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.client_configs'::regclass and conname = 'client_configs_styles_per_row_range'
  ) then
    raise exception '228: the 5..8 CHECK is missing';
  end if;
  if position('stylesPerRow' in pg_get_functiondef('public.get_config(text)'::regprocedure)) = 0 then
    raise exception '228: get_config does not mention stylesPerRow after the splice';
  end if;
  if not has_function_privilege('anon', 'public.get_config(text)', 'execute') then
    raise exception '228: anon lost EXECUTE on get_config — every public designer would fail to load';
  end if;
end
$check$;

commit;

-- After this: config.branding = { companyName, tagline, logo, headerBg, accentColor,
-- stylesPerRow?: 5|6|7|8 } — the key is absent, not null, for a tenant that never chose.
