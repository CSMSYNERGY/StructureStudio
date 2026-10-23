-- 330_crm_custom_fields.sql — every field on a contact and on a design/deal, and as many custom
-- fields as a builder wants (Settings → Customer Hub → Fields).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`, see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('330', '330_crm_custom_fields') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/330_crm_custom_fields.sql | npx supabase db query --linked -o csv
--
-- ── WHY (Carolyn 2026-10-22) ─────────────────────────────────────────────────────────────
-- "We need to show all the current fields for contacts and designs/deals in the customer hub tab
-- under its own tab called fields. We need to allow to add as many custom fields as desired."
--
-- So the Fields tab is a REGISTER first and an editor second: it lists what a contact and a
-- design/deal already hold — the columns that exist today, which nothing in the product has ever
-- shown in one place — and then lets a builder add their own beside them.
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────────────────────────
--   1. crm_field_defs — one row per field a BUILDER has had a hand in. Two kinds:
--        source='custom'   a field they invented. `key` is where its value lives in the jsonb.
--        source='builtin'  an OVERRIDE on one of ours: a relabel, or hidden from the card.
--      A built-in nobody has touched has NO ROW — the catalogue of built-ins lives in code
--      (_shared/crmFields.ts), because the columns themselves live in code. A row is written the
--      first time somebody renames or hides one, so an untouched account reads an empty table and
--      the catalogue is the whole answer. ⚠️ Do NOT seed a row per built-in per tenant: then the
--      catalogue and the table are two copies of one list, and adding a column means a backfill.
--   2. crm_contacts.custom / crm_deals.custom — jsonb, one object per row, the custom fields'
--      VALUES keyed by the definition's `key`.
--
--      Values on the DEAL, not on `designs`, and that is the whole reason "designs/deals" is one
--      field set and not two: since 302/303 every design has a card in Shed Deals, and a card can
--      also exist without a design (a lead in Manufacturer Outreach). The deal is the row both
--      shapes have. Putting them on `designs` would leave every design-less card unable to hold a
--      field, and would put a builder's own columns on the table the public designer writes.
--
-- ── RULES THAT KEEP THIS SAFE ────────────────────────────────────────────────────────────
--   * The jsonb is a FLAT object of scalars. `crm_set_custom` rejects an object or an array value,
--     so nothing can nest a document inside a contact and no read downstream has to defend itself.
--   * A write MERGES. Each save sends only the keys it is changing, so two people editing two
--     different custom fields on one contact cannot blank each other's.
--   * `key` is immutable once made (no UPDATE path sets it). A renamed key orphans every value
--     already stored under the old one, silently, on live data — so the LABEL is what a builder
--     edits and the key is minted once from it.
--   * Deleting a custom field ARCHIVES the definition and leaves the values alone. Carolyn can
--     un-delete, and nothing destroys a column of customer data on one click.
--   * RLS on, ZERO policies, revoked from anon + authenticated: the crm_* posture. The browser
--     never reads these tables directly — portal-settings is service-role and the only door.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- 330. It was written as 328 and RENUMBERED AT APPLY, which is what this section exists for:
-- a sibling session took 328 and 329 (the Meetings video work) while this was being built, and
-- the live ledger is the only thing that knows. Derive the number from it, never from the
-- highest file in your own clone.

begin;

-- ── PART 1 ── the definitions ────────────────────────────────────────────────────────────

create table if not exists public.crm_field_defs (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  -- 'contact' or 'deal'. A design/deal is one entity here, for the reason in the header.
  entity      text not null,
  source      text not null default 'custom',
  -- source='custom': where the value lives in crm_contacts.custom / crm_deals.custom.
  key         text,
  -- source='builtin': which of OUR fields this row overrides (_shared/crmFields.ts's id).
  builtin_key text,
  label       text not null,
  field_type  text not null default 'text',
  -- field_type='select': the choices, in order. Empty for every other type.
  choices     text[] not null default '{}',
  help        text,
  required    boolean not null default false,
  -- Hidden from the contact card and the deal panel. A built-in is never deleted, only hidden;
  -- a custom field is archived instead (archived_at), which also takes it off the card.
  hidden      boolean not null default false,
  position    double precision not null default 1024,
  archived_at timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint crm_field_defs_entity_chk check (entity in ('contact', 'deal')),
  constraint crm_field_defs_source_chk check (source in ('custom', 'builtin')),
  constraint crm_field_defs_type_chk check (field_type in ('text', 'textarea', 'number', 'date', 'select', 'checkbox')),
  -- The two kinds carry different halves of the shape, and neither may wear the other's.
  constraint crm_field_defs_shape_chk check (
    (source = 'custom'  and key is not null and builtin_key is null)
    or
    (source = 'builtin' and builtin_key is not null and key is null)
  ),
  -- A key is a jsonb object key and reaches a builder's browser as a label fallback: keep it to
  -- the shape a key can safely be, so nothing downstream has to quote or escape it.
  constraint crm_field_defs_key_chk check (key is null or key ~ '^[a-z][a-z0-9_]{0,38}$'),
  constraint crm_field_defs_label_chk check (btrim(label) <> '' and length(label) <= 80),
  -- A select with no choices is a drop-down a person cannot answer. Every other type has none.
  constraint crm_field_defs_choices_chk check (
    (field_type = 'select' and array_length(choices, 1) between 1 and 50)
    or
    (field_type <> 'select' and coalesce(array_length(choices, 1), 0) = 0)
  ),
  constraint crm_field_defs_help_chk check (help is null or length(help) <= 200)
);

-- One live custom field per key per entity. Partial on archived_at, so deleting a field frees its
-- key for re-use and an archived one never blocks a new field of the same name.
create unique index if not exists crm_field_defs_key_uq
  on public.crm_field_defs (client_id, entity, key)
  where source = 'custom' and archived_at is null;

-- At most ONE override row per built-in. Not partial: an override is never archived (hiding is
-- what `hidden` is for), and a second row for one built-in would make "which label?" ambiguous.
create unique index if not exists crm_field_defs_builtin_uq
  on public.crm_field_defs (client_id, entity, builtin_key)
  where source = 'builtin';

create index if not exists crm_field_defs_client_idx
  on public.crm_field_defs (client_id, entity, position);

alter table public.crm_field_defs enable row level security;
revoke all on public.crm_field_defs from anon, authenticated;

-- ── PART 2 ── the values ─────────────────────────────────────────────────────────────────

alter table public.crm_contacts add column if not exists custom jsonb not null default '{}'::jsonb;
alter table public.crm_deals    add column if not exists custom jsonb not null default '{}'::jsonb;

-- An OBJECT, always. Without this a caller that sent an array or a bare string would store it and
-- every reader downstream would need its own defence.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_contacts_custom_obj_chk') then
    alter table public.crm_contacts
      add constraint crm_contacts_custom_obj_chk check (jsonb_typeof(custom) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_deals_custom_obj_chk') then
    alter table public.crm_deals
      add constraint crm_deals_custom_obj_chk check (jsonb_typeof(custom) = 'object');
  end if;
end $$;

-- ── PART 3 ── the one write path ─────────────────────────────────────────────────────────
-- MERGE, never replace, and scalars only. portal-settings has already decided this caller may
-- touch this row (GATES + CONTACT_ROW_SCOPE); this function is what makes the write itself safe.
--
--   p_patch   {key: value}. A JSON null CLEARS that key — which is how a builder empties a field
--             — and a key the definitions do not know is ignored rather than refused, so a stale
--             browser tab cannot write a field that was just deleted.
--   returns   the number of rows changed (0 = no such row, which the caller answers as a 404).
create or replace function public.crm_set_custom(
  p_client_id text,
  p_entity    text,
  p_id        uuid,
  p_patch     jsonb,
  p_actor     uuid default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keys    text[];
  v_patch   jsonb := '{}'::jsonb;
  k         text;
  v         jsonb;
  v_changed integer := 0;
begin
  if p_entity not in ('contact', 'deal') then
    raise exception 'unknown entity';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'a patch object is required';
  end if;

  -- The live custom fields for this entity on this tenant. Anything else in the patch is dropped.
  select coalesce(array_agg(key), '{}'::text[]) into v_keys
    from public.crm_field_defs
   where client_id = p_client_id and entity = p_entity
     and source = 'custom' and archived_at is null;

  for k, v in select * from jsonb_each(p_patch) loop
    if k = any (v_keys) then
      if jsonb_typeof(v) in ('object', 'array') then
        raise exception 'a field value must be a single value, not a list';
      end if;
      v_patch := v_patch || jsonb_build_object(k, v);
    end if;
  end loop;

  if v_patch = '{}'::jsonb then
    return 0;
  end if;

  -- `||` merges, so untouched keys survive; a JSON null is STORED as null and the reader treats a
  -- null the same as a missing key, which is what makes "clear this field" work without a second
  -- code path to strip keys out.
  if p_entity = 'contact' then
    update public.crm_contacts
       set custom = custom || v_patch, updated_at = now()
     where client_id = p_client_id and id = p_id;
    get diagnostics v_changed = row_count;
  else
    update public.crm_deals
       set custom = custom || v_patch, updated_at = now()
     where client_id = p_client_id and id = p_id and archived_at is null;
    get diagnostics v_changed = row_count;
  end if;

  return v_changed;
end;
$$;

revoke all on function public.crm_set_custom(text, text, uuid, jsonb, uuid) from public, anon, authenticated;

-- ── PART 4 ── assertions ─────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'crm_contacts' and column_name = 'custom') then
    raise exception '330: crm_contacts.custom missing';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'crm_deals' and column_name = 'custom') then
    raise exception '330: crm_deals.custom missing';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'crm_field_defs' and c.relrowsecurity) then
    raise exception '330: crm_field_defs has RLS off';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'crm_field_defs') then
    raise exception '330: crm_field_defs must have no policies — it is service-role only';
  end if;
end $$;

commit;
