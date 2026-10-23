-- 331_crm_field_choices_null_check.sql — 330's choices CHECK was INERT for the one case it was
-- written to catch. Carolyn 2026-10-23.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`, see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('331', '331_crm_field_choices_null_check') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/331_crm_field_choices_null_check.sql | npx supabase db query --linked -o csv
--
--    ✅ APPLIED AND RECORDED 2026-10-23, in the same session as 330.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- 330 wrote:
--     (field_type = 'select'  and array_length(choices, 1) between 1 and 50)
--  or (field_type <> 'select' and coalesce(array_length(choices, 1), 0) = 0)
--
-- `array_length('{}', 1)` is **NULL**, not 0 — an empty array has no first dimension. So for a
-- drop-down with the DEFAULT empty choices the first branch is `NULL between 1 and 50` = NULL and
-- the second is false, the whole expression is NULL, and **a CHECK that evaluates to NULL passes.**
-- The one row the constraint existed to refuse — a drop-down a person cannot answer — was the one
-- row it let through. Measured on the live database:
--
--     select array_length('{}'::text[], 1);                            -- null
--     select array_length('{}'::text[], 1) between 1 and 50;           -- null  → the CHECK passes
--     select coalesce(array_length('{}'::text[],1),0) between 1 and 50; -- false → it refuses
--
-- Found by driving the constraint against a real database rather than by re-reading it, which is
-- the only way this class of bug shows up: the SQL is correct-looking, the intent is obvious, and
-- it silently does nothing.
--
-- portal-settings refuses this anyway ("A drop-down needs at least one choice."), in both the
-- create and the save path (crmFields.ts), so nothing shipped broken — the database guard behind
-- it was simply not there. Worth fixing rather than leaving: the next writer of this column is
-- whoever adds the import, or a hand INSERT during support, and neither goes through that code.
--
-- ⚠️ THE LESSON, because this shape is all over this schema: in a CHECK, `coalesce` every
-- `array_length` before comparing it. Both `x = 0` and `x between a and b` propagate NULL, and
-- NULL passes a CHECK. 330's other four constraints were re-read for the same trap and are clean
-- — each nullable column is guarded by an explicit `is null` branch, which is a definite boolean.

begin;

alter table public.crm_field_defs drop constraint if exists crm_field_defs_choices_chk;

alter table public.crm_field_defs
  add constraint crm_field_defs_choices_chk check (
    (field_type = 'select' and coalesce(array_length(choices, 1), 0) between 1 and 50)
    or
    (field_type <> 'select' and coalesce(array_length(choices, 1), 0) = 0)
  );

-- Proof, not a claim: the row 330 let through must now be refused, and the two legal shapes must
-- still be accepted. Runs inside the transaction and takes the migration down with it on failure.
do $$
begin
  begin
    insert into public.crm_field_defs (client_id, entity, source, key, label, field_type)
      values ('_m331_probe', 'contact', 'custom', 'probe', 'probe', 'select');
    raise exception '331: a choiceless drop-down is STILL allowed';
  exception when check_violation then null;
  end;
  insert into public.crm_field_defs (client_id, entity, source, key, label, field_type, choices)
    values ('_m331_probe', 'contact', 'custom', 'probe_ok', 'probe', 'select', array['Yes']);
  insert into public.crm_field_defs (client_id, entity, source, key, label, field_type)
    values ('_m331_probe', 'contact', 'custom', 'probe_txt', 'probe', 'text');
  delete from public.crm_field_defs where client_id = '_m331_probe';
  if exists (select 1 from public.crm_field_defs where client_id = '_m331_probe') then
    raise exception '331: probe rows not cleaned up';
  end if;
end $$;

commit;
