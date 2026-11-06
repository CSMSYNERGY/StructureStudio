-- 368: "Getting set up" learns the account's shape (migration 364).
--
-- Carolyn, 2026-11-05: "based on everything I changed to not give him access we also need a
-- Getting setup list specific for Smart Build ... lets have him have only what he needs." A builder
-- with client_settings.sheds_enabled = false has no designer, catalog, lots, schedules or paperwork,
-- and 21 of the 25 template steps point at exactly those pages.
--
-- ONE TEMPLATE, A THIRD TAG. setup_template_items.account_type is read through template_item_id at
-- request time (portal-setup), exactly like migration 185's two gates, and is never copied onto a
-- tenant's row:
--   'all'         every builder (the default — nothing anybody had changes)
--   'sheds'       only a builder with the shed product
--   'smartbuild'  only a builder without it
-- So a list copied before this migration filters itself (nothing is deleted, and switching an
-- account's shape back brings its steps back), and admin-catalog's create_client keeps copying
-- every active row, as its own comment says it must.
--
-- The four steps that stay for everyone: sign in, team, commissions (Carolyn kept it), QuickBooks.
--
-- Rollback: delete from tenant_setup_items where template_item_id in (the nine ids below);
--           delete from setup_template_items where account_type = 'smartbuild';
--           alter table setup_template_items drop column account_type;

alter table public.setup_template_items
  add column if not exists account_type text not null default 'all';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'setup_template_items_account_type_check') then
    alter table public.setup_template_items add constraint setup_template_items_account_type_check
      check (account_type in ('all', 'sheds', 'smartbuild'));
  end if;
end $$;

-- 1. The shed product's steps. Two of them (business details, own email domain) are worded for
--    estimates and invoices, so they are shed steps too, and step 2 gives SmartBuild its own.
update public.setup_template_items set account_type = 'sheds', updated_at = now()
where id in (
  'b79d9350-b706-479e-bc44-53f20c0333b0',  -- Add your business details (terms printed on estimates)
  '606417ba-c3d8-476e-aef3-2fd30bb3bf90',  -- Set up your logo and branding
  '50d7137f-8bd3-4229-a920-325ce34683d0',  -- Check your building styles and sizes
  'ad418c5c-b0b0-439d-8eb2-03553a24b39c',  -- Set up doors, windows, ramps and add-ons
  'c8c786ad-67a0-4a34-87df-94d3b6ea3fcf',  -- Choose and price your cladding
  '9f1792fe-de56-4181-a0b3-4ed78ea6bd15',  -- Set up electrical
  'f38a551b-1ed0-400d-9820-340e1c18ad5d',  -- Set up insulation
  'e1990d55-3986-4d4d-a7b3-a69cd60ef2c1',  -- Set your colors
  '1350a78a-7a84-46e8-81af-3f0276f5bfd6',  -- Set your prices
  '0d7153a5-8dbd-4a38-8f98-79f401e9dcc3',  -- Decide if customers see prices
  '4b43d278-5376-49ca-8f49-25258d361b08',  -- Connect GoHighLevel
  '1c800167-e6c5-4944-af35-d12a69503d7d',  -- Choose how quotes & invoices go out
  'd7623086-3446-43be-99bf-1f8dbc218d17',  -- Decide who can change a signed order
  'e2764468-522c-48e4-b7af-229cf4cd010c',  -- Send email from your own domain (estimates and invoices)
  '91a9f95e-ee1a-4e8d-aec7-975522aed0b8',  -- Send yourself a test quote
  '915d08fb-a55e-4620-9fbf-3288af96f70b',  -- Share your customer design link
  '1ea40652-a09b-4c1d-9d26-a4ed48714e35',  -- Add your sales locations
  '82db232b-e090-494a-ac97-f76c8586984f',  -- Set where your building serial numbers start
  'd1febed3-0b5b-4884-90bd-61fab81ccc24',  -- Scheduling: crews, territories & drivers
  '5f28a7a3-fe0e-450b-aa88-9efa8f381beb',  -- Real-Time Pricing
  '0f20bfee-6887-4b98-8544-2485dc8623bf'   -- 3D
);

-- 2. The SmartBuild builder's own steps. Fixed ids so step 3, a rerun and the rollback can name them.
--    Connect SmartBuild is `builder_visible = false` until the sync exists — the "not built yet" gate
--    shows it to every SmartBuild builder at once on the day it ships — and needs smartbuild_sync.
insert into public.setup_template_items
  (id, title, detail, link_page, section, position, active, account_type, requires_feature, builder_visible)
