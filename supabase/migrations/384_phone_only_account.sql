-- 384: a PHONE-ONLY account — My Synergy Phone plus the contact list, and nothing else.
--
-- Carolyn, 2026-11-09 (1:21:20): "Somebody needs just a phone system. We want to track their calls
-- and all of that stuff in here, and the contacts. So they would have this list, just contacts."
-- And 2026-11-10 (1:15): "So it'll say customer hub, but all they have access to is contacts. And
-- then obviously if they want to do more, later they can."
--
-- ONE COLUMN, the shape of migration 364's sheds_enabled: client_settings.phone_only, default false,
-- read only as an explicit TRUE. When it is on, the account:
--   * sees Customer Hub (the contact list only, with each contact's calls and texts), Calls, its phone
--     settings (Settings > Customer Hub > Phone and SMS - A2P), Business Details, Team, Billing and
--     My Profile. Nothing else is offered, and the portal's router refuses the rest (01-core
--     ssClampTab / SS_PHONE_ONLY_TABS).
--   * is refused, server-side, every edge-function action outside a short allow-list
--     (_shared/accountShape.ts, enforced inside _shared/resolveTenant.ts), so a hidden page is not
--     a reachable one.
--   * gets the contact actions (crm_record, crm_save_contact, notes, tags...) WITHOUT the Customer
--     Hub subscription: the phone is what they pay for, and "the phone in itself would just get
--     them contacts ... and call logs" (2026-11-09, 1:37:47). The CRM's other half (pipelines, forms,
--     automations, templates, the inbox) stays refused.
--   * is not held at the billing gate for having no subscription: it pays by its wallet (calls and
--     texts at cost x the markup, the $3 number fee, the texting setup fee), which the phone-api
--     Worker charges exactly as it does every builder. Nothing in the Worker reads this column.
--
-- UNLIKE sheds_enabled, THIS ONE DOES GRANT SOMETHING (the contact actions, and past the gate). So it
-- is set only by an operator (admin-catalog create_client / set_account_type), never by
-- portal-settings `save`, and a phone-only account is also given sheds_enabled = false so the shed
-- half is already hidden by 364's rules.
--
-- TURNING MORE ON LATER loses nothing: this column hides and refuses, it deletes nothing. Admin >
-- Accounts > Account type switches it back off, and the contacts, calls and texts are all still there.
-- The general per-company switchboard (research 2026-11-11) may absorb this column as one preset.
--
-- Rollback: delete from tenant_setup_items where template_item_id in (the six ids below);
--           delete from setup_template_items where account_type = 'phone';
--           restore the 3-value check; alter table client_settings drop column phone_only;

alter table public.client_settings
  add column if not exists phone_only boolean not null default false;

comment on column public.client_settings.phone_only is
  'Phone-only account (migration 384): My Synergy Phone + the contact list, nothing else. Operator-set; '
  'read only as an explicit true. Grants the contact actions without the Customer Hub subscription and '
  'passes the billing gate (the wallet pays); refuses every other edge-function action. See _shared/accountShape.ts.';

-- "Getting set up" gets a fourth audience. A phone-only account sees ONLY its own steps (setupShape.ts):
-- the shared 'all' steps include commissions, QuickBooks and a CSV import into a pipeline, none of
-- which a phone-only account has.
alter table public.setup_template_items drop constraint if exists setup_template_items_account_type_check;
alter table public.setup_template_items add constraint setup_template_items_account_type_check
  check (account_type in ('all', 'sheds', 'smartbuild', 'phone'));

insert into public.setup_template_items
  (id, title, detail, link_page, section, position, active, account_type, requires_feature, builder_visible)
values
  ('9e0e0384-0000-4000-8000-000000000001', 'Set your password and sign in',
   'Use the link we sent you, then set a password you will remember. You use the same email and password to sign in to the My Synergy Phone app.',
   null, 'The basics', 1030, true, 'phone', null, true),
  ('9e0e0384-0000-4000-8000-000000000002', 'Add your business details',
   'Your business name, phone and address. They appear on your account and on the texts and emails your customers get.',
   'settings/company', 'The basics', 1540, true, 'phone', null, true),
  ('9e0e0384-0000-4000-8000-000000000003', 'Add a card to your usage wallet',
   'Calls, texts and your phone number are paid from a prepaid wallet. Add a card under Settings > Billing > Wallet and choose an amount to keep it topped up.',
   'settings/wallet', 'Billing', 2050, true, 'phone', null, true),
  ('9e0e0384-0000-4000-8000-000000000004', 'Set up your business phone',
   'Choose who answers your business number, and install the My Synergy Phone app on your phone or computer. Every call is logged on the customer.',
   'settings/phone', 'Your phone', 12510, true, 'phone', null, true),
  ('9e0e0384-0000-4000-8000-000000000005', 'Register for business texting',
   'Submit your business for carrier approval so you can text customers from your own number. Approval usually takes a few days.',
   'settings/sms', 'Your phone', 12610, true, 'phone', null, true),
  ('9e0e0384-0000-4000-8000-000000000006', 'Add your team (optional)',
   'Add each person who answers calls, with their email. They get a sign-in link for the portal and the My Synergy Phone app.',
   'settings/team', 'Your team', 28680, true, 'phone', null, true)
on conflict (id) do nothing;

-- Rehearsal: the shape this migration promises, or it does not apply.
do $$
declare n_phone int; has_col boolean;
begin
  select count(*) into n_phone from public.setup_template_items where active and account_type = 'phone';
  if n_phone <> 6 then raise exception '384: expected 6 phone-only steps, found %', n_phone; end if;
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'client_settings' and column_name = 'phone_only')
    into has_col;
  if not has_col then raise exception '384: client_settings.phone_only is missing'; end if;
end $$;
