// The tables migration 386 reads, with only the columns it names: the stand-in for the live schema
// that tests/sql/migration386.test.cjs and tests/sql/accessParity.cjs both build on in PGlite.
// Not a test file. No client identifiers in here (public repo).
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create table public.client_settings (
  client_id text primary key,
  internal_account boolean not null default false,
  billing_exempt boolean not null default false,
  billing_exempt_until timestamptz,
  phone_only boolean not null default false,
  sheds_enabled boolean not null default true,
  jack_on boolean not null default false,
  support_ai_beta boolean not null default false,
  library_beta boolean not null default false,
  door_looks_beta boolean not null default false,
  tax_lookup_enabled boolean not null default false,
  payments_online_enabled boolean not null default false,
  advanced_mode boolean not null default false,
  phone_status text not null default 'off'
);
alter table public.client_settings enable row level security;
revoke all on public.client_settings from anon, authenticated;

create table public.billing_plans (
  id text primary key,
  feature text,
  name text,
  billing_interval text,
  active boolean not null default true,
  operator_grantable boolean not null default false
);
create table public.billing_subscriptions (
  id text primary key,
  client_id text not null,
  plan_id text not null,
  status text not null,
  current_period_end timestamptz,
  canceled_at timestamptz,
  past_due_since timestamptz
);
create table public.client_feature_grants (
  client_id text not null,
  feature text not null,
  expires_at timestamptz,
  primary key (client_id, feature)
);
`;

module.exports = { STUBS };
