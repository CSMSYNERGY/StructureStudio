-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 366 — DO NOT DISTURB on the customer, and the unsubscribe link that sets it
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Ledger read before writing: max = 365 (this author's). Read it AGAIN immediately before
-- applying — two agents shared 362 on 2026-11-05.
--
-- ── WHY (Carolyn, 2026-11-05) ────────────────────────────────────────────────────────────
-- Round 2b of the automations plan. "I like the view and simplicity GHL has... can we do that?"
-- — a Do Not Disturb panel on the customer: DND all channels · Email · Text messages · Calls &
-- voicemail · Inbound calls and SMS. And, asked before any of it was written: "GHL lets us uncheck
-- the box... how can they let that and we can't" — so EVERY box can be unticked by the builder,
-- including a customer's own STOP (the panel then says their carrier still blocks texts until
-- they reply START, which is Twilio's rule and not ours to clear).
--
-- The weekly scheduled EMAIL the automations can now send needs an unsubscribe that WORKS — a
-- footer link that did nothing would be worse than none, because the law is about honouring the
-- request, not displaying the word. So: every automated email carries a link (and the
-- List-Unsubscribe header Gmail and Apple Mail show as their own button), the link sets the Email
-- box, and every automated send checks the boxes first.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   crm_contacts gains four DND columns. The TEXT box is NOT a new column: it is the STOP register
--   that already exists (sms_opt_outs, and the older crm_contacts.sms_opt_out_at), which smsSend
--   already refuses on — one fact, one place.
--   dnd_email_source records WHO turned email off: 'customer' (the link) or 'builder' (the panel),
--   so the panel can say "They unsubscribed on …" rather than look like a setting someone chose.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Additive: four nullable columns and one CHECK. Nothing reads them until portal-settings and
-- crm-rules-tick redeploy.
--
-- ── REVERSE ──────────────────────────────────────────────────────────────────────────────
--   -- alter table public.crm_contacts drop column dnd_all_at, drop column dnd_email_at,
--   --   drop column dnd_email_source, drop column dnd_calls_at, drop column dnd_inbound_at;
-- ═════════════════════════════════════════════════════════════════════════════════════════

alter table public.crm_contacts add column if not exists dnd_all_at       timestamptz;
alter table public.crm_contacts add column if not exists dnd_email_at     timestamptz;
alter table public.crm_contacts add column if not exists dnd_email_source text;
alter table public.crm_contacts add column if not exists dnd_calls_at     timestamptz;
alter table public.crm_contacts add column if not exists dnd_inbound_at   timestamptz;

alter table public.crm_contacts drop constraint if exists crm_contacts_dnd_email_source;
alter table public.crm_contacts add constraint crm_contacts_dnd_email_source check (
  (dnd_email_at is null and dnd_email_source is null)
  -- "is not null" spelled out: a CHECK that comes out UNKNOWN passes, and NULL in (...) is unknown —
  -- without it, "email off, nobody named" slipped through (the rehearsal below caught it).
  or (dnd_email_at is not null and dnd_email_source is not null and dnd_email_source in ('builder', 'customer')));

comment on column public.crm_contacts.dnd_all_at is
  'Do Not Disturb, every channel (366). Automated texts and emails refuse; the phone system will in a coming update.';
comment on column public.crm_contacts.dnd_email_at is
  'No automated email (366). Set by the unsubscribe link (source customer) or the panel (source builder).';
comment on column public.crm_contacts.dnd_calls_at is
  'Do not call (366). Shown on the record; honoured by the phone system in a coming update.';
comment on column public.crm_contacts.dnd_inbound_at is
  'Their inbound calls and texts do not ring or notify (366). Honoured by the phone system in a coming update.';

do $chk$
declare v_t text := 'm366-rehearsal-' || substr(md5(random()::text), 1, 8); v_c uuid;
begin
  insert into public.crm_contacts (client_id, name, email, source) values (v_t, 'Dee Rehearsal', 'dee366@example.invalid', 'manual')
  returning id into v_c;
  update public.crm_contacts set dnd_email_at = now(), dnd_email_source = 'customer' where id = v_c;
  begin
    update public.crm_contacts set dnd_email_source = null where id = v_c;
    raise exception '366: email turned off with nobody named as having done it was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.crm_contacts set dnd_email_at = null where id = v_c;
    raise exception '366: email turned back on while still naming who turned it off was accepted';
  exception when check_violation then null;
  end;
  update public.crm_contacts set dnd_email_at = null, dnd_email_source = null where id = v_c;
  delete from public.crm_contacts where client_id = v_t;
  raise notice '366 OK';
end;
$chk$;
