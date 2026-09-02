-- 176_captured_lead_crm_link.sql — give every browsing lead a contact record to open.
--
-- WHY. The Contacts list links a row's NAME to that person's CRM record through
-- crm_contacts. Design-backed rows carry the id (save_design stamps designs.contact_id —
-- migration 133); browsing leads carry captured_leads.contact_id, which nothing has
-- stamped since 130's one-shot backfill. Every lead captured after that day is therefore
-- a name that does nothing when clicked — and because the list sorts by last activity,
-- the newest lead sits at the TOP, so the first row anyone clicks was reliably the dead
-- one. Carolyn, 2026-09-01: "we need to be able to click the name and it opens the
-- contact view."
--
-- The runtime hole is closed in the capture-lead edge function (it now calls
-- crm_ensure_contact and stamps the row). This migration is the catch-up for the leads
-- captured in between.
--
-- Idempotent and re-runnable: it only touches rows where contact_id IS NULL, and
-- crm_ensure_contact resolves-or-creates by phone then email, so a lead whose person
-- already has a record links to that record instead of making a second one.
--
-- Oldest first so first_seen_at lands on the earliest sighting, and so the newest
-- non-empty name/email wins last — the same order and the same reason as 130's backfill.
--
-- `source` is deliberately not touched. 130 flipped 'design' → 'captured_lead' as part of
-- its own sweep; doing it again now would relabel established customers who have since
-- browsed. Nothing reads the column today, and the accurate value for a person we already
-- knew from a design is 'design'.
--
-- Rollback: update public.captured_leads set contact_id = null; (the link is derived data —
-- no crm_contacts row created here is deleted, since a design or a note may already hang
-- off it.)

do $$
declare r record; v uuid;
begin
  for r in select id, client_id, name, phone, email, created_at
             from public.captured_leads
            where contact_id is null
            order by created_at asc
  loop
    v := public.crm_ensure_contact(r.client_id, r.name, r.phone, r.email);
    if v is not null then
      update public.captured_leads set contact_id = v where id = r.id;
      update public.crm_contacts
         set first_seen_at = least(first_seen_at, r.created_at)
       where id = v;
    end if;
  end loop;
end $$;
