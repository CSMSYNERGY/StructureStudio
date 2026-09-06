-- 193_design_version_legacy_code_redaction.sql
-- Extend migration 156's legacy-code redaction to the two design_versions capability RPCs.
--
-- APPLY BY HAND (SQL editor / MCP execute_sql / `supabase db query --linked`), then record
-- the row in supabase_migrations.schema_migrations. NEVER `supabase db push`.
--
-- ── THE GAP ──────────────────────────────────────────────────────────────────
-- 156 established the rule: a share code shorter than 8 characters is too small to be a
-- credential, so a design read by such a code comes back without the customer's identity.
-- It applied that rule to load_design and stopped there. Two more functions are SECURITY
-- DEFINER, granted to anon, and keyed on exactly the same short_code:
--
--   list_design_versions(p_code)            032 — setof design_versions, newest first
--   load_design_version(p_code, p_version)  031 — one design_versions row
--
-- Both hand back the snapshot's own `contact` (name / phone / email / address) and its own
-- `image_url` (the quote PDF, which prints the same details). So 156's redaction only holds
-- while a legacy design has no version rows — which is true today only because 031 shipped
-- after every one of those short-code designs was created. save_design appends a snapshot on
-- EVERY call, so the first re-save of one of them republishes, under a different function
-- name and the same guessed code, exactly what 156 withheld. A rule that a routine save can
-- undo is not a rule.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────────
-- For codes shorter than 8 characters only, two fields are nulled on the way out of both
-- functions:
--   contact     the PII itself
--   image_url   the quote PDF link
-- That is the whole list: design_versions has no ss_quote_pdf_url and no contact_id, the
-- other two columns 156 redacts. Everything the page actually draws from a version row —
-- version, created_at, selections, items, paint_colors, custom_options, ro_dimensions,
-- bldg_w/h, inventory_unit_id — is untouched, so "All designs on this estimate" still lists
-- every version and Open still restores it. The visible cost on those legacy designs is the
-- per-version PDF link, which the designer already renders conditionally
-- (`ssSafeUrl(v.image_url) && …`), so it simply does not appear. Modern codes are unchanged.
--
-- The threshold, the regexp and the shape are copied from 156 on purpose. Two anon reads of
-- the same customer through the same key must not disagree about who may see the customer,
-- and a second, subtly different rule is how they start to.
--
-- ONE RULE FOR EVERY CALLER, exactly as 156 argued it: these functions are SECURITY DEFINER
-- and deliberately cross-tenant, so 'authenticated' is not a boundary here either, and a
-- projection that changes with who is asking reads as a bug for years. The portal designer
-- calls the same two RPCs, so staff opening one of these legacy versions see the same
-- redacted view. They have not lost the information: the portal's own tables read
-- design_versions straight from PostgREST under RLS (031 design_versions_owner_select,
-- narrowed per area by 154), so Designs, Pipeline and the CRM record page still show the
-- customer and still link the PDF.
--
-- ⚠️ jsonb_populate_record, not a hand-written row constructor — same reason as 156. The
-- column list of design_versions has already grown once (080 inventory_unit_id) and a
-- positional row literal would silently mis-map the next time it grows. Omitted keys come
-- back NULL, which is exactly the redaction.
--
-- ⚠️ BEFORE APPLYING, diff these two bodies against live:
--     select pg_get_functiondef('public.list_design_versions(text)'::regprocedure);
--     select pg_get_functiondef('public.load_design_version(text,int)'::regprocedure);
--   They should match 031/032 verbatim apart from formatting — those are the only definitions
--   in the repo and neither has been re-issued since. If live differs, splice the projection
--   into the LIVE body instead of applying this file as written. 133 and 110 document what
--   rebuilding a wholesale-replaced function from its repo copy costs.
--
-- Signatures, return types, volatility and grants are unchanged; this is a projection change
-- only, so every caller — including the frozen production designer — keeps working.
--
-- Not in scope, and NOT closed by this file: the legacy quote PDFs whose storage key is
-- derived from the bare code sit in a public bucket and remain readable by anyone who
-- resolves a code. See the second item under "WHAT THIS MIGRATION DOES *NOT* CLOSE" in 156.
--
-- ROLLBACK (restores 031/032 verbatim):
--   create or replace function public.list_design_versions(p_code text)
--   returns setof public.design_versions language sql security definer set search_path to ''
--   as $$ select * from public.design_versions where short_code = p_code order by version desc $$;
--   create or replace function public.load_design_version(p_code text, p_version int)
--   returns public.design_versions language sql security definer set search_path to ''
--   as $$ select * from public.design_versions where short_code = p_code and version = p_version $$;

create or replace function public.list_design_versions(p_code text)
returns setof public.design_versions
language sql
security definer
set search_path to ''
as $function$
  select (
    jsonb_populate_record(
      null::public.design_versions,
      case
        when length(regexp_replace(v.short_code, '^SS-', '')) < 8
          then to_jsonb(v) - 'contact' - 'image_url'
        else to_jsonb(v)
      end
    )
  ).*
  from public.design_versions v
  where v.short_code = p_code
  order by v.version desc
$function$;
grant execute on function public.list_design_versions(text) to anon, authenticated;

create or replace function public.load_design_version(p_code text, p_version int)
returns public.design_versions
language sql
security definer
set search_path to ''
as $function$
  select (
    jsonb_populate_record(
      null::public.design_versions,
      case
        when length(regexp_replace(v.short_code, '^SS-', '')) < 8
          then to_jsonb(v) - 'contact' - 'image_url'
        else to_jsonb(v)
      end
    )
  ).*
  from public.design_versions v
  where v.short_code = p_code and v.version = p_version
$function$;
grant execute on function public.load_design_version(text, int) to anon, authenticated;
