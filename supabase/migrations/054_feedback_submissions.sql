-- 054_feedback_submissions: client-visible mirror of the Monday bug/feature intake.
--
-- WHY: bugs + feature requests are filed into Monday (Bugs Queue 18419456589 / Feature Requests
-- (Intake) 18420525473) and Monday stays the team's system of record. But a tenant who submits
-- one had no way to confirm it landed or to see what came of it — it went into the abyss. These
-- two tables are the tenant-facing mirror: every submission made from the portal is recorded here
-- FIRST (so it exists even if the Monday push fails), pushed to Monday by the `portal-feedback`
-- edge function, and then kept up to date by the `feedback-monday-webhook` function.
--
-- TRUST BOUNDARY — read before changing anything here:
--   * `feedback_submissions.status` is a SIMPLIFIED, client-facing ladder. Monday's raw labels
--     ("Move to 'Sprints'", "Known Bug", …) are internal vocabulary and are mapped down by the
--     webhook — they are deliberately never stored verbatim in a tenant-readable column.
--   * `feedback_comments` holds ONLY updates the team explicitly marked for the client (the
--     webhook requires the `/client` marker before it will insert). Internal Monday chatter never
--     reaches this table at all, so a future RLS mistake still can't leak it — there is nothing
--     here to leak. Do NOT "simplify" the webhook by mirroring every update into this table.
--
-- Hand-apply via the SQL editor / MCP and record as version 054 — NEVER `supabase db push`.

-- ── Submissions ─────────────────────────────────────────────────────────────
create table if not exists public.feedback_submissions (
  id                uuid primary key default gen_random_uuid(),
  client_id         text not null,                    -- tenant whose portal it was filed from
  submitted_by      uuid,                             -- auth.users id; null only if the user is later deleted
  submitter_name    text not null,                    -- denormalized at submit time: auth.users is not
  submitter_email   text,                             -- browser-readable, so the portal can't join for it
  kind              text not null check (kind in ('bug','feature')),
  title             text not null,
  detail            text,
  -- bug: Critical/High/Medium/Low · feature: Nice to have/Would really help/Critical for me
  severity          text,
  attachment_path   text,                             -- object path in the private feedback-attachments bucket
  -- Client-facing ladder. NOT Monday's labels — see the trust-boundary note above.
  status            text not null default 'submitted'
                      check (status in ('submitted','in_review','planned','in_progress',
                                        'needs_info','shipped','declined','duplicate')),
  monday_item_id    text,                             -- null until the push succeeds
  monday_board_id   text,
  monday_error      text,                             -- last push failure, for operator triage
  created_at        timestamptz not null default now(),
  status_changed_at timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists feedback_submissions_client_idx
  on public.feedback_submissions (client_id, created_at desc);
-- The webhook's only lookup key: Monday item id → our row.
create unique index if not exists feedback_submissions_monday_item_idx
  on public.feedback_submissions (monday_item_id) where monday_item_id is not null;

-- ── Comments (client-visible replies only) ──────────────────────────────────
create table if not exists public.feedback_comments (
  id               uuid primary key default gen_random_uuid(),
  submission_id    uuid not null references public.feedback_submissions(id) on delete cascade,
  monday_update_id text unique,                       -- dedupe: Monday can redeliver a webhook
  author_name      text,
  body             text not null,                     -- marker already stripped by the webhook
  created_at       timestamptz not null default now()
);

create index if not exists feedback_comments_submission_idx
  on public.feedback_comments (submission_id, created_at);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Reads are tenant-scoped and that is ALL the browser may do: every write goes through an edge
-- function on the service role, so a tenant can never forge a status, a Monday id, or a comment.
alter table public.feedback_submissions enable row level security;
alter table public.feedback_comments   enable row level security;

drop policy if exists feedback_submissions_tenant_read on public.feedback_submissions;
create policy feedback_submissions_tenant_read on public.feedback_submissions
  for select to authenticated using (client_id = public.current_client_id());

drop policy if exists feedback_comments_tenant_read on public.feedback_comments;
create policy feedback_comments_tenant_read on public.feedback_comments
  for select to authenticated using (
    exists (
      select 1 from public.feedback_submissions s
      where s.id = feedback_comments.submission_id
        and s.client_id = public.current_client_id()
    )
  );

-- Supabase's default public-schema grants hand anon+authenticated ALL privileges; strip them so
-- writes stay service-role-only even if RLS were ever toggled off, and anon gets nothing at all.
grant select on public.feedback_submissions to authenticated;
grant select on public.feedback_comments   to authenticated;
revoke all on public.feedback_submissions from anon;
revoke all on public.feedback_comments   from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.feedback_submissions from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.feedback_comments from authenticated;

-- ── Attachment bucket ───────────────────────────────────────────────────────
-- PRIVATE (unlike branding/floor-plans): a bug screenshot can show a tenant's own customer data,
-- so it is never anon-readable. The portal reads it back through a short-lived signed URL, and the
-- edge function re-uploads the bytes into the Monday item so the team sees it where they work.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'feedback-attachments', 'feedback-attachments', false, 26214400,   -- 25 MB
  array['image/png','image/jpeg','image/gif','image/webp','video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Object path shape is `{client_id}/{uuid}-{filename}` — the first folder segment IS the tenant
-- check, mirroring the floor-plans bucket convention. No update/delete for tenants: an attachment
-- is evidence attached to a ticket, not a file the submitter keeps managing.
drop policy if exists feedback_attach_tenant_insert on storage.objects;
create policy feedback_attach_tenant_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'feedback-attachments'
    and (storage.foldername(name))[1] = public.current_client_id()
  );

drop policy if exists feedback_attach_tenant_read on storage.objects;
create policy feedback_attach_tenant_read on storage.objects
  for select to authenticated using (
    bucket_id = 'feedback-attachments'
    and (storage.foldername(name))[1] = public.current_client_id()
  );

-- Rollback:
--   drop policy feedback_attach_tenant_read on storage.objects;
--   drop policy feedback_attach_tenant_insert on storage.objects;
--   delete from storage.buckets where id = 'feedback-attachments';
--   drop table public.feedback_comments;
--   drop table public.feedback_submissions;
