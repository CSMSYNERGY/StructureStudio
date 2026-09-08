-- 176_operator_support_only: an operator who sees the tenant the way its OWNER does.
--
-- ── THE PROBLEM, IN THE WORDS THAT DESCRIBED IT ────────────────────────────────────
-- Carolyn, 2026-09-01: "what is hard for me to know is ... if I want to log in as Junior
-- Barnes, I get MY permissions, not Junior Barnes permissions. So I don't know if it's
-- actually working the way I set it to do, because I can't go in and mirror one of them."
--
-- She is describing a real hole, not a misunderstanding. `_shared/resolveTenant.ts` hands
-- every operator in view-as `effectiveAccess("owner", "owner", null)`, which short-circuits
-- to `edit` on all 18 areas — and the operator branch never called `checkGate` at all, so the
-- per-area GATES table was bypassed outright. Two consequences that both mattered:
--
--   1. NOBODY COULD VERIFY A PERMISSION RULE. The only way to see what a builder sees was to
--      create a real login on their tenant and sign in as it. Per-area access shipped in 154
--      with no practical way to confirm it against a live account.
--   2. SUPPORT COULD NOT ANSWER "WHAT ARE THEY LOOKING AT?" — the thing support is for. The
--      one existing lever, app_operators.can_write = false, is a coarse WRITE ban: a
--      read-only operator still SEES everything, Billing and Commissions included.
--
-- ── WHY A COLUMN ON app_operators AND NOT A NEW TITLE ──────────────────────────────
-- Titles live on client_users, which is one row per (user, tenant). A support identity is
-- cross-tenant by definition — Jonathan must reach every builder without being invited to
-- each one — so it cannot be expressed there. 051's own header states this reasoning for why
-- app_operators exists separately at all; this follows it rather than arguing with it.
--
-- Choosing the column ALSO avoids the trap a new title would have walked into:
-- client_users_title_check (100_user_access.sql:52) is a hardcoded five-value CHECK, and the
-- database would have rejected the new title until that constraint was dropped and recreated.
-- Nothing in the code comments mentions that step.
--
-- ── WHAT THE FLAG RESOLVES TO ──────────────────────────────────────────────────────
-- The VIEWED TENANT'S OWNER row, resolved through the same `effectiveAccess` every real user
-- goes through, with settings_billing forced to 'none'. Mirroring the owner exactly would
-- hand a support account the card that pays for the product; "what the owner sees" is the
-- goal and their payment details are not part of answering a support question. requireBilling
-- is refused for a support operator regardless of can_bill, so the refusal does not depend on
-- anyone remembering to clear the other flag.
--
-- No owner row on the tenant — created but never invited, or the owner removed — falls back
-- to the ADMIN preset rather than to nothing. "No access" would make support useless on
-- exactly the accounts most likely to need it, and the admin preset is already this
-- codebase's name for "runs the business, does not see Billing".
--
-- ── APPLY THIS BEFORE DEPLOYING THE FUNCTIONS ──────────────────────────────────────
-- ⚠️ ORDERING IS NOT OPTIONAL HERE, and it fails in the worst direction. resolveTenant's
-- app_operators SELECT names `support_only`; PostgREST errors on a missing column rather than
-- returning null, and that select runs for EVERY operator on EVERY view-as request. Deploying
-- the functions first would take down operator access to every tenant at once. Apply this
-- first, confirm the column, then deploy. The reverse order is safe: the column sitting
-- unread by older code does nothing.
--
-- Additive and inert on its own — default false means every existing operator keeps the god
-- view they have today, which is the same posture 056 took when it added can_write/can_bill.
-- Hand-apply via the SQL editor / MCP and record as version 176. NEVER `supabase db push`.
-- (Ledger tip when this was written: 174_card_payments. 175 is authored and NOT applied.)

alter table public.app_operators
  add column if not exists support_only boolean not null default false;

comment on column public.app_operators.support_only is
  'Support operator: in view-as, resolve the VIEWED tenant''s owner access map instead of the blanket operator god view, with settings_billing forced to none and requireBilling refused. Default false — an existing operator is unchanged. Set per account by an admin; there is deliberately no self-service switch.';

-- ── The browser's second signal ────────────────────────────────────────────────────
-- `is_operator()` (051) answers "may I see the Accounts tab?" and cannot answer "which
-- KIND of operator am I?" — the portal needs both, because the tab clamp and the feature
-- gates branch on the difference. A sibling RPC rather than a changed return type: 051's
-- function is called from a live page that would break the moment its boolean became a
-- record, and there is no way to deploy a schema change and a static asset atomically.
--
-- Same posture as 051's own: SECURITY DEFINER over a table with RLS on and zero policies,
-- EXECUTE revoked from anon (the portal's anon-key refresh window would otherwise call it),
-- granted only to authenticated. It answers ONLY about the caller — it takes no argument, so
-- it cannot be used to enumerate who else is an operator.
--
-- FALSE for a non-operator as well as for a platform operator. That collapse is deliberate:
-- every caller pairs it with is_operator(), and "false" here consistently means "do not
-- apply the support narrowing", which is the safe reading for someone who is not an operator
-- at all.
create or replace function public.is_support_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_operators
    where user_id = auth.uid() and support_only
  );
$$;

revoke all on function public.is_support_operator() from public, anon;
grant execute on function public.is_support_operator() to authenticated;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────────────
-- Safe at any time PROVIDED the functions that select the column are rolled back first, for
-- the same reason the apply order matters above:
--   alter table public.app_operators drop column if exists support_only;
-- Dropping it does not widen anyone's access beyond what they had before 176 — every operator
-- simply returns to the god view, which is today's behaviour.
