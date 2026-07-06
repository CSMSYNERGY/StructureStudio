-- 021_branding_bucket: public storage bucket for per-tenant brand logos uploaded
-- via the portal. Owners upload through the portal-settings edge function (service
-- role, which bypasses RLS), so no owner write policy is needed; the bucket is
-- public so the designer can <img src> the logo via its /object/public/ URL.
-- Anon/authenticated direct writes stay blocked (RLS on storage.objects, no
-- policy for this bucket). HAND-APPLY only. BOM-free.

insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do update set public = true;