values
  ('5b1d0368-0000-4000-8000-000000000001', 'Add your business details',
   'Your legal name, phone and address. They appear on your account and on the forms and emails your customers see.',
   'settings/company', 'The basics', 1537, true, 'smartbuild', null, true),
  ('5b1d0368-0000-4000-8000-000000000002', 'Check your SmartBuild Jobs pipeline',
   'Your pipeline starts with eight stages, from New Lead to Gone Cold Again. Rename, reorder or add stages to match how you work, and add another pipeline if you need one.',
   'settings/pipelines', 'Your Customer Hub', 12400, true, 'smartbuild', null, true),
  ('5b1d0368-0000-4000-8000-000000000003', 'Set up your business phone',
   'Choose who answers your business number, and install the My Synergy Phone app so every call and text is logged on the customer.',
   'settings/phone', 'Your Customer Hub', 12500, true, 'smartbuild', null, true),
  ('5b1d0368-0000-4000-8000-000000000004', 'Register for business texting',
   'Submit your business for carrier approval so you can text customers from your own number. Approval usually takes a few days.',
   'settings/sms', 'Your Customer Hub', 12600, true, 'smartbuild', null, true),
  ('5b1d0368-0000-4000-8000-000000000005', 'Send email from your own domain',
   'Add a few DNS records so the emails your customers get come from your business address instead of ours.',
   'settings/email', 'Your Customer Hub', 12700, true, 'smartbuild', null, true),
  ('5b1d0368-0000-4000-8000-000000000006', 'Put a lead form on your website',
   'Build your form, publish it, and paste it on your website. Every lead lands in your Customer Hub as a new contact.',
   'settings/forms', 'Your Customer Hub', 12800, true, 'smartbuild', null, true),
  ('5b1d0368-0000-4000-8000-000000000007', 'Set up your automatic follow-ups',
   'Decide what happens on its own — for example, when a new lead comes in, text them back right away.',
   'settings/automations', 'Your Customer Hub', 12900, true, 'smartbuild', null, true),
  ('5b1d0368-0000-4000-8000-000000000008', 'Set up meeting booking (optional)',
   'The meeting types customers can book with you, and your booking page.',
   'settings/meetings', 'Your Customer Hub', 13000, true, 'smartbuild', null, true),
  ('5b1d0368-0000-4000-8000-000000000009', 'Connect SmartBuild',
   'We link your SmartBuild account for you. Once it is connected, your SmartBuild quotes and job details show on each customer.',
   null, 'SmartBuild', 15700, true, 'smartbuild', 'smartbuild_sync', false)
on conflict (id) do nothing;

-- 3. Accounts that ALREADY have the shed product off got their list before these steps existed,
--    so they get copies now (create_client copies them for every account made from here on). Each
--    copy is placed against the account's own rows, which are numbered by when the list was copied,
--    not by the template: business details just after "Set your password", the Customer Hub block
--    just before "Add your team", Connect SmartBuild just after commissions. An account missing an
--    anchor gets the step at the end. Idempotent: a step already on the list is skipped.
insert into public.tenant_setup_items (client_id, template_item_id, title, detail, link_page, section, image_url, position)
select c.client_id, t.id, t.title, t.detail, t.link_page, t.section, t.image_url,
  coalesce(
    (select s.position from public.tenant_setup_items s
      where s.client_id = c.client_id and s.template_item_id = m.anchor) + m.off,
    (select coalesce(max(s.position), 0) from public.tenant_setup_items s where s.client_id = c.client_id) + t.position)
from (select distinct s.client_id from public.tenant_setup_items s
        join public.client_settings cs on cs.client_id = s.client_id
       where cs.sheds_enabled = false) c
cross join (values
  ('5b1d0368-0000-4000-8000-000000000001'::uuid, '3deb03bb-9be5-4fad-aabb-18d09d6f02d7'::uuid,  100::float8),  -- after sign in
  ('5b1d0368-0000-4000-8000-000000000002'::uuid, 'a1569cb2-2401-4c25-9886-684d3777ea14'::uuid, -700),           -- before team
  ('5b1d0368-0000-4000-8000-000000000003'::uuid, 'a1569cb2-2401-4c25-9886-684d3777ea14'::uuid, -600),
  ('5b1d0368-0000-4000-8000-000000000004'::uuid, 'a1569cb2-2401-4c25-9886-684d3777ea14'::uuid, -500),
  ('5b1d0368-0000-4000-8000-000000000005'::uuid, 'a1569cb2-2401-4c25-9886-684d3777ea14'::uuid, -400),
  ('5b1d0368-0000-4000-8000-000000000006'::uuid, 'a1569cb2-2401-4c25-9886-684d3777ea14'::uuid, -300),
  ('5b1d0368-0000-4000-8000-000000000007'::uuid, 'a1569cb2-2401-4c25-9886-684d3777ea14'::uuid, -200),
  ('5b1d0368-0000-4000-8000-000000000008'::uuid, 'a1569cb2-2401-4c25-9886-684d3777ea14'::uuid, -100),
  ('5b1d0368-0000-4000-8000-000000000009'::uuid, 'ae232c65-8f2a-4813-a839-8eff55f96801'::uuid,  500)            -- after commissions
) as m(tid, anchor, off)
join public.setup_template_items t on t.id = m.tid
where not exists (select 1 from public.tenant_setup_items x
                   where x.client_id = c.client_id and x.template_item_id = t.id);

-- Rehearsal: the shape this migration promises, or it does not apply.
do $$
declare n_sheds int; n_sb int; n_all int;
begin
  select count(*) filter (where account_type = 'sheds'),
         count(*) filter (where account_type = 'smartbuild'),
         count(*) filter (where account_type = 'all')
    into n_sheds, n_sb, n_all
    from public.setup_template_items where active;
  if n_sb <> 9 then raise exception '368: expected 9 SmartBuild steps, found %', n_sb; end if;
  if n_sheds < 21 then raise exception '368: expected at least 21 shed steps, found %', n_sheds; end if;
  if n_all < 4 then raise exception '368: expected the 4 shared steps to stay shared, found %', n_all; end if;
end $$;
