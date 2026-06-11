-- 004_advisor_hardening: cleanups flagged by the Supabase security advisors.
-- APPLIED to project jzeamjbhdrsbygdnphbm on 2026-06-11 (migration: advisor_hardening).

-- 1. Pin search_path on the updated_at trigger function.
alter function public.set_updated_at() set search_path = '';

-- 2. rls_auto_enable is an event-trigger function; it should not be exposed
--    through the RPC surface at all.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
