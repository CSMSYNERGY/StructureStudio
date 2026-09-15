-- 240_save_design_contact_identity_lock.sql — a sent quote's phone and email say whose quote it
-- is, so the anonymous internet may no longer rewrite them.
--
-- APPLY BY HAND (`supabase db query --linked` with the SQL INLINE, never --file; or the SQL
-- editor), as the owner, then record version 240 in supabase_migrations.schema_migrations.
-- NEVER `supabase db push`. Rehearse inside begin … rollback first.
--
-- ── THE HOLE (found 2026-09-15 while planning customer login) ─────────────────────────────
-- customer-quotes, customer-accept and customer-pay decide who owns a design by matching its
-- contact phone (and, with 230's email login, its contact email) against a VERIFIED login:
-- phoneKey(designs.contact.phone) === the phone the session proved. That contact blob is
-- written by save_design, which anon may call, and the upsert set `contact = excluded.contact`
-- unconditionally. 197 and 220 lock the design once it is accepted — but a SENT quote was
-- still open, and its short code is in the quote PDF's public URL. So anyone holding a sent
-- quote's link could:
--
--     save_design(code, …, contact with THEIR phone)   → accepted, as anon
--     /my-quotes, verify THEIR phone by text           → the session now "owns" the quote
--     customer-accept                                  → accepts it, later signs its invoice
--
-- Confirmed against live on 2026-09-15 before writing this: as role anon (auth.uid() null),
-- save_design on a structure-studio design at status 'sent' carrying SST-5017 stored a new
-- phone AND a new email. Rolled back.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────────────────────
-- Once a design exists past 'draft' (or carries ss_quote_number), a caller who is neither a
-- member of its tenant (client_users) nor an operator (app_operators) — the exact test 111/197
-- use — is REFUSED if the save would change contact.phone or contact.email. Everything else in
-- the save still lands for them: name, street/city/state/zip, the building itself.
--
-- REFUSE, NOT IGNORE. Silently keeping the old phone would save a row that disagrees with what
-- the browser then hands submit-estimate, and nobody would be told. A refusal is visible. The
-- sentence contains "this design is locked", which the designer's existing filter
-- (/unlock it before it can be changed|this design is locked/i, StructureStudio.jsx and
-- structure-studio.component.js) already shows verbatim instead of "Save failed: …", so no
-- frontend change is needed for it to read well.
--
-- "CHANGED" IS JUDGED THE WAY OWNERSHIP IS, AND NEVER MORE LOOSELY. If this check called two
-- values equal while ownsDesign called them different, the hole would reopen through the gap.
--   phone: _shared/phoneKey.ts — every non-digit stripped, a leading 1 on eleven digits
--          dropped. [^0-9] here is JS's \D (both ASCII-only). "(816) 300-3600" → "+1 816 300
--          3600" is not a change; any other digit is.
--   email: _shared/emailOtp.ts normalizeEmail — trim + toLowerCase. Here: equal after btrim, or
--          equal after btrim + lower when BOTH sides are plain ASCII. Non-ASCII must match
--          exactly, because Postgres lower() and JS toLowerCase() are not guaranteed to fold
--          the same way outside ASCII. That can only refuse more than ownsDesign would, never
--          less.
--   A phone or email that is not a JSON string (a number, an object) must stay byte-identical.
--   Filling a blank one in is a change (it claims an unowned quote). Blanking one is a change
--   (it strips the real customer's access, and the next save could then "fill it in").
--
-- ── WHAT IT DELIBERATELY LEAVES ALONE ────────────────────────────────────────────────────
-- * Drafts. A draft has no PDF and no public link; the visitor is still typing their details,
--   and the first real submit is what promotes it. customer-quotes already refuses to list
--   drafts, and 231's saved-designs list reads only links a verified session wrote.
-- * Builders and operators. The portal designer saves through this same RPC as an
--   authenticated member, and correcting a customer's number is ordinary back-office work.
-- * A customer resubmitting their own quote from its link. The designer loads the stored
--   contact, so the phone and email go back unchanged and the save passes. The phone input
--   only reformats on an edit, and formatPhoneDisplay keeps all eleven digits of a "+1"
--   number, so a re-typed format still passes the phoneKey compare.
--   ⚠️ LEGACY 6-CHARACTER CODES are the exception (48 past draft on 2026-09-15: 40 sent, 1
--   accepted, 7 invoiced). load_design strips `contact` from them because such a code is
--   guessable, so the designer reopens one with a blank contact and the customer types it
--   again. The same phone and email pass; a different or missing one is refused. That is
--   the right answer for a code that proves nothing, and those quotes predate the 10-char
--   codes by weeks.
--   ⚠️ One consequence for the login-UI branch (ss/login-ui-0914): its effect that re-asserts
--   the verified phone/email onto the contact would, on a SENT quote whose stored email is
--   blank or different, now be refused at save. That is correct — it is exactly the takeover
--   shape — but the designer should start a new quote there rather than resubmit that code.
--
-- ── A SPLICE, NOT A BODY (197/220's discipline) ──────────────────────────────────────────
-- save_design has been re-issued wholesale on live many times and no repo file is proof of
-- what runs; 002 predates 031's version snapshot, 104, 111, 133, 189, 197 and 220. So this
-- reads the LIVE definition, refuses unless it finds exactly one of each anchor, inserts one
-- declare line group and one block, re-issues, and RE-READS LIVE to prove it took and that the
-- grants, SECURITY DEFINER and search_path did not move. Idempotent: a second run sees its
-- marker and does nothing.
--
-- ROLLBACK — the splice in reverse. Rehearsed on 2026-09-15: stripping exactly this from the
-- new definition reproduces the pre-240 definition byte-for-byte (md5-compared).
--
--   do $r$ declare v_oid oid := 'public.save_design'::regproc; v_def text; v_s int; v_e int; begin
--     v_def := pg_get_functiondef(v_oid);
--     v_s := position('  -- 240: whose quote it is.' in v_def);
--     v_e := position('  if p_image_url is not null then' in v_def);
--     if v_s = 0 or v_e <= v_s then raise exception 'rollback 240: markers not found'; end if;
--     v_def := left(v_def, v_s - 1) || substr(v_def, v_e);
--     v_def := replace(v_def, E'\n  v_old_contact jsonb;\n  v_new_contact jsonb;\n  v_old_qn text;\n  v_id_a text;\n  v_id_b text;\n  v_id_changed boolean := false;', '');
--     execute v_def;
--   end $r$;

do $splice$
declare
  v_oid        oid;
  v_n          int;
  v_def        text;
  v_new        text;
  v_block      text;
  v_acl_before text;
  v_cfg_before text;
  c_marker constant text := '240: whose quote it is.';
  c_anchor constant text := '  if p_image_url is not null then';
  c_gate   constant text := 'v_gate jsonb;';
  c_decl   constant text := E'\n  v_old_contact jsonb;\n  v_new_contact jsonb;\n  v_old_qn text;\n  v_id_a text;\n  v_id_b text;\n  v_id_changed boolean := false;';
begin
  -- Dollar-quoted so the body needs no quote doubling; CRs stripped so a CRLF checkout of this
  -- file cannot put \r into the live function (the rollback's byte-for-byte claim depends on it).
  v_block := replace($blk$  -- 240: whose quote it is. Past draft, the contact phone and email are the identity
  -- customer-quotes, customer-accept and customer-pay match a VERIFIED login against, and
  -- the short code travels in the quote PDF's public URL. Letting anyone holding the code
  -- change them let a stranger put their own number on a sent quote, sign in with it, accept
  -- the quote and sign its invoice. Once a design is sent (or carries a quote number) only a
  -- member of this tenant or an operator may change either; name, address and the building
  -- still save for anyone holding the code, as before. REFUSE, never silently keep: a row
  -- that disagrees with what the browser sends on to submit-estimate helps nobody.
  -- "Changed" is judged the way ownership is and never more loosely: the phone as phoneKey
  -- does (digits only, a leading 1 on eleven digits dropped), the email trimmed, and
  -- lower-cased only when both sides are plain ASCII. Filling a blank one in is a change;
  -- blanking one is a change; a value that is not a JSON string must stay identical.
  if v_existing_client is not null then
    select d4.contact, d4.ss_quote_number into v_old_contact, v_old_qn
      from public.designs d4 where d4.short_code = p_code;
    if (coalesce(v_existing_status, '') <> 'draft' or v_old_qn is not null)
       and (auth.uid() is null or not (
         exists (select 1 from public.client_users cu
                  where cu.user_id = auth.uid() and cu.client_id = p_client_id)
         or exists (select 1 from public.app_operators op where op.user_id = auth.uid())
       )) then
      v_old_contact := coalesce(v_old_contact, '{}'::jsonb);
      v_new_contact := coalesce(p_contact, '{}'::jsonb);
      if (v_old_contact->'phone') is distinct from (v_new_contact->'phone') then
        if coalesce(jsonb_typeof(v_old_contact->'phone'), 'null') not in ('string', 'null')
           or coalesce(jsonb_typeof(v_new_contact->'phone'), 'null') not in ('string', 'null') then
          v_id_changed := true;
        else
          v_id_a := regexp_replace(coalesce(v_old_contact->>'phone', ''), '[^0-9]', '', 'g');
          v_id_b := regexp_replace(coalesce(v_new_contact->>'phone', ''), '[^0-9]', '', 'g');
          if length(v_id_a) = 11 and left(v_id_a, 1) = '1' then v_id_a := substr(v_id_a, 2); end if;
          if length(v_id_b) = 11 and left(v_id_b, 1) = '1' then v_id_b := substr(v_id_b, 2); end if;
          v_id_changed := v_id_a <> v_id_b;
        end if;
      end if;
      if not v_id_changed and (v_old_contact->'email') is distinct from (v_new_contact->'email') then
        if coalesce(jsonb_typeof(v_old_contact->'email'), 'null') not in ('string', 'null')
           or coalesce(jsonb_typeof(v_new_contact->'email'), 'null') not in ('string', 'null') then
          v_id_changed := true;
        else
          v_id_a := btrim(coalesce(v_old_contact->>'email', ''));
          v_id_b := btrim(coalesce(v_new_contact->>'email', ''));
          v_id_changed := v_id_a <> v_id_b
            and not (v_id_a ~ '^[ -~]*$' and v_id_b ~ '^[ -~]*$' and lower(v_id_a) = lower(v_id_b));
        end if;
      end if;
      if v_id_changed then
        raise exception 'this design is locked to its phone number and email -- ask the builder to change them';
      end if;
    end if;
  end if;

$blk$, E'\r', '');

  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_design';
  if v_n <> 1 then
    raise exception '240: expected exactly one public.save_design, found % -- resolve the overload by hand', v_n;
  end if;
  select p.oid, p.proacl::text, p.proconfig::text into v_oid, v_acl_before, v_cfg_before
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_design';

  v_def := pg_get_functiondef(v_oid);

  if position(c_marker in v_def) > 0 then
    raise notice '240: live save_design already locks a sent quote''s phone and email -- nothing to do';
    return;
  end if;

  -- 220 must be live: this block sits after the whole accepted-design lock chain, and its
  -- declare line hangs off 220's.
  if position('220: the builder''s own rules' in v_def) = 0 then
    raise exception '240: live save_design does not carry 220''s amendment gate -- live has drifted, splice by hand';
  end if;

  v_n := (length(v_def) - length(replace(v_def, c_anchor, ''))) / length(c_anchor);
  if v_n <> 1 then
    raise exception '240: expected exactly 1 "%" in the live save_design, found % -- splice by hand', btrim(c_anchor), v_n;
  end if;
  v_n := (length(v_def) - length(replace(v_def, c_gate, ''))) / length(c_gate);
  if v_n <> 1 then
    raise exception '240: expected exactly 1 "%" in the live save_design, found % -- splice by hand', c_gate, v_n;
  end if;

  v_new := replace(v_def, c_gate, c_gate || c_decl);
  v_new := replace(v_new, c_anchor, v_block || c_anchor);

  execute v_new;

  -- RE-READ LIVE. CREATE OR REPLACE keeps the oid, so this reads what now runs.
  v_def := pg_get_functiondef(v_oid);
  if position(c_marker in v_def) = 0 then
    raise exception '240: the re-issue did not take -- live save_design has no contact lock';
  end if;
  if position(c_decl in v_def) = 0 then
    raise exception '240: the block landed but its declarations did not';
  end if;
  if (select p.proacl::text from pg_proc p where p.oid = v_oid) is distinct from v_acl_before then
    raise exception '240: save_design''s grants moved (was %)', v_acl_before;
  end if;
  if (select p.proconfig::text from pg_proc p where p.oid = v_oid) is distinct from v_cfg_before then
    raise exception '240: save_design''s search_path setting moved (was %)', v_cfg_before;
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = v_oid) then
    raise exception '240: save_design is no longer SECURITY DEFINER';
  end if;
  raise notice '240: live save_design now refuses a phone/email change on a sent quote from anyone outside the tenant';
end
$splice$;

-- ── The probe: every branch that matters, as the role that takes it. Rolled back. ─────────
-- A definitional check proves the text is present; only this proves the refusal fires, for
-- the caller it is meant for, and that the saves it must not stop still go through.
do $probe$
declare
  cid  text := 'structure-studio';
  uid  uuid;
  s    public.designs;
  dr   public.designs;
  got  public.designs;
  msg  text;
  v_key text;
  v_vers_before int;
  v_vers_after  int;
  k    text;
  bad  jsonb;
begin
  select cu.user_id into uid from public.client_users cu where cu.client_id = cid limit 1;
  select * into s
    from public.designs dd
   where dd.client_id = cid and dd.status = 'sent' and dd.accepted_at is null
     and jsonb_typeof(dd.contact->'phone') = 'string'
     and length(regexp_replace(dd.contact->>'phone', '[^0-9]', '', 'g')) = 10
     and jsonb_typeof(dd.contact->'email') = 'string'
     and dd.contact->>'email' ~ '^[!-~]+@[!-~]+$'
   order by (dd.ss_quote_number is not null) desc, dd.updated_at desc
   limit 1;
  select * into dr
    from public.designs dd
   where dd.client_id = cid and dd.status = 'draft' and dd.ss_quote_number is null
   limit 1;
  if s.short_code is null or uid is null then
    raise notice '240: no sent design with a 10-digit phone and an email on %, or no member -- probe skipped', cid;
    return;
  end if;
  v_key := regexp_replace(s.contact->>'phone', '[^0-9]', '', 'g');

  begin
    -- 1-4. ANON, the identity changed four ways: each refused, by 240.
    foreach k in array array['new phone', 'new email', 'phone blanked', 'email blanked'] loop
      bad := case k
        when 'new phone'     then jsonb_set(s.contact, '{phone}', to_jsonb('(555) 555-0100'::text))
        when 'new email'     then jsonb_set(s.contact, '{email}', to_jsonb('probe-240@example.com'::text))
        when 'phone blanked' then s.contact - 'phone'
        when 'email blanked' then jsonb_set(s.contact, '{email}', to_jsonb(''::text))
      end;
      begin
        execute 'set local role anon';
        got := public.save_design(s.short_code, cid, bad, s.selections, s.paint_colors, s.items,
                                  s.custom_options, s.ro_dimensions, s.bldg_w, s.bldg_h, null, null);
        raise exception '240 probe: ANON SAVED A SENT QUOTE WITH % -- the lock did not fire', k;
      exception when others then
        msg := sqlerrm;
        if msg like '240 probe:%' then raise; end if;
        if msg not like 'this design is locked to its phone number%' then
          raise exception '240 probe: % refused, but not by 240 (%)', k, msg;
        end if;
      end;
    end loop;

    -- 5. ANON, same identity re-typed (phone "+1 …", email upper-cased) plus a new name and
    --    street: SAVES, the name and street land, and 031's version snapshot records it.
    select count(*) into v_vers_before from public.design_versions where short_code = s.short_code;
    execute 'set local role anon';
    got := public.save_design(s.short_code, cid,
             s.contact || jsonb_build_object('phone', '+1 ' || v_key,
                                             'email', upper(s.contact->>'email'),
                                             'name', '240 probe name',
                                             'street', '240 probe street'),
             s.selections, s.paint_colors, s.items, s.custom_options, s.ro_dimensions,
             s.bldg_w, s.bldg_h, null, null);
    execute 'reset role';
    if got.contact->>'name' is distinct from '240 probe name'
       or got.contact->>'street' is distinct from '240 probe street' then
      raise exception '240 probe: the anon name/address edit did not land';
    end if;
    select count(*) into v_vers_after from public.design_versions where short_code = s.short_code;
    if v_vers_after <> v_vers_before + 1 then
      raise exception '240 probe: the version snapshot did not record the allowed save (% -> %)', v_vers_before, v_vers_after;
    end if;

    -- 6. A MEMBER of the tenant, signed in: may change the phone.
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    got := public.save_design(s.short_code, cid,
             jsonb_set(s.contact, '{phone}', to_jsonb('(555) 555-0100'::text)),
             s.selections, s.paint_colors, s.items, s.custom_options, s.ro_dimensions,
             s.bldg_w, s.bldg_h, null, null);
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    if got.contact->>'phone' is distinct from '(555) 555-0100' then
      raise exception '240 probe: a signed-in member could not change the phone';
    end if;

    -- 7. ANON on a DRAFT: still free to change the phone (the visitor is still typing).
    if dr.short_code is not null then
      execute 'set local role anon';
      got := public.save_design(dr.short_code, cid,
               jsonb_set(coalesce(dr.contact, '{}'::jsonb), '{phone}', to_jsonb('(555) 555-0100'::text)),
               dr.selections, dr.paint_colors, dr.items, dr.custom_options, dr.ro_dimensions,
               dr.bldg_w, dr.bldg_h, null, 'draft');
      execute 'reset role';
      if got.contact->>'phone' is distinct from '(555) 555-0100' then
        raise exception '240 probe: an anon draft save could not change the phone';
      end if;
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '240: anon refused on new/blanked phone and email; anon re-typed identity + name/address saves with a version row; member and draft saves pass';
      else
        raise;
      end if;
  end;
end
$probe$;
