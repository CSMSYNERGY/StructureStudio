-- 160_setup_v2: the SETUP checklist grows sections + screenshots, and the template is
-- reseeded as the COMPLETE builder onboarding list.
--
-- Carolyn 2026-08-28 reviewing the first checklist (157): "dive deeper into all the
-- settings and make sure you didn't skip anything… very self guided and simple to
-- follow… add screenshots and give explanations." A full inventory of every settings
-- surface found the 8-step seed skipped most of them, and ordered pricing BEFORE options
-- when the pricing Excel's option columns are generated FROM the options catalog (the
-- pricing card's own banner says options first).
--
-- ⚠️ APPLY BY HAND (SQL editor / MCP) and record in supabase_migrations.schema_migrations.
-- NEVER `supabase db push`. Numbered 160: the ledger's 3-digit max was 157, and the sales
-- tax line holds files 158/159 in the folder (applied live under timestamp versions
-- 20260828053440/20260828054326 — its own header documents the collision that caused that).

-- ── Columns ─────────────────────────────────────────────────────────────────
-- section: a display grouping ("The basics", "Your team", …). Ordering stays position —
--          the section header renders whenever it changes walking the list in order, so
--          there is no second ordering model to keep consistent.
-- image_url: the screenshot. Stores ONLY the function-generated public URL of an object
--          in the setup-screens bucket (setup_upload_image mints the path server-side);
--          portal-projects' save actions refuse any other value, because this column
--          lands in an <img src> in every tenant's browser.
alter table public.setup_template_items add column if not exists section   text;
alter table public.setup_template_items add column if not exists image_url text;
alter table public.tenant_setup_items   add column if not exists section   text;
alter table public.tenant_setup_items   add column if not exists image_url text;

