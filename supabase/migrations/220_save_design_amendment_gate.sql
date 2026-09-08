-- 220_save_design_amendment_gate.sql — the last door. A signed design cannot be rewritten
-- while the builder's own rules hold the order shut, EVEN BY THEIR OWN STAFF.
--
-- ⚠️ THIS IS THE ONE THAT CAN LOCK EVERY REP OUT OF EVERY ACCEPTED DESIGN. It ships last, on
-- purpose, after the settings card, the order screen and amendment mode are all live — because
-- the only way out of a refusal here is a button, and until this week there was no button.
--
-- ROLLBACK, FIRST, BECAUSE THAT IS WHEN YOU WILL WANT IT.
--
--   THE FAST ONE, AND THE RIGHT ONE: switch the tenant's `co_unlock_required` back OFF.
--   order_amendment_gate answers OPEN for every design at that setting, so the check below
--   becomes a no-op without touching a line of code. One checkbox, in Settings → CRM
--   Connection → Changing a signed order. Reach for this first, always.
--
--   THE CODE ONE, if the check itself is wrong rather than the policy — the splice in
--   reverse, cutting from the marker comment to the line before the block's closing `end if`:
--
--     do $r$ declare v_oid oid; v_def text; begin
--       select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname='public' and p.proname='save_design';
--       v_def := pg_get_functiondef(v_oid);
--       v_def := regexp_replace(v_def,
--         '[[:space:]]*-- 220: the builder''s own rules[\s\S]*?end if;([[:space:]]*end if;)',
--         E'\\1', 'n');
--       execute v_def;
--     end $r$;
--
-- ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────────────────
-- submit-estimate refuses to amend a locked order (2026-09-07) before it writes anything. But
-- the designer calls `save_design` FIRST, and that RPC writes selections, items, the drawing
-- and a design_versions row. So on a locked order the sequence was:
--
--     save_design     → the rep's edit lands on the design row
--     submit-estimate → refused; no change order, nothing priced, nobody told
--
-- leaving a signed design carrying a revision no change order records and no customer agreed
-- to — precisely the state migrations 153 and 197 exist to prevent, reached through the one
-- door neither of them watches. 197 stopped the anonymous internet and deliberately let tenant
-- staff through, because "the builder reopening an agreed design and resubmitting IS the
-- change-order flow". That is still true. It is simply no longer unconditional: it is true
-- while the ORDER is open for change, and the builder decides when that is.
--
-- ── WHY IT BINDS OPERATORS TOO ───────────────────────────────────────────────────────────
-- The refusal covers every caller inside 197's block, us included. An operator holds every
-- area, so the way out is the same button a rep uses — and an operator quietly rewriting a
-- signed design with no change order recorded is exactly the invisible edit this whole feature
-- exists to end. A support path that leaves no trail is not a support path.
--
-- ── FAIL OPEN ────────────────────────────────────────────────────────────────────────────
-- `order_amendment_gate` never raises (210), and the coalesce below reads a missing or
-- unparseable answer as OPEN. A gate that cannot answer must not stop a builder saving their
-- own work.
--
-- ── A SPLICE, NOT A BODY (197's discipline, and its reasoning) ───────────────────────────
-- Live save_design has been re-issued by several migrations; the repo holds no copy known to
-- match. So this reads the LIVE definition, refuses unless it finds exactly one copy of what
-- it means to widen, rewrites that one place, re-issues, and RE-READS LIVE to prove it took.
-- Everything else that is live rides along untouched by construction, and there is no hand
-- diff to get wrong. Idempotent: a second run sees its own marker and does nothing.

do $splice$
declare
  v_oid oid;
  v_n   int;
  v_def text;
  v_new text;
  -- 197's whole refusal block, matched from its message (the one string in this function
  -- unique to it) through the two `end if;` that close it. Whitespace-tolerant; bracket
  -- classes rather than backslash escapes, so nothing depends on standard_conforming_strings.
  c_anchor constant text :=
    'raise[[:space:]]+exception[[:space:]]+''this design is locked -- ask the builder to change it'';'
    || '[[:space:]]*end[[:space:]]+if;[[:space:]]*end[[:space:]]+if;';
  c_marker constant text := '220: the builder''s own rules';
  -- The replacement, written so that '' produces one literal quote in the OUTPUT — the body
  -- lands inside $function$ dollar quotes, where quotes are literal and must NOT be doubled.
  c_add constant text :=
      E'raise exception ''this design is locked -- ask the builder to change it'';\n'
   || E'    end if;\n'
   || E'    -- 220: the builder''s own rules. A member may edit an agreed design, but only\n'
   || E'    -- while the ORDER is open for change -- inside the free window, under an unlock\n'
   || E'    -- somebody granted, or with a change already underway. The same function\n'
   || E'    -- submit-estimate, stage_order_attribute_change and the change_orders guard all\n'
   || E'    -- ask, so a refusal here and a refusal there can never disagree. Without this the\n'
   || E'    -- designer''s save landed the rep''s edit on a signed design and submit-estimate\n'
   || E'    -- then refused it, leaving a revision no change order records.\n'
   || E'    -- FAILS OPEN: a gate that cannot answer must not stop a builder saving their work.\n'
   || E'    v_gate := public.order_amendment_gate(p_client_id, p_code);\n'
   || E'    if not coalesce((v_gate->>''open'')::boolean, true) then\n'
   || E'      raise exception ''%'', coalesce(nullif(btrim(v_gate->>''reason''), ''''),\n'
   || E'        ''this order is signed -- an admin or crew leader has to unlock it before it can be changed'');\n'
   || E'    end if;\n'
   || E'  end if;';
begin
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_design';
  if v_n <> 1 then
    raise exception '220: expected exactly one public.save_design, found % -- resolve the overload by hand', v_n;
  end if;
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_design';

  v_def := pg_get_functiondef(v_oid);

  if position(c_marker in v_def) > 0 then
    raise notice '220: live save_design already asks the amendment gate -- nothing to do';
    return;
  end if;

  -- 197 must be in place first. Without its block there is nothing to widen, and widening the
  -- wrong place would put this gate in front of every anonymous customer save.
  select count(*) into v_n from regexp_matches(v_def, c_anchor, 'g');
  if v_n <> 1 then
    raise exception '220: expected exactly 1 copy of migration 197''s refusal block in the live save_design, found % -- live has drifted, splice by hand', v_n;
  end if;

  -- The gate's answer needs somewhere to live.
  if position('v_contact_id uuid;' in v_def) = 0 then
    raise exception '220: could not find the declare block to add v_gate to -- splice by hand';
  end if;
  v_new := replace(v_def, 'v_contact_id uuid;', E'v_contact_id uuid;\n  v_gate jsonb;');
  v_new := regexp_replace(v_new, c_anchor, c_add);

  execute v_new;

  -- RE-READ LIVE. "It was replaced in a variable" is not proof that it is what runs.
  v_def := pg_get_functiondef(v_oid);
  if position(c_marker in v_def) = 0 then
    raise exception '220: the re-issue did not take -- live save_design still has no gate check';
  end if;
  if position('order_amendment_gate' in v_def) = 0 then
    raise exception '220: the marker landed but the call did not';
  end if;
  if position('v_gate jsonb;' in v_def) = 0 then
    raise exception '220: the marker landed but the declaration did not';
  end if;
  raise notice '220: live save_design now asks order_amendment_gate before a member may rewrite a signed design';
end
$splice$;

-- ── The probe: the branch that matters, driven as a real signed-in member. ──────────────
-- 214's lesson, applied. A definitional assertion proves the text is present; only this
-- proves the refusal FIRES, and only for the caller it is meant to fire for. Rolled back.
--
-- ⚠️ IT SAVES THE DESIGN'S OWN CURRENT VALUES BACK, never empties. The rollback is what makes
-- the probe safe, but a probe whose worst case is "a real signed design is blanked" is one
-- assumption away from a disaster; passing the row's existing content back means even a
-- rollback that somehow did not happen changes nothing.
do $probe$
declare
  cid text; code text; uid uuid; d public.designs; got public.designs; msg text;
begin
  select cu.client_id, cu.user_id into cid, uid
    from public.client_users cu
   where cu.client_id = 'structure-studio'
   limit 1;
  select * into d
    from public.designs dd
   where dd.client_id = cid and dd.accepted_at is not null
     and dd.status <> 'inventory'
     and not exists (select 1 from public.change_orders c
                      where c.client_id = dd.client_id and c.short_code = dd.short_code
                        and c.status in ('draft','pending_ack'))
   limit 1;
  if d.short_code is null or uid is null then
    raise notice '220: no signed design free of a live change on structure-studio -- probe skipped';
    return;
  end if;
  code := d.short_code;

  begin
    -- Become that member for the rest of this sub-transaction. auth.uid() reads the JWT
    -- claim, so this is the only way to exercise the branch 197 opened for staff.
    perform set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);
    if auth.uid() is distinct from uid then
      raise exception '220 probe: could not impersonate a member -- auth.uid() reads %', auth.uid();
    end if;

    -- 1. REGIME OFF (the shipping default): the save goes through, exactly as today.
    update public.client_settings set co_unlock_required = false where client_id = cid;
    got := public.save_design(code, cid, d.contact, d.selections, d.paint_colors, d.items,
                              d.custom_options, d.ro_dimensions, d.bldg_w, d.bldg_h, null, null);
    if got.short_code is null then raise exception '220 probe: the dormant save returned nothing'; end if;

    -- 2. REGIME ON, nothing unlocked: the same member, refused, with a sentence.
    update public.client_settings
       set co_unlock_required = true, co_free_days = 0, co_fee_cents = 0
     where client_id = cid;
    begin
      got := public.save_design(code, cid, d.contact, d.selections, d.paint_colors, d.items,
                                d.custom_options, d.ro_dimensions, d.bldg_w, d.bldg_h, null, null);
      raise exception '220 probe: A MEMBER REWROTE A LOCKED SIGNED DESIGN -- the gate did not fire';
    exception when others then
      msg := sqlerrm;
      if msg like '220 probe:%' then raise; end if;
      if msg not like '%unlock%' then
        raise exception '220 probe: refused, but not by the gate (%)', msg;
      end if;
    end;

    -- 3. A CHANGE ALREADY UNDERWAY re-opens it (215), so the rep can do the work they were
    --    just given permission to do. This is the case that makes the whole flow usable, and
    --    the one whose absence would have made 220 a wall rather than a door.
    --
    --    ⚠️ THE UNLOCK COMES FIRST, and the probe's first draft did not have it — the change
    --    order insert was refused by change_orders_guard with the very sentence 220 raises,
    --    from a different door. That is the system being consistent (opening a change needs
    --    authority just as changing the design does), and it is also the reason a rep can
    --    never reach step 3 by accident: there is no way to have a live change on a locked
    --    order without somebody having allowed it.
    insert into public.order_unlocks (client_id, short_code, reason, decision, decided_at, expires_at)
    values (cid, code, '220 probe', 'granted', now(), now() + interval '1 hour');
    insert into public.change_orders (client_id, short_code, source, status, description)
    values (cid, code, 'design_edit', 'draft', '220 probe -- rolled back');
    got := public.save_design(code, cid, d.contact, d.selections, d.paint_colors, d.items,
                              d.custom_options, d.ro_dimensions, d.bldg_w, d.bldg_h, null, null);
    if got.short_code is null then raise exception '220 probe: the mid-amendment save was refused'; end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '220: dormant saves pass, a locked signed design refuses its own tenant, and an open change lets it through';
      else
        raise;
      end if;
  end;
end
$probe$;
