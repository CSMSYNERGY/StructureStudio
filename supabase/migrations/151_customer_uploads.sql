-- 151_customer_uploads.sql — the files a CUSTOMER sends, kept apart from the ones we make.
--
-- Carolyn spent the longest stretch of the 2026-08-26 call on this (20:08–26:45): "documents
-- is what we create ... customer files is like customer files", and "I don't want it all
-- mixed together." The naming half shipped on 08-28 (Design Documents / Customer Uploads);
-- this is the storage behind the second one, which was greyed until now.
--
-- She raised the cost herself in the same breath — "we just need to cap what their storage
-- limits are" — which is why a per-tenant quota is in this migration rather than deferred to
-- the first surprise invoice.
--
-- ── ZERO STORAGE POLICIES, AND THAT IS THE LOAD-BEARING DECISION ──────────────────────
--
-- The obvious pattern here is feedback-attachments (054) / models (094): a private bucket
-- with a tenant-prefix policy pair, `(storage.foldername(name))[1] = current_client_id()`,
-- letting the browser upload directly. It would work perfectly for an owner and SILENTLY
-- 403 EVERY OPERATOR.
--
-- `current_client_id()` (001) reads the CALLER'S OWN client_users row. Operator view-as is a
-- `targetClientId` field on an edge-function POST, honoured only by resolveTenant — storage
-- RLS never sees it, and `sb.storage` is not in SS_TENANT_SCOPED_FNS because there is no
-- request body to inject into. So in view-as the path prefix would be the VIEWED tenant
-- while the policy compares against the OPERATOR's, and the upload fails. Worse, an operator
-- with no client_users row at all gets NULL, and every storage policy fails closed.
--
-- The record page is reachable in view-as. So this bucket takes the pm-attachments posture
-- (144): private, NO policies, and every read and write goes through portal-settings with
-- the service role, where resolveTenant has already resolved which tenant we are acting for.
-- Uploads use a one-time signed URL so the bytes still go browser→storage directly and never
-- through the function (the 25 MB-through-an-edge-function problem the base64 upload actions
-- have).
--
-- ⚠️ Do NOT "fix" this later by adding a tenant-prefix policy pair. It would appear to work
-- in every test done as an owner.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-uploads', 'customer-uploads', false, 26214400,   -- 25 MB per object
  -- What a customer actually sends a builder: a photo of their site, a permit, a sketch, a
  -- spec sheet. Deliberately no video — a phone clip is hundreds of megabytes and would eat
  -- a tenant's whole quota in one drop, and nobody asked for it.
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── The metadata table ────────────────────────────────────────────────────────────────
-- Storage alone cannot answer "whose file is this, on which contact, and who put it there" —
-- `list()` gives names and sizes and nothing else. It is also what makes the quota a cheap
-- sum instead of a bucket walk.
create table if not exists public.crm_files (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  contact_id  uuid references public.crm_contacts(id) on delete cascade,
  short_code  text,
  path        text not null unique,
  name        text not null,
  size_bytes  bigint not null default 0,
  mime        text,
  uploaded_by uuid,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- The record page's read: one contact's files, newest first.
create index if not exists crm_files_contact_idx
  on public.crm_files (client_id, contact_id, created_at desc)
  where contact_id is not null and deleted_at is null;
create index if not exists crm_files_code_idx
  on public.crm_files (client_id, short_code, created_at desc)
  where short_code is not null and deleted_at is null;
-- The quota sum. Partial on deleted_at so a tenant gets their space back when they remove a
-- file, without the sum having to filter at read time.
create index if not exists crm_files_quota_idx
  on public.crm_files (client_id) where deleted_at is null;

alter table public.crm_files enable row level security;
-- ⚠️ NO GRANT AND NO POLICY, deliberately — the client_settings / wallet_accounts posture.
-- The browser never reads this table: files ride the record page's single crm_record fetch,
-- already paired with short-lived signed URLs, because a direct read would return nothing in
-- operator view-as anyway. Revoking here means there is no second access path to keep true.
revoke all on public.crm_files from anon, authenticated;

comment on table public.crm_files is
  'Files a CUSTOMER sent, as opposed to the documents we generate (Carolyn 2026-08-26: '
  '"I do not want it all mixed together"). Bucket customer-uploads is private with NO storage '
  'policies — every read and write goes through portal-settings with the service role, because '
  'storage RLS cannot see operator view-as. Rows are soft-deleted so the quota is a sum over '
  'deleted_at is null.';

-- ── The per-tenant cap ────────────────────────────────────────────────────────────────
-- Carolyn: "we just need to cap what their storage limits are." NULL means "use the platform
-- default", which lives in the edge function so raising it for everybody is a deploy and
-- raising it for one builder is an UPDATE — the shape 128_usage_wallet settled on.
--
-- client_settings is service-role only, so a tenant can neither read their cap nor raise it.
alter table public.client_settings
  add column if not exists storage_quota_bytes bigint;

comment on column public.client_settings.storage_quota_bytes is
  'Per-tenant Customer Uploads cap. NULL = the platform default in portal-settings. '
  'Set per builder if one needs more; never read or set by the browser.';
