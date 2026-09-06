-- 197_save_design_protect_accepted.sql
-- Extend migration 111's post-agreement guard down one rung, to the rung the customer's own
-- agreement actually lands on: ACCEPTED.
--
-- APPLY BY HAND (SQL editor / MCP execute_sql / `supabase db query --linked`, as the owner),
-- then record the row in supabase_migrations.schema_migrations. NEVER `supabase db push`.
--
-- ── THE GAP ──────────────────────────────────────────────────────────────────
-- 104 stopped anonymous rewrites of inventory masters. 111 stopped them for designs whose
-- paperwork had been issued, and stopped at 'invoiced' / 'delivered'. The status ladder has a
-- rung below those: 'accepted', set by customer-accept when the customer agrees on their own
-- quote page, alongside designs.accepted_at (122) and the append-only design_acceptances
-- record (124).
--
-- Between the agreement and the invoice the design is ALREADY an agreed document. The app
-- treats it as one everywhere else: submit-estimate raises a change order for any revision
-- past that point (126), and portal-settings' send_invoice 409s while one is pending. Only
-- save_design did not — anyone holding the short code (it appears in the public floor-plan PDF
-- URL) could rewrite the content underneath all of it, and the acceptance record would still
-- read as agreement to something the row no longer says. Found by the 2026-09-06 audit; the
-- 2026-08-20 audit that produced 111 stopped at the billing rungs.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────────
-- One condition, the one 111 added:
--   before:  if v_existing_status in ('invoiced', 'delivered') then
--   after:   if v_existing_status in ('accepted', 'invoiced', 'delivered')
--               or exists (select 1 from public.designs d2
--                           where d2.short_code = p_code and d2.accepted_at is not null) then
--
-- The accepted_at arm is not belt-and-braces for its own sake. `status` is a LADDER whose
-- later rungs overwrite earlier ones, and which sync-design-status re-projects from GHL — 122
-- says exactly that, which is why accepted_at exists as a separate column at all. accepted_at
-- is the durable fact of the agreement, and it is what submit-estimate itself keys the
-- change-order machinery on. Guarding on the status string alone would let the guard and the
-- change-order rule disagree the first time the projection moved a rung.
--
-- WHO MAY STILL EDIT is unchanged from 111: a member of the design's tenant (client_users) or
-- an operator (app_operators). That is the point of the guard's shape — the builder reopening
-- an agreed design and resubmitting IS the change-order flow (126: the design_edit source is
-- the rep's edit), and it keeps working exactly as it does today. Only a caller with no
-- session, or a session belonging to neither this tenant nor the operator table, is refused.
-- The customer quote page offers no design edit at all, so nothing a customer can legitimately
-- do is taken away.
--
-- The refusal message widens with the guard: telling someone whose design was merely accepted
-- that it "has been invoiced" is a support ticket. Nothing branches on the string — the
-- designer surfaces it verbatim ("Save failed: …") and no other code matches it — so this is
-- copy, not contract.
--
-- CONTRACT: unchanged. Same signature, same return type, same volatility, same owner, and
-- CREATE OR REPLACE keeps the existing grants (anon, authenticated), so the frozen production
-- designer keeps calling it exactly as it does now.
--
-- ── ⚠️ WHY THIS FILE CARRIES NO FUNCTION BODY ────────────────────────────────
-- save_design is one of the functions this repo replaces WHOLESALE on live, and no file in the
-- tree is proof of what is running — 110, 130 and 133 all document the trap. 002 predates 031's
-- version snapshot, 104's inventory guard, 111's guard and 133's CRM stamp; rebuilding from any
-- of them silently un-ships whatever came later.
--
-- So this migration ships a SPLICE, not a body. It reads the LIVE definition with
-- pg_get_functiondef, refuses unless it finds exactly one copy of the condition it means to
-- widen, rewrites that one condition, re-issues the result, and then re-reads live to prove the
-- widened guard is really there. Everything else that is live rides along untouched by
-- construction, and there is no hand diff to get wrong.
--
-- Idempotent: a second run sees the widened guard and does nothing.
-- Rollback: the same splice in reverse — regexp_replace the widened condition back to
--   `v_existing_status in ('invoiced', 'delivered')`. Never restore from a repo body.

do $splice$
declare
  v_oid oid;
  v_n   int;
  v_def text;
  v_new text;
  -- Whitespace-tolerant, bracket-classes instead of backslash escapes so nothing depends on
  -- standard_conforming_strings.
  c_old constant text :=
    'v_existing_status[[:space:]]+in[[:space:]]*[(][[:space:]]*''invoiced''[[:space:]]*,'
    || '[[:space:]]*''delivered''[[:space:]]*[)]';
  c_new constant text :=
    'v_existing_status in (''accepted'', ''invoiced'', ''delivered'')'
    || ' or exists (select 1 from public.designs d2'
    || ' where d2.short_code = p_code and d2.accepted_at is not null)';
  c_marker  constant text := '''accepted'', ''invoiced'', ''delivered''';
  c_msg_old constant text := 'design has been invoiced -- ask the builder to change it';
  c_msg_new constant text := 'this design is locked -- ask the builder to change it';
begin
  select count(*) into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_design';
  if v_n <> 1 then
    raise exception '197: expected exactly one public.save_design, found % -- resolve the overload by hand', v_n;
  end if;
  select p.oid into v_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_design';

  v_def := pg_get_functiondef(v_oid);

  if position(c_marker in v_def) > 0 then
    raise notice '197: live save_design already guards accepted designs -- nothing to do';
    return;
  end if;

  select count(*) into v_n from regexp_matches(v_def, c_old, 'g');
  if v_n <> 1 then
    raise exception '197: expected exactly 1 copy of migration 111''s status guard in the live save_design, found % -- live has drifted, splice by hand', v_n;
  end if;

  v_new := regexp_replace(v_def, c_old, c_new);

  -- Copy, not contract, and deliberately tolerant: a reworded message must not be able to
  -- block the security change.
  if position(c_msg_old in v_new) > 0 then
    v_new := replace(v_new, c_msg_old, c_msg_new);
  else
    raise notice '197: refusal message not found verbatim -- left as it is';
  end if;

  execute v_new;

  -- Prove it against live before this transaction is allowed to commit. CREATE OR REPLACE
  -- keeps the oid, so this reads the function just re-issued.
  if position(c_marker in pg_get_functiondef(v_oid)) = 0 then
    raise exception '197: re-issued save_design does not carry the widened guard';
  end if;
end
$splice$;

-- ── VERIFY AFTER APPLYING ────────────────────────────────────────────────────
--   select pg_get_functiondef('public.save_design'::regproc);
--     -> the guard reads `in ('accepted', 'invoiced', 'delivered') or exists (…accepted_at…)`
--        and NOTHING else in the body has moved.
--
--   In a transaction, rolled back afterwards, on an internal tenant:
--     1. take a design to 'accepted' (or just stamp accepted_at), then
--        `set local role anon; select public.save_design(…same code…);`
--        -> refused: "this design is locked -- ask the builder to change it"
--     2. same call as a client_users member of that tenant -> SAVES, and design_versions
--        gains a row (the back-office revision path that raises the change order).
--     3. a design still at 'sent' with accepted_at null -> anon SAVES, unchanged.
