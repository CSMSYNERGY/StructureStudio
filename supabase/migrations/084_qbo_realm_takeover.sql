-- 084_qbo_realm_takeover.sql
--
-- Connecting a QuickBooks company that is already attached to a DIFFERENT StructureStudio
-- account now TAKES IT OVER, instead of being refused with reason=realm_in_use.
--
-- WHY THIS IS SAFE. Attaching a company requires completing Intuit's OAuth consent for that
-- company, which requires credentials for it. Anyone who can do that already controls those
-- books, so they are entitled to decide which StructureStudio account syncs to them. No
-- StructureStudio-side permission is being bypassed: the consent screen is the authorization.
--
-- THE UNIQUE INDEX STAYS. It is not the thing being relaxed. It still guarantees exactly ONE
-- tenant per company at any moment, which is the property that actually matters — two tenants
-- sharing a realm would each rotate the other's refresh token out from under them (Intuit
-- rotates on every refresh; see _shared/qboToken.ts). Takeover is a hand-off, never a share.
--
-- WHAT IT COSTS, AND WHY THE TRAIL BELOW EXISTS. This converts a loud refusal into a silent
-- side effect on somebody else's account. Mis-picking in Intuit's company selector is one
-- click — it happened on 2026-08-03, when the operator selected the sandbox company attached
-- to `testtttttt` while connecting `structure-studio` — and under this behaviour that click
-- would have stopped the other tenant's invoice syncing with nothing on screen to say so.
-- So displacement is never silent:
--   * the displaced row records a human-readable qbo_disconnect_reason, surfaced by
--     qbo_status and rendered on their (now not-connected) QuickBooks card;
--   * an admin_audit row is written naming both sides;
--   * qbo_item_map is KEPT, so reconnecting the same company loses no mapping work.

alter table public.client_settings
  add column if not exists qbo_disconnect_reason text;

comment on column public.client_settings.qbo_disconnect_reason is
  'Why QuickBooks stopped being connected when it was NOT this tenant''s own action — '
  'currently only: their QuickBooks company was taken over by another StructureStudio '
  'account. Cleared on reconnect and on an explicit self-disconnect.';

-- Hand a QuickBooks company over to p_new_client_id, clearing it off whoever holds it now.
-- Returns the displaced client_id, or NULL if nobody else held it (the ordinary case).
--
-- Callers must invoke this ONLY after Intuit's consent + connect-verify have succeeded for
-- p_realm_id. It deliberately takes no view on whether the caller "should" have the company:
-- proving control of the books is the callback's job, and it has already been done by the
-- time this runs.
create or replace function public.qbo_displace_realm(
  p_realm_id      text,
  p_new_client_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_displaced text;
begin
  if p_realm_id is null or p_new_client_id is null then
    return null;
  end if;

  -- Serialise takeovers of the SAME company. Two tenants completing consent for one realm in
  -- the same instant must not both come away believing they won it.
  perform pg_advisory_xact_lock(hashtext('qbo_realm:' || p_realm_id));

  -- At most one row can match: the partial unique index on qbo_realm_id guarantees it.
  -- qbo_company_name is deliberately KEPT — it names the company in the message below and
  -- makes a later reconnect recognisable. qbo_item_map is untouched.
  update client_settings
     set qbo_realm_id                 = null,
         qbo_access_token             = null,
         qbo_access_token_expires_at  = null,
         qbo_refresh_token            = null,
         qbo_refresh_token_expires_at = null,
         qbo_connected_at             = null,
         qbo_refresh_error            = null,
         qbo_refreshing_at            = null,
         qbo_token_refreshed_at       = null,
         qbo_oauth_state              = null,
         qbo_oauth_state_expires_at   = null,
         qbo_disconnect_reason        =
           coalesce(qbo_company_name, 'That QuickBooks company')
           || ' was connected to a different StructureStudio account on '
           || to_char(now() at time zone 'UTC', 'Mon DD, YYYY')
           || ', so syncing here has stopped. Your item mappings were kept — reconnect to resume.'
   where qbo_realm_id = p_realm_id
     and client_id   <> p_new_client_id
  returning client_id into v_displaced;

  if v_displaced is not null then
    insert into admin_audit (action, target_client_id, row_count, note)
    values ('qbo_realm_displaced', v_displaced, 1,
            'QuickBooks company handed over to ' || p_new_client_id);
  end if;

  return v_displaced;
end;
$$;

-- Service role only. This is reachable exclusively from qbo-oauth-callback, after consent.
revoke all on function public.qbo_displace_realm(text, text) from public, anon, authenticated;
grant execute on function public.qbo_displace_realm(text, text) to service_role;
