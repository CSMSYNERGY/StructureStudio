-- 123_allocate_ss_quote_number: hand out the next SS quote number, atomically.
--
-- WHY A FUNCTION AND NOT A READ-THEN-WRITE. submit-estimate would otherwise have to SELECT
-- ss_quote_next, add one, and UPDATE it — and two customers submitting in the same second
-- would both read the same value and both be issued the same quote number. `designs` has a
-- partial unique index on (client_id, ss_quote_number) as of 122, so the loser would fail its
-- persist AFTER the document was built and emailed: the customer holds a quote the database
-- refused to record. One UPDATE ... RETURNING takes a row lock and cannot interleave.
--
-- Returns the number the caller should USE (pre-increment), prefix included, or NULL when the
-- tenant has not set a starting number — which portal-settings already refuses to let happen
-- while invoice_in_ghl is false, so NULL here means a misconfigured tenant and the caller
-- should refuse rather than invent a 1.
--
-- Gaps are fine and expected: a submission that fails after allocation burns its number, the
-- same way the scheduler's take_next_serial() does. A gap is a curiosity; a duplicate is a
-- dispute with a customer.
--
-- SECURITY DEFINER + service-role only. client_settings is service-role by design, so no
-- browser can reach this; the grant is revoked from anon/authenticated explicitly rather than
-- left to the default, because a function that mints document numbers must not be callable by
-- the public internet even if some future migration widens the schema's defaults.
--
-- LEDGER NOTE: hand-applied live 2026-08-21 as (then-)113 on the stale feat/ss-invoicing
-- worktree; beta later took 113 for email_resend. Record THIS file as version 123 — insert
-- only, the function below is create-or-replace and already live.
--
-- Hand-apply via the SQL editor / MCP and record as version 123 — NEVER `supabase db push`.

create or replace function public.allocate_ss_quote_number(p_client_id text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_used   integer;
  v_prefix text;
begin
  update public.client_settings
     set ss_quote_next = ss_quote_next + 1,
         updated_at    = now()
   where client_id = p_client_id
     and ss_quote_next is not null
  returning ss_quote_next - 1, coalesce(ss_quote_prefix, '')
       into v_used, v_prefix;

  if v_used is null then
    return null;   -- no row, or no starting number set
  end if;

  return v_prefix || v_used::text;
end;
$fn$;

revoke execute on function public.allocate_ss_quote_number(text) from public;
revoke execute on function public.allocate_ss_quote_number(text) from anon;
revoke execute on function public.allocate_ss_quote_number(text) from authenticated;

-- Rollback: drop function if exists public.allocate_ss_quote_number(text);
