-- 047_list_designs_by_phone: powers the designer's phone-as-login (a returning shopper
-- enters their phone to see their saved designs). SECURITY DEFINER so anon can call it
-- without a direct designs SELECT (designs RLS stays closed to anon).
-- Security posture:
--   * tenant-scoped: only returns rows for the p_client_id passed (the tenant in the URL).
--   * EXACT full-phone match only (>= 10 normalized digits) — no partial/empty match, so
--     it can't be used to "list everything" or brute-force short prefixes.
--   * MINIMAL fields — short_code + style/size + image_url + updated_at. No contact/PII.
--   * set search_path = public to prevent search_path hijacking.
-- Tradeoff (accepted per the 2026-07-22 Carolyn spec): short_code is the capability, so
-- returning it by exact phone means "knowing your own phone + the tenant reveals your
-- designs" — intentional (phone = login). Rate-limiting is a recommended hardening follow-up.
-- Hand-applied via Supabase MCP apply_migration and recorded as version 047 (never db push).
create or replace function public.list_designs_by_phone(p_client_id text, p_phone text)
returns table (short_code text, style text, size text, image_url text, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select d.short_code,
         d.selections->>'style' as style,
         d.selections->>'size'  as size,
         d.image_url,
         d.updated_at
  from public.designs d
  where d.client_id = p_client_id
    and length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) >= 10
    and regexp_replace(coalesce(d.contact->>'phone', ''), '\D', '', 'g')
        = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
  order by d.updated_at desc
  limit 50;
$$;
revoke all on function public.list_designs_by_phone(text, text) from public;
grant execute on function public.list_designs_by_phone(text, text) to anon, authenticated;
-- Rollback: drop function public.list_designs_by_phone(text, text);
