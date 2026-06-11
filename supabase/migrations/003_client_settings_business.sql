-- 003_client_settings_business: per-client business identity for quotes/estimates
-- (was hardcoded to Junior Barns inside the submit-estimate edge function).
-- Also relax NOT NULL on the GHL credential columns so the portal can save
-- business details before GHL credentials exist; submit-estimate treats
-- null credentials as "not configured".
-- APPLIED to project jzeamjbhdrsbygdnphbm on 2026-06-11 (migration: client_settings_business_details).

alter table public.client_settings
  add column if not exists business_name text,
  add column if not exists business_phone text,
  add column if not exists business_website text,
  add column if not exists business_address jsonb,
  add column if not exists business_logo_url text,
  add column if not exists quote_terms text,
  add column if not exists beta_mode boolean not null default false,
  add column if not exists beta_email text;

alter table public.client_settings
  alter column ghl_location_id drop not null,
  alter column ghl_api_key drop not null;

-- Backfill: the values that used to be hardcoded in submit-estimate, so the
-- parameterized function keeps producing byte-identical Junior Barns estimates.
update public.client_settings set
  business_name = coalesce(business_name, 'Junior Barns'),
  business_phone = coalesce(business_phone, '+17077252276'),
  business_website = coalesce(business_website, 'juniorbarns.com'),
  business_address = coalesce(business_address, '{"addressLine1":"50 Main Street","city":"Fortuna","state":"California","postalCode":"95540","countryCode":"US"}'::jsonb),
  business_logo_url = coalesce(business_logo_url, 'https://assets.cdn.filesafe.space/sp58arigVfqozsJSPe1z/media/69716d13d4fb904295f019e7.png'),
  quote_terms = coalesce(quote_terms, E'Customer is responsible for all permits and setback requirements.\nIncludes initial delivery only. Future relocation of shed is not a service offered by Junior Barns.'),
  updated_at = now()
where client_id = 'junior-barns';
