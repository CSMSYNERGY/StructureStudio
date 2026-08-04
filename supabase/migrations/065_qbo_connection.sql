-- 065_qbo_connection.sql — QuickBooks Online connection state per tenant.
--
-- Renumbered from the planned 063: draft designs (063) and the fixtures catalog (064)
-- landed first.
--
-- WHY PLAIN COLUMNS AND NOT THE VAULT. `client_settings.ghl_api_key` — identical
-- sensitivity — already lives here in plaintext, the `vault` schema is not exposed via
-- PostgREST (so every read/write would need a definer-RPC wrapper), and tokens rotate
-- roughly hourly, which would churn `vault.update_secret` constantly. The table is
-- service-role only with RLS on and zero policies, so the browser can never read it.
-- If the secrets posture ever hardens, move BOTH credential sets together.

alter table public.client_settings
  -- Identity of the connected QuickBooks company.
  add column if not exists qbo_realm_id                  text,
  -- Captured from CompanyInfo at connect time. A bare realm id is not enough: one
  -- QuickBooks company once sat connected to two different accounts unnoticed because
  -- the UI could only show an opaque number. The NAME is what a human recognises.
  add column if not exists qbo_company_name              text,

  -- Tokens. Expiry stored ABSOLUTE (now() + expires_in), never as a duration.
  add column if not exists qbo_access_token              text,
  add column if not exists qbo_access_token_expires_at   timestamptz,
  add column if not exists qbo_refresh_token             text,
  add column if not exists qbo_refresh_token_expires_at  timestamptz,

  -- Provenance + health.
  add column if not exists qbo_connected_at              timestamptz,
  add column if not exists qbo_connected_by              uuid,
  add column if not exists qbo_token_refreshed_at        timestamptz,
  -- In-flight refresh claim. Intuit ROTATES the refresh token on every refresh, so two
  -- concurrent refreshes invalidate each other — that is exactly how a live BuildBridge
  -- credential died on 2026-07-28. PostgREST cannot hold a transaction open across the
  -- HTTP call to Intuit, so the claim is a timestamp on the row rather than a lock.
  add column if not exists qbo_refreshing_at             timestamptz,
  -- NULL means healthy. Set only when Intuit REFUSES the credential (invalid_grant),
  -- never on a network blip — a transient failure must not force a re-OAuth.
  add column if not exists qbo_refresh_error             text,

  -- One-shot CSRF nonce for the OAuth round trip.
  add column if not exists qbo_oauth_state               text,
  add column if not exists qbo_oauth_state_expires_at    timestamptz;

-- One QuickBooks company belongs to at most one tenant. This is the hard version of the
-- 2026-07-28 lesson: the database refuses the second connection instead of letting two
-- tenants quietly share a realm and knock each other's tokens out.
create unique index if not exists client_settings_qbo_realm_uniq
  on public.client_settings (qbo_realm_id)
  where qbo_realm_id is not null;

-- ── Refresh claim ────────────────────────────────────────────────────────────────────
-- Serialises "is the token still good, and if not may I be the one to refresh it?" so
-- that N concurrent callers produce exactly ONE call to Intuit.
--
-- Returns one of:
--   busy          — someone else is mid-refresh; back off and re-ask
--   not_connected — no QuickBooks connection on this tenant
--   broken        — Intuit refused the credential; a human must reconnect
--   fresh         — the stored access token is still good; token is returned
--   claimed       — you own the refresh; the refresh token is returned
create or replace function public.qbo_claim_token_refresh(
  p_client_id     text,
  p_stale_seconds integer default 60
)
returns table (outcome text, token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  -- Transaction-scoped advisory lock: makes the check-and-set below atomic without
  -- locking the row itself (which would block unrelated settings writes).
  perform pg_advisory_xact_lock(hashtext(p_client_id || ':qbo_token'));

  select qbo_realm_id, qbo_refresh_token, qbo_refresh_error,
         qbo_access_token, qbo_access_token_expires_at, qbo_refreshing_at
    into r
  from client_settings
  where client_id = p_client_id;

  if not found or r.qbo_realm_id is null or r.qbo_refresh_token is null then
    return query select 'not_connected'::text, null::text;
    return;
  end if;

  if r.qbo_refresh_error is not null then
    return query select 'broken'::text, null::text;
    return;
  end if;

  -- 120s buffer: never hand out a token that could expire mid-request.
  if r.qbo_access_token is not null
     and r.qbo_access_token_expires_at is not null
     and r.qbo_access_token_expires_at > now() + interval '120 seconds' then
    return query select 'fresh'::text, r.qbo_access_token;
    return;
  end if;

  -- Another caller is already refreshing and has not gone stale — let them finish.
  -- The staleness window is crash recovery: a caller that died mid-refresh must not
  -- wedge the tenant forever.
  if r.qbo_refreshing_at is not null
     and r.qbo_refreshing_at > now() - make_interval(secs => p_stale_seconds) then
    return query select 'busy'::text, null::text;
    return;
  end if;

  update client_settings
     set qbo_refreshing_at = now()
   where client_id = p_client_id;

  return query select 'claimed'::text, r.qbo_refresh_token;
end;
$$;

-- Service-role only, like every other write path into this table.
revoke all on function public.qbo_claim_token_refresh(text, integer) from public, anon, authenticated;