-- ── Bucket ──────────────────────────────────────────────────────────────────
-- PUBLIC on purpose, with NO storage.objects policies — the branding/fixtures shape
-- (021/064, caps per 086): writes happen service-role from portal-projects only (no
-- policies means no browser role can write), and reads are the point — every tenant sees
-- the same operator-authored product screenshots, which carry no tenant data. The
-- randomUUID in each path is the unguessable-capability argument from upload_style_photo,
-- and it matters even less here than there.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('setup-screens', 'setup-screens', true, 5242880,
        array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── Template reseed ─────────────────────────────────────────────────────────
-- Replaces the 157 seed wholesale. Existing tenant copies are untouched by design
-- (tenant_setup_items.template_item_id is ON DELETE SET NULL — they just lose
-- provenance); refreshing a live tenant's list is a deliberate per-tenant operation,
-- never a migration side effect.
--
-- Wording is written to be TRUE FOR BOTH creation templates: a cloned tenant arrives
-- with a full starter catalog, a blank one with none (admin-catalog `__none__`), so the
-- steps say "check / fill in" rather than "we set you up".
--
-- Order encodes real dependencies:
--   options BEFORE pricing  — the pricing Excel's per-option columns are generated from
--                             the options catalog; pricing first forces a re-download.
--   email BEFORE test quote — beta-mode testing and SS-issued documents both send mail.
--   share-your-link LAST in the basics arc — everything before it is what makes the
--                             link worth sharing.
-- The last section is the paid/granted features; operators delete inapplicable rows from
-- a tenant's copy in Projects → Client Setup.
delete from public.setup_template_items;

insert into public.setup_template_items (section, title, detail, link_page, position, active) values
  ('The basics', 'Set your password and sign in',
   'Use the link we sent you, then set a password you will remember. When the portal asks for your name and phone, fill those in too — they identify you on quotes and inside your team.',
   null, 1024, true),
  ('The basics', 'Add your business details and logo',
   'Two halves on one page: your customer link''s look (logo, colors, company name) and the business details block — name, phone, address, logo and quote terms — that prints on every estimate your customers receive.',
   'settings/branding', 2048, true),
  ('The basics', 'Check your building styles and sizes',
   'Your catalog may already have starter styles and sizes — keep what you sell, remove what you don''t, and add anything missing. Every quote starts from this list.',
   'settings/structures', 3072, true),
  ('The basics', 'Set up doors, windows, ramps and add-ons',
   'Prices, sizes and photos for everything customers place on a building. Ramps have a choice: one simple auto-sized ramp, or a full catalog. Window colors live under Windows. Do this BEFORE pricing — the pricing spreadsheet builds its columns from this catalog.',
   'settings/options', 4096, true),
  ('The basics', 'Set your colors',
   'Paint, shingle and metal palettes, with the names your customers know them by. Mark your defaults and set any upcharges.',
   'settings/colors', 5120, true),
  ('The basics', 'Set your prices',
   'Download the pricing spreadsheet, fill in a base price per size, and upload it back. A size without a price is not offered to customers — so this step is what turns your designer on.',
   'settings/structures', 6144, true),
  ('The basics', 'Decide if customers see prices',
   'One switch on the Branding page: show live pricing to customers as they design, or keep numbers private until you send the quote.',
   'settings/branding', 7168, true),

  ('Quotes, invoices & email', 'Connect your CRM (if you use GoHighLevel)',
   'Paste your Location ID and API key, then pick the pipelines and stages where new quotes, accepted quotes, invoices and deliveries should land. Skip this if you''ll issue paperwork through Structure Studio instead.',
   'settings/connection', 8192, true),
  ('Quotes, invoices & email', 'Choose how quotes & invoices go out',
   'Through your CRM, or issued by Structure Studio. Switching to Structure Studio paperwork needs three things first: a starting quote number, a starting invoice number, and your sales tax rate (tax is looked up from each delivery address — your rate is the backup when that lookup can''t resolve; enter 0 if you don''t collect tax).',
   'settings/connection', 9216, true),
  ('Quotes, invoices & email', 'Send email from your own domain',
   'Add a few DNS records so estimates and invoices come from your business address instead of ours. There''s a button to email the records straight to your webmaster.',
   'settings/email', 10240, true),
  ('Quotes, invoices & email', 'Send yourself a test quote',
   'First turn on Testing (Branding page: beta mode + your test inbox) so nothing reaches a real customer. Then build one design end to end and submit it. Check the email and the PDF look the way you want, and turn Testing back off when you''re happy.',
   'designer', 11264, true),
  ('Quotes, invoices & email', 'Share your customer design link',
   'Your link is at the top of the Branding page. Copy it, put it on your website and social pages, and send it to walk-in customers — every design made there lands in your portal.',
   'settings/branding', 12288, true),

  ('Your team', 'Add your team & set access',
   'Add each person with their email and job title — they get a sign-in link. The access grid decides what each person can see and change.',
   'settings/team', 13312, true),
  ('Your team', 'Add sales locations & your serial number start',
   'Your lots and where your building serial numbers should start counting. Needed before you track buildings in Inventory.',
   'settings/team', 14336, true),
  ('Your team', 'Set up commissions (optional)',
   'If reps earn commission: choose the structure here, then set each person''s rate on the Team page.',
   'settings/commissions', 15360, true),

  ('If you''ve added…', 'Scheduling: create crews, territories & drivers',
   'With the Scheduling add-on: build crews are how the calendar schedules work, and deliveries need territories plus drivers (each driver needs a login, deck length and max building width).',
   'settings/team', 16384, true),
  ('If you''ve added…', 'QuickBooks: connect & map your items',
   'With the QuickBooks add-on: connect your company, then map each line type and style to a QuickBooks product so invoices post themselves.',
   'settings/quickbooks', 17408, true),
  ('If you''ve added…', 'Real-Time Pricing: materials & build sheets',
   'With the Real-Time Pricing add-on: enter your material costs and per-style build sheets, then flip pricing live when the numbers check out.',
   'settings/structures', 18432, true),
  ('If you''ve added…', '3D: calibrate how your styles look',
   'If 3D is enabled on your account: set each style''s roof shape, siding and wall height — reference photos and the AI draft make this quick.',
   'settings/designer', 19456, true);
