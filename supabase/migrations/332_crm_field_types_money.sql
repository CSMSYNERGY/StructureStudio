-- 332_crm_field_types_money.sql — Phone and Hyperlink field types, and how a Number is shown
-- (currency and the comma). Carolyn 2026-10-23.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`, see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('332', '332_crm_field_types_money') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/332_crm_field_types_money.sql | npx supabase db query --linked -o csv
--
-- ⚠️ NUMBERING: take the next free number from the LIVE LEDGER, never the highest file in your
--    clone. 330 was written as 328 and had to be renumbered because a sibling session took 328
--    and 329 while it was being built; 332 is the next free number after 331 as of this edit.
--
-- ── WHY (Carolyn 2026-10-23) ─────────────────────────────────────────────────────────────
-- "I want to add a few other types of fields. Phone and hyperlink and also with number one I want
-- the option of currency or no. (Only USD and Canada dollar) and the option to add a comma
-- (100,000) or no comma (100000)."
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────────────────────────
--   1. field_type gains 'phone' and 'url'.
--   2. crm_field_defs.currency  — 'USD' | 'CAD' | NULL (no money prefix). Only two, as asked.
--   3. crm_field_defs.thousands — show 100,000 (true, the default) or 100000 (false).
--
-- Both new columns are about how a number is SHOWN and never about what is stored: the jsonb holds
-- a plain number, so turning the comma off or switching US$ to none cannot change the value
-- somebody already typed, and an export or a report never has to strip a symbol back off.
--
-- `thousands` is NOT NULL DEFAULT TRUE so every field that exists today reads 100,000 — the way it
-- already prints through the browser's own formatter — rather than silently changing on a card
-- somebody is looking at.
--
-- ── RULES ────────────────────────────────────────────────────────────────────────────────
--   * A currency may only sit on a `number`. portal-settings clears it when a field is retyped,
--     the same way it clears `choices`; this CHECK is what makes that non-optional.
--   * ⚠️ WRITTEN WITH 331's LESSON APPLIED. Every branch is a DEFINITE boolean: `currency is null`
--     is definite, and there is no `array_length` or other NULL-propagating comparison in here.
--     331's header has the long version — a CHECK that evaluates to NULL PASSES, which is how
--     330's choices guard shipped inert. Re-read any CHECK you add here against that.

begin;

-- ── PART 1 ── the two new types ──────────────────────────────────────────────────────────
alter table public.crm_field_defs drop constraint if exists crm_field_defs_type_chk;

alter table public.crm_field_defs
  add constraint crm_field_defs_type_chk check (
    field_type in ('text', 'textarea', 'number', 'date', 'select', 'checkbox', 'phone', 'url')
  );

-- ── PART 2 ── how a number is shown ──────────────────────────────────────────────────────
alter table public.crm_field_defs add column if not exists currency  text;
alter table public.crm_field_defs add column if not exists thousands boolean not null default true;

alter table public.crm_field_defs drop constraint if exists crm_field_defs_currency_chk;
alter table public.crm_field_defs
  add constraint crm_field_defs_currency_chk check (
    currency is null or (field_type = 'number' and currency in ('USD', 'CAD'))
  );

-- ── PART 3 ── assertions, inside the transaction ─────────────────────────────────────────
do $$
begin
  -- The two new types are accepted.
  insert into public.crm_field_defs (client_id, entity, source, key, label, field_type)
    values ('_m332_probe', 'contact', 'custom', 'p_phone', 'probe', 'phone'),
           ('_m332_probe', 'contact', 'custom', 'p_url', 'probe', 'url');

  -- A number may carry a currency and a comma setting.
  insert into public.crm_field_defs (client_id, entity, source, key, label, field_type, currency, thousands)
    values ('_m332_probe', 'deal', 'custom', 'p_money', 'probe', 'number', 'CAD', false);

  -- A currency on anything but a number is refused.
  begin
    insert into public.crm_field_defs (client_id, entity, source, key, label, field_type, currency)
      values ('_m332_probe', 'contact', 'custom', 'p_bad', 'probe', 'text', 'USD');
    raise exception '332: a currency on a text field was allowed';
  exception when check_violation then null;
  end;

  -- A currency nobody asked for is refused.
  begin
    insert into public.crm_field_defs (client_id, entity, source, key, label, field_type, currency)
      values ('_m332_probe', 'contact', 'custom', 'p_bad2', 'probe', 'number', 'GBP');
    raise exception '332: GBP was allowed — only USD and CAD were asked for';
  exception when check_violation then null;
  end;

  -- A type that is not one of the eight is still refused.
  begin
    insert into public.crm_field_defs (client_id, entity, source, key, label, field_type)
      values ('_m332_probe', 'contact', 'custom', 'p_bad3', 'probe', 'colour');
    raise exception '332: an unknown field type was allowed';
  exception when check_violation then null;
  end;

  -- The default must be TRUE, or every field that already exists changes how it prints.
  if exists (select 1 from public.crm_field_defs
              where client_id = '_m332_probe' and key = 'p_phone' and thousands is not true) then
    raise exception '332: thousands did not default to true';
  end if;

  delete from public.crm_field_defs where client_id = '_m332_probe';
  if exists (select 1 from public.crm_field_defs where client_id = '_m332_probe') then
    raise exception '332: probe rows not cleaned up';
  end if;
end $$;

commit;
