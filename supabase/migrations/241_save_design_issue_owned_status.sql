-- 241_save_design_issue_owned_status.sql — a save is not a quote. save_design stops marking designs
-- 'sent'; submit-estimate marks them sent at the moment the estimate or quote number exists.
--
-- APPLY BY HAND (`supabase db query --linked` with the SQL INLINE, never --file; or the SQL
-- editor), as the owner, then record version 241 in supabase_migrations.schema_migrations.
-- NEVER `supabase db push`. Rehearse inside begin … rollback first.
--
-- ⛔ DEPLOY submit-estimate FIRST, and prove the LIVE copy promotes (download it and grep for
-- promoteIssuedDesign) before running this. This migration removes the only other draft → sent
-- path. Applied before that deploy, every successful quote would stay 'draft': hidden from the
-- customer's quotes page (customer-quotes skips drafts), never offered Accept, skipped by
-- sync-design-status. Nothing in this file can see the edge deploy, so it cannot check it for you.
--
-- ── THE BUG (found 2026-09-15) ───────────────────────────────────────────────────────────
-- Get Quote calls save_design with p_status null, THEN submit-estimate. save_design promoted on
-- that save: a new row was born `coalesce(p_status, 'sent')`, and an existing draft took
-- `excluded.status`, which a null p_status made 'sent'. submit-estimate then refused (the
-- tenant's CRM location had no user to assign the estimate to) and nothing put the row back.
-- testtttttt SS-TRJNVZJW5Z sat 'sent' with no estimate, no quote number and no email: listed on
-- the customer's quotes page, and held by 240's lock to the phone and email they might have been
-- trying to correct. SS-C2R4LQ8Q8W is the same shape from 2026-06-30 ("No GHL credentials").
-- submit-estimate has a long list of refusals after that save, and a throw, an edge timeout or a
-- tab closed between the two calls did the same. The portal was hit too: two of the logged "no
-- user to assign" refusals came from /portal/designer, whose first save inserted 'sent' outright.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────────────────────
-- 1. save_design NEVER PROMOTES, FOR ANY CALLER. A new row with p_status null is born 'draft';
--    on conflict, status stays exactly as stored. The p_status whitelist (null or 'draft') is
--    untouched, so no caller can write any other status through this RPC, and nothing here can
--    demote either.
--    ALL CALLERS, not only anon, decided from the callers (grep of every source, 2026-09-15):
--    the only save_design calls are the designer twins' own. The silent draft saves pass
--    'draft' (public page only), and submitQuote passes null (public and portal) and ALWAYS
--    calls submit-estimate next. No portal, admin, my-quotes or edge path saves a design and
--    expects it to read 'sent' afterwards: the portal ranks drafts below sent and refreshes its
--    lists through onSaved only after a successful submit; link_design_to_unit filters only
--    `status <> 'inventory'`; crm_quote_assign and the designs triggers never read status.
--    Keeping null → 'sent' for members would have kept this exact bug for every refused
--    portal submit.
-- 2. 240's CONTACT LOCK ALSO FOLLOWS THE PROOF OF ISSUE: it now holds when ghl_estimate_id or
--    accepted_at is set, not only past draft or with a quote number. In CRM mode ss_quote_number
--    is always null, so the lock rested on status alone, and status is now ONE guarded write in
--    submit-estimate. If that write fails after the estimate went out, the row still reads draft;
--    step 11's persist still stores ghl_estimate_id, and this is what keeps the phone and email
--    shut for it.
--
-- ── WHAT IT LEAVES ALONE ─────────────────────────────────────────────────────────────────
-- Every other character of the live body. The splice proves it: undoing exactly these five
-- replacements on the text it re-issues must give back what was live, byte for byte, and the
-- re-read live definition must equal that text. Resubmits of an issued quote, accepted /
-- invoiced / delivered designs, change orders and inventory masters were already past draft and
-- still never move. The orders trigger ignores draft and sent alike.
--
-- ── A SPLICE, NOT A BODY (197/220/240's discipline) ──────────────────────────────────────
-- save_design has been re-issued on live many times and no repo file is proof of what runs. So
-- this reads the LIVE definition, requires 240, refuses unless each anchor occurs exactly once,
-- re-issues, RE-READS LIVE, and checks the grants, SECURITY DEFINER and search_path did not
-- move. Idempotent: a second run sees its marker and does nothing.
--
-- ROLLBACK: run the splice block below alone with c_reverse set to true. It replaces new → old
-- under the same exactly-once, byte-identity and grant checks. Rolling back is safe with the new
-- submit-estimate live: its promote only writes a design that is still a draft.

do $splice$
declare
  -- ROLLBACK SWITCH. true undoes exactly these replacements (new → old). Leave false to apply.
  c_reverse    constant boolean := false;
  c_marker     constant text := '241: born a draft.';
  v_oid        oid;
  v_n          int;
  v_def        text;
  v_new        text;
  v_back       text;
  v_acl_before text;
  v_cfg_before text;
  c_old        text[];
  c_new        text[];
  v_from       text[];
  v_to         text[];
  i            int;
begin
  -- Dollar-quoted so the texts need no quote doubling. CRs are stripped below, so a CRLF
  -- checkout of this file can neither put \r into the live function nor miss an anchor.
  c_old := array[
    -- 1. the declarations 240 added (the new two hang off them)
    $o1$
  v_old_qn text;$o1$,
    -- 2. 240's read of the stored identity
    $o2$    select d4.contact, d4.ss_quote_number into v_old_contact, v_old_qn
$o2$,
    -- 3. 240's "past draft" test
    $o3$    if (coalesce(v_existing_status, '') <> 'draft' or v_old_qn is not null)
$o3$,
    -- 4. the insert's status: born 'sent' when p_status is null
    $o4$     coalesce(p_status, 'sent'),
$o4$,
    -- 5. the on-conflict promotion
    $o5$    status         = case when d.status = 'draft' then excluded.status else d.status end,
$o5$
  ];
  c_new := array[
    $n1$
  v_old_qn text;
  v_old_ghl_estimate_id text;
  v_old_accepted_at timestamptz;$n1$,
    $n2$    select d4.contact, d4.ss_quote_number, d4.ghl_estimate_id, d4.accepted_at
      into v_old_contact, v_old_qn, v_old_ghl_estimate_id, v_old_accepted_at
$n2$,
    $n3$    -- 241: the proof of issue holds it too, not status alone. submit-estimate marks a design
    -- sent in ONE guarded write beside its estimate id or quote number; if that write fails
    -- after the paperwork went out the row still reads draft, and in CRM mode (never a quote
    -- number) this lock would open for it. Step 11 still stores ghl_estimate_id; that holds it.
    if (coalesce(v_existing_status, '') <> 'draft' or v_old_qn is not null
        or v_old_ghl_estimate_id is not null or v_old_accepted_at is not null)
$n3$,
    $n4$     -- 241: born a draft. A save is not a quote: submit-estimate (service role) marks it sent
     -- once the estimate or quote number exists. Promoting here left refused quotes 'sent'.
     coalesce(p_status, 'draft'),
$n4$,
    $n5$    -- 241: a save never moves status, for any caller. draft -> sent belongs to submit-estimate
    -- at the moment of issue, and p_status (null or 'draft') can never demote.
    status         = d.status,
$n5$
  ];
  for i in 1 .. array_length(c_old, 1) loop
    c_old[i] := replace(c_old[i], E'\r', '');
    c_new[i] := replace(c_new[i], E'\r', '');
  end loop;

  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_design';
  if v_n <> 1 then
    raise exception '241: expected exactly one public.save_design, found % -- resolve the overload by hand', v_n;
  end if;
  select p.oid, p.proacl::text, p.proconfig::text into v_oid, v_acl_before, v_cfg_before
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_design';

  v_def := pg_get_functiondef(v_oid);

  if (position(c_marker in v_def) > 0) <> c_reverse then
    if c_reverse then
      raise notice '241 rollback: live save_design does not carry 241 -- nothing to undo';
    else
      raise notice '241: live save_design already leaves status to submit-estimate -- nothing to do';
    end if;
    return;
  end if;

  -- 240 must be live: two of the anchors are its lines.
  if position('240: whose quote it is.' in v_def) = 0 then
    raise exception '241: live save_design does not carry 240''s contact lock -- live has drifted, splice by hand';
  end if;

  if c_reverse then v_from := c_new; v_to := c_old; else v_from := c_old; v_to := c_new; end if;

  v_new := v_def;
  for i in 1 .. array_length(v_from, 1) loop
    v_n := (length(v_def) - length(replace(v_def, v_from[i], ''))) / length(v_from[i]);
    if v_n <> 1 then
      raise exception '241: expected exactly 1 of anchor % in the live save_design, found % -- splice by hand: %',
        i, v_n, btrim(v_from[i]);
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  for i in 1 .. array_length(v_to, 1) loop
    v_n := (length(v_new) - length(replace(v_new, v_to[i], ''))) / length(v_to[i]);
    if v_n <> 1 then
      raise exception '241: replacement % landed % times, expected once', i, v_n;
    end if;
  end loop;

  -- BYTE IDENTITY. Undo the replacements in reverse order; anything else that changed would
  -- survive the undo and fail this compare. Checked BEFORE the re-issue.
  v_back := v_new;
  for i in reverse array_length(v_to, 1) .. 1 loop
    v_back := replace(v_back, v_to[i], v_from[i]);
  end loop;
  if v_back is distinct from v_def then
    raise exception '241: undoing the splice does not reproduce the live definition -- refusing';
  end if;
  if not c_reverse and (position($x$coalesce(p_status, 'sent')$x$ in v_new) > 0
                        or position('then excluded.status' in v_new) > 0) then
    raise exception '241: a promotion arm survived the splice';
  end if;

  execute v_new;

  -- RE-READ LIVE. CREATE OR REPLACE keeps the oid, so this reads what now runs.
  if pg_get_functiondef(v_oid) is distinct from v_new then
    raise exception '241: live save_design is not the text this splice issued';
  end if;
  if (select p.proacl::text from pg_proc p where p.oid = v_oid) is distinct from v_acl_before then
    raise exception '241: save_design''s grants moved (was %)', v_acl_before;
  end if;
  if (select p.proconfig::text from pg_proc p where p.oid = v_oid) is distinct from v_cfg_before then
    raise exception '241: save_design''s search_path setting moved (was %)', v_cfg_before;
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = v_oid) then
    raise exception '241: save_design is no longer SECURITY DEFINER';
  end if;
  if c_reverse then
    raise notice '241 rollback: live save_design promotes on save again and 240''s lock reads status and quote number only';
  else
    raise notice '241: live save_design no longer promotes; 240''s lock also holds on ghl_estimate_id and accepted_at';
  end if;
end
$splice$;

-- ── The probe: every branch that matters, as the role that takes it. Rolled back. ─────────
-- A definitional check proves the text is present; only this proves the saves behave, for the
-- callers they are meant for. Two throwaway codes on a tenant with a member (testtttttt first).
do $probe$
declare
  cid   text;
  uid   uuid;
  c1    text := 'SS-RHRSLDRAFT';
  c2    text := 'SS-RHRSLMEMBR';
  who   jsonb := jsonb_build_object('name', '241 probe', 'phone', '(555) 555-0142', 'email', 'probe-241@example.com');
  moved jsonb;
  got   public.designs;
  msg   text;
begin
  if position('241: born a draft.' in pg_get_functiondef('public.save_design'::regproc)) = 0 then
    raise notice '241: live save_design does not carry 241 -- probe skipped';
    return;
  end if;
  select cu.client_id, cu.user_id into cid, uid
    from public.client_users cu join public.client_configs cc on cc.client_id = cu.client_id
   order by (cu.client_id = 'testtttttt') desc, cu.client_id
   limit 1;
  if cid is null or exists (select 1 from public.designs dd where dd.short_code in (c1, c2)) then
    raise notice '241: no tenant with a member, or a probe code already exists -- probe skipped';
    return;
  end if;
  moved := jsonb_set(who, '{phone}', to_jsonb('(555) 555-0199'::text));

  begin
    -- 1. ANON, a brand-new design with p_status null (exactly what Get Quote sends): a DRAFT.
    execute 'set local role anon';
    got := public.save_design(c1, cid, who, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    if got.status is distinct from 'draft' then
      raise exception '241 probe: an anonymous first save was born %, expected draft', got.status;
    end if;

    -- 2. ANON re-save, p_status null: still a draft (the on-conflict arm no longer promotes).
    execute 'set local role anon';
    got := public.save_design(c1, cid, who, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    if got.status is distinct from 'draft' then
      raise exception '241 probe: an anonymous re-save of a draft moved it to %', got.status;
    end if;

    -- 3-4. A MEMBER, signed in: re-saving that draft keeps it a draft, and a brand-new design is
    --      born a draft too (241 applies to every caller).
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    got := public.save_design(c1, cid, who, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    if got.status is distinct from 'draft' then
      raise exception '241 probe: a member re-save of a draft moved it to %', got.status;
    end if;
    execute 'set local role authenticated';
    got := public.save_design(c2, cid, who, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    if got.status is distinct from 'draft' then
      raise exception '241 probe: a member first save was born %, expected draft', got.status;
    end if;

    -- 5. Issued the way submit-estimate does it (service role, guarded on draft): sent. An anon
    --    re-save then leaves it sent, with p_status null and with 'draft'.
    update public.designs set status = 'sent' where short_code = c1 and status = 'draft';
    execute 'set local role anon';
    got := public.save_design(c1, cid, who, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    if got.status is distinct from 'sent' then
      raise exception '241 probe: an anonymous re-save (null) moved a sent design to %', got.status;
    end if;
    execute 'set local role anon';
    got := public.save_design(c1, cid, who, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, 'draft');
    execute 'reset role';
    if got.status is distinct from 'sent' then
      raise exception '241 probe: an anonymous draft save moved a sent design to %', got.status;
    end if;

    -- 6. Anon still may not name any other status.
    begin
      execute 'set local role anon';
      got := public.save_design(c1, cid, who, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, 'sent');
      raise exception '241 probe: ANON SET A STATUS OTHER THAN DRAFT';
    exception when others then
      msg := sqlerrm;
      if msg like '241 probe:%' then raise; end if;
      if msg <> 'invalid status' then raise exception '241 probe: p_status ''sent'' refused, but not by the whitelist (%)', msg; end if;
    end;

    -- 7. The CRM estimate went out but the promote write failed: draft + ghl_estimate_id. Anon may
    --    not change the phone (241's hardening); the same identity still saves.
    update public.designs set status = 'draft', ghl_estimate_id = 'probe-241-estimate' where short_code = c1;
    begin
      execute 'set local role anon';
      got := public.save_design(c1, cid, moved, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
      raise exception '241 probe: ANON CHANGED THE PHONE ON A DRAFT THAT CARRIES A CRM ESTIMATE';
    exception when others then
      msg := sqlerrm;
      if msg like '241 probe:%' then raise; end if;
      if msg not like 'this design is locked to its phone number%' then
        raise exception '241 probe: the estimate-id draft refused, but not by the contact lock (%)', msg;
      end if;
    end;
    execute 'set local role anon';
    got := public.save_design(c1, cid, who, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    if got.status is distinct from 'draft' then
      raise exception '241 probe: the unchanged-identity save moved the estimate-id draft to %', got.status;
    end if;

    -- 8. accepted_at on a draft: anon refused (220's lock answers first; 240's would too).
    update public.designs set ghl_estimate_id = null, accepted_at = now() where short_code = c1;
    begin
      execute 'set local role anon';
      got := public.save_design(c1, cid, moved, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
      raise exception '241 probe: ANON CHANGED THE PHONE ON AN ACCEPTED DRAFT';
    exception when others then
      msg := sqlerrm;
      if msg like '241 probe:%' then raise; end if;
      if msg not like 'this design is locked%' then
        raise exception '241 probe: the accepted draft refused, but not by a lock (%)', msg;
      end if;
    end;

    -- 9. A plain draft with no proof of issue: anon may still change the phone (the visitor is
    --    still typing), exactly as before.
    update public.designs set accepted_at = null where short_code = c1;
    execute 'set local role anon';
    got := public.save_design(c1, cid, moved, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    if got.contact->>'phone' is distinct from '(555) 555-0199' or got.status is distinct from 'draft' then
      raise exception '241 probe: an anon save could not change the phone on a plain draft';
    end if;

    -- 10. A MEMBER may change the phone on a draft that carries an estimate id.
    update public.designs set ghl_estimate_id = 'probe-241-estimate' where short_code = c1;
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    got := public.save_design(c1, cid, who, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null);
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    if got.contact->>'phone' is distinct from '(555) 555-0142' then
      raise exception '241 probe: a signed-in member could not change the phone on an estimate-id draft';
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '241: anon and member first saves are drafts; re-saves never move status; sent stays sent; the contact lock holds on an estimate id and on accepted_at; plain drafts and members still edit';
      else
        raise;
      end if;
  end;
end
$probe$;
