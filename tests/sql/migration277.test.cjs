// Execute migration 277 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// area_level_for as it is live (254's definition), then check what it promises:
//   * owners and admins resolve 'edit' on price_override; every other title, a NULL title and an
//     unknown title resolve 'none'; a stored grant gives it to one person, a stored 'none' takes it
//     from an admin, never from an owner, and a 'view' is discarded;
//   * NOTHING ELSE MOVED: for every title x every area x a set of stored maps, 277's answer is
//     254's answer, except on price_override itself;
//   * the SQL agrees with the REAL _shared/access.ts effectiveAccess on every one of those cells,
//     price_override included (the same check access.test.ts makes on the literals, made here on
//     behaviour);
//   * PART 0's blast-radius preview reads 'none' everywhere before and owners/admins only after;
//   * the grant posture holds (anon cannot execute it, authenticated and service_role can);
//   * a re-apply changes nothing, a CRLF checkout of the file applies the same, and a copy whose
//     admin cell or k_areas row went missing is REFUSED with the whole file rolled back;
//   * PART 3, spliced into save_design as it is live (pg_get_functiondef, 2026-10-05, below): a
//     line's own price (selections.priceOverrides) is stored only for a member holding the area or
//     an operator who may write; anon, a member without it, an admin whose switch is off and a
//     read-only operator keep exactly what the row has, whatever they send; with the key on neither
//     side every save is byte-for-byte what it was; the splice is idempotent, keeps the grants, and
//     its c_reverse switch gives back the live text exactly; a live body without 241 is refused, and
//     a guard that lets anon through is caught by PART 4's probe, taking the whole file with it.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants and people are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration277.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/277_price_override_area.sql"), "utf8");

// area_level_for exactly as 254 defines it — the live definition (its body was compared with
// pg_get_functiondef on 2026-10-05 and is identical apart from line endings) — with 254's grants.
function liveAreaLevelFor() {
  const s = MIG("254_sss_phone.sql").replace(/\r\n/g, "\n");
  const a = s.indexOf("create or replace function public.area_level_for(");
  const b = s.indexOf("$fn$;", a) + 5;
  if (a < 0 || b < 5) throw new Error("254's area_level_for anchor moved");
  return s.slice(a, b) + "\n"
    + "revoke execute on function public.area_level_for(text, text, jsonb, text) from public, anon;\n"
    + "grant  execute on function public.area_level_for(text, text, jsonb, text) to authenticated, service_role;\n";
}

// save_design EXACTLY as it is live: pg_get_functiondef on 2026-10-05 (241's splice of 240 of …),
// copied byte for byte, because PART 3 splices whatever is live and must be tried on that text.
// Re-read it before trusting this: select pg_get_functiondef('public.save_design'::regproc);
const LIVE_SAVE_DESIGN = String.raw`CREATE OR REPLACE FUNCTION public.save_design(p_code text, p_client_id text, p_contact jsonb, p_selections jsonb, p_paint_colors jsonb, p_items jsonb, p_custom_options jsonb, p_ro_dimensions jsonb, p_bldg_w integer, p_bldg_h integer, p_image_url text, p_status text DEFAULT NULL::text)
 RETURNS designs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing_client text;
  v_existing_status text;
  v_row public.designs;
  v_needle text;
  v_at int;
  v_contact_id uuid;
  v_gate jsonb;
  v_old_contact jsonb;
  v_new_contact jsonb;
  v_old_qn text;
  v_old_ghl_estimate_id text;
  v_old_accepted_at timestamptz;
  v_id_a text;
  v_id_b text;
  v_id_changed boolean := false;
begin
  if p_code is null or p_code !~ '^SS-[A-HJ-NP-Z2-9]{6,12}$' then
    raise exception 'invalid design code';
  end if;
  if p_status is not null and p_status != 'draft' then
    raise exception 'invalid status';
  end if;
  if not exists (select 1 from public.client_configs where client_id = p_client_id) then
    raise exception 'unknown client';
  end if;
  select client_id, status into v_existing_client, v_existing_status
    from public.designs where short_code = p_code;
  if v_existing_client is not null and v_existing_client != p_client_id then
    raise exception 'design belongs to a different client';
  end if;
  if v_existing_status = 'inventory' then
    raise exception 'design belongs to an inventory building';
  end if;
  -- An INVOICED or DELIVERED design is a billing document's source of truth: the invoice
  -- (and any QuickBooks rows) were issued from this content, so the anonymous internet
  -- must not be able to rewrite it under the same short code while the paperwork stands.
  -- 104 closed the same hole for inventory masters and stopped there (audit 2026-08-20).
  -- TENANT STAFF still may edit: the portal designer saves through this same RPC as an
  -- authenticated user, and revising an invoiced estimate is a real back-office flow -- so
  -- the refusal is scoped to callers who are neither a member of this tenant nor an
  -- operator. auth.uid() is null for anon; membership is the client_users mapping, and
  -- operators are app_operators (both PK'd on user_id).
  if v_existing_status in ('accepted', 'invoiced', 'delivered') or exists (select 1 from public.designs d2 where d2.short_code = p_code and d2.accepted_at is not null) then
    if auth.uid() is null or not (
      exists (select 1 from public.client_users cu
               where cu.user_id = auth.uid() and cu.client_id = p_client_id)
      or exists (select 1 from public.app_operators op where op.user_id = auth.uid())
    ) then
      raise exception 'this design is locked -- ask the builder to change it';
    end if;
    -- 220: the builder's own rules. A member may edit an agreed design, but only
    -- while the ORDER is open for change -- inside the free window, under an unlock
    -- somebody granted, or with a change already underway. The same function
    -- submit-estimate, stage_order_attribute_change and the change_orders guard all
    -- ask, so a refusal here and a refusal there can never disagree. Without this the
    -- designer's save landed the rep's edit on a signed design and submit-estimate
    -- then refused it, leaving a revision no change order records.
    -- FAILS OPEN: a gate that cannot answer must not stop a builder saving their work.
    v_gate := public.order_amendment_gate(p_client_id, p_code);
    if not coalesce((v_gate->>'open')::boolean, true) then
      raise exception '%', coalesce(nullif(btrim(v_gate->>'reason'), ''),
        'this order is signed -- an admin or crew leader has to unlock it before it can be changed');
    end if;
  end if;

  -- 240: whose quote it is. Past draft, the contact phone and email are the identity
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
    select d4.contact, d4.ss_quote_number, d4.ghl_estimate_id, d4.accepted_at
      into v_old_contact, v_old_qn, v_old_ghl_estimate_id, v_old_accepted_at
      from public.designs d4 where d4.short_code = p_code;
    -- 241: the proof of issue holds it too, not status alone. submit-estimate marks a design
    -- sent in ONE guarded write beside its estimate id or quote number; if that write fails
    -- after the paperwork went out the row still reads draft, and in CRM mode (never a quote
    -- number) this lock would open for it. Step 11 still stores ghl_estimate_id; that holds it.
    if (coalesce(v_existing_status, '') <> 'draft' or v_old_qn is not null
        or v_old_ghl_estimate_id is not null or v_old_accepted_at is not null)
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

  if p_image_url is not null then
    v_needle := '/storage/v1/object/public/floor-plans/' || p_client_id || '/' || p_code;
    v_at := position(v_needle in p_image_url);
    if p_image_url !~ '^https://'
       or v_at = 0
       or substring(p_image_url from v_at + length(v_needle)) !~ '^(-[0-9]+)?[.](pdf|png)$'
    then
      p_image_url := null;
    end if;
  end if;

  insert into public.designs as d
    (short_code, client_id, contact, selections, paint_colors, items,
     custom_options, ro_dimensions, bldg_w, bldg_h, image_url, status,
     created_by_user_id, updated_by_user_id)
  values
    (p_code, p_client_id,
     coalesce(p_contact, '{}'::jsonb),
     coalesce(p_selections, '{}'::jsonb),
     coalesce(p_paint_colors, '{}'::jsonb),
     coalesce(p_items, '[]'::jsonb),
     coalesce(p_custom_options, '[]'::jsonb),
     coalesce(p_ro_dimensions, '{}'::jsonb),
     p_bldg_w, p_bldg_h, p_image_url,
     -- 241: born a draft. A save is not a quote: submit-estimate (service role) marks it sent
     -- once the estimate or quote number exists. Promoting here left refused quotes 'sent'.
     coalesce(p_status, 'draft'),
     -- NULL on the public designer, and that is the honest answer: the CUSTOMER built it.
     auth.uid(), auth.uid())
  on conflict (short_code) do update set
    contact        = excluded.contact,
    selections     = excluded.selections,
    paint_colors   = excluded.paint_colors,
    items          = excluded.items,
    custom_options = excluded.custom_options,
    ro_dimensions  = excluded.ro_dimensions,
    bldg_w         = excluded.bldg_w,
    bldg_h         = excluded.bldg_h,
    image_url      = coalesce(excluded.image_url, d.image_url),
    -- 241: a save never moves status, for any caller. draft -> sent belongs to submit-estimate
    -- at the moment of issue, and p_status (null or 'draft') can never demote.
    status         = d.status,
    -- COALESCE, not assignment. A customer re-opening their own quote link saves through this
    -- same RPC with auth.uid() null; overwriting would erase the rep who last worked on it and
    -- leave the future "updated by" filter reporting nobody on the busiest designs.
    -- created_by is never touched on update: it is a fact about the first save.
    updated_by_user_id = coalesce(auth.uid(), d.updated_by_user_id),
    updated_at     = now()
  returning * into v_row;

  insert into public.design_versions
    (short_code, client_id, version, contact, selections, paint_colors, items,
     custom_options, ro_dimensions, bldg_w, bldg_h, image_url)
  values
    (v_row.short_code, v_row.client_id,
     coalesce((select max(version) from public.design_versions where short_code = p_code), 0) + 1,
     v_row.contact, v_row.selections, v_row.paint_colors, v_row.items,
     v_row.custom_options, v_row.ro_dimensions, v_row.bldg_w, v_row.bldg_h, v_row.image_url);

  -- CRM CONTACT LINK (migration 130). Resolve this submission to a crm_contacts row and
  -- stamp it, so notes, activities and the record page have a stable person to hang off.
  --
  -- WRAPPED AND SWALLOWED ON PURPOSE. This is bookkeeping; the design above is the
  -- customer's actual work. A resolver failure -- a table dropped, a permission changed, a
  -- constraint nobody anticipated -- must NEVER surface as "your design would not save".
  -- The backfill in 130 is re-runnable and will pick up anything missed here. Same
  -- contract as qboInvoice/emailSend: the money and the paperwork never block the save.
  --
  -- Only stamps when contact_id is still null, so re-saving a design never re-homes it to a
  -- different contact after a human has merged or corrected one.
  begin
    v_contact_id := public.crm_ensure_contact(
      p_client_id, p_contact->>'name', p_contact->>'phone', p_contact->>'email');
    if v_contact_id is not null and v_row.contact_id is null then
      update public.designs set contact_id = v_contact_id where short_code = p_code;
      v_row.contact_id := v_contact_id;
    end if;
  exception when others then
    null;
  end;

  -- CONTACT ASSIGNMENT + AUTO-FOLLOW (migration 189). Carolyn 2026-09-04 @1:09:30: "we do
  -- not ever assign deals. We only assign contacts and followers." The rep who sends the
  -- quote follows the customer, and becomes the assignee under the tenant's
  -- crm_assign_latest_quote rule.
  --
  -- SEPARATE FROM THE BLOCK ABOVE ON PURPOSE. That one swallows, which is right for
  -- something a re-runnable backfill repairs. Nothing can reconstruct who was signed in, so
  -- this one records the failure instead of hiding it.
  begin
    perform public.crm_quote_assign(p_client_id, v_row.contact_id, auth.uid());
  exception when others then
    begin
      perform public.log_error(
        'save_design',
        'crm_quote_assign failed: ' || coalesce(sqlerrm, '(no message)'),
        'crm_quote_assign',
        p_client_id,
        null,
        jsonb_build_object('code', p_code, 'sqlstate', sqlstate),
        'error');
    exception when others then
      null;                      -- a logger that throws must never fail the design save
    end;
  end;

  return v_row;
end
$function$
;
`;

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- The live default ACLs: every new function is executable by the browser roles until revoked.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table public.client_users (
  user_id uuid not null, client_id text not null, role text not null default 'user',
  title text, access jsonb not null default '{}'::jsonb, primary key (user_id, client_id)
);
insert into public.client_users (user_id, client_id, role, title, access) values
  ('00000000-0000-4000-8000-000000000001', 'acme-sheds',   'owner', null,         '{}'),
  ('00000000-0000-4000-8000-000000000002', 'acme-sheds',   'owner', 'owner',      '{"price_override":"none"}'),
  ('00000000-0000-4000-8000-000000000003', 'acme-sheds',   'admin', 'admin',      '{}'),
  ('00000000-0000-4000-8000-000000000004', 'acme-sheds',   'user',  'sales_rep',  '{}'),
  ('00000000-0000-4000-8000-000000000005', 'acme-sheds',   'user',  null,         '{}'),
  ('00000000-0000-4000-8000-000000000006', 'barn-co-test', 'user',  'office_staff', '{"designer":"edit"}'),
  ('00000000-0000-4000-8000-000000000007', 'barn-co-test', 'user',  'driver',     '{}'),
  ('00000000-0000-4000-8000-000000000008', 'acme-sheds',   'user',  'sales_rep',  '{"price_override":"edit"}'),
  ('00000000-0000-4000-8000-000000000009', 'acme-sheds',   'admin', 'admin',      '{"price_override":"none"}');

-- What the live save_design reads or calls, cut to the columns it touches. The three functions it
-- calls after the write are bookkeeping it already guards; here they do nothing.
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.uid() returns uuid language sql stable as $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;
create table public.client_configs (client_id text primary key);
insert into public.client_configs values ('acme-sheds'), ('barn-co-test');
create table public.app_operators (user_id uuid primary key, can_write boolean not null default false);
insert into public.app_operators values
  ('00000000-0000-4000-8000-0000000000a1', true),
  ('00000000-0000-4000-8000-0000000000a2', false);
create table public.designs (
  short_code text primary key, client_id text not null, contact jsonb, selections jsonb, paint_colors jsonb,
  items jsonb, custom_options jsonb, ro_dimensions jsonb, bldg_w int, bldg_h int, image_url text, status text,
  created_by_user_id uuid, updated_by_user_id uuid, updated_at timestamptz default now(),
  accepted_at timestamptz, ss_quote_number text, ghl_estimate_id text, contact_id uuid
);
create table public.design_versions (
  short_code text, client_id text, version int, contact jsonb, selections jsonb, paint_colors jsonb,
  items jsonb, custom_options jsonb, ro_dimensions jsonb, bldg_w int, bldg_h int, image_url text
);
create function public.order_amendment_gate(p_client_id text, p_code text) returns jsonb
  language sql as $f$ select '{"open": true}'::jsonb $f$;
create function public.crm_ensure_contact(p_client_id text, p_name text, p_phone text, p_email text) returns uuid
  language sql as $f$ select null::uuid $f$;
create function public.crm_quote_assign(p_client_id text, p_contact_id uuid, p_user_id uuid) returns void
  language sql as $f$ select $f$;
`;

const TITLES = ["owner", "admin", "office_staff", "sales_manager", "sales_rep", "dealer", "scheduler",
  "crew_leader", "crew_member", "driver", "nonsense", null];
const ROLES_FOR = (t) => (t === "owner" ? ["owner", "user"] : t === "admin" ? ["admin", "user"] : ["user", "owner"]);
const MAPS = [
  null,
  {},
  { price_override: "edit" },
  { price_override: "none" },
  { price_override: "view" },
  { designer: "none", phone: "view", contacts: "own", settings_billing: "edit" },
  { change_order_approve: "edit", change_orders: "edit", orders: "view", price_override: "edit" },
  { settings_team: "none", projects: "edit", commissions: "own" },
];

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];

async function fresh(saveDesign = LIVE_SAVE_DESIGN) {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(liveAreaLevelFor());
  await db.exec(saveDesign);
  return db;
}
const level = async (db, role, title, access, area) =>
  (await one(db, "select public.area_level_for($1, $2, $3::jsonb, $4) as l",
    [role, title, access == null ? null : JSON.stringify(access), area])).l;
const fnDef = async (db) => (await one(db, "select md5(pg_get_functiondef('public.area_level_for(text,text,jsonb,text)'::regprocedure)) as h")).h;
const sdDef = async (db) => (await one(db, "select pg_get_functiondef('public.save_design'::regproc) as d")).d;
const sdMeta = async (db) => (await one(db, "select proacl::text as a, proconfig::text as c, prosecdef as s from pg_proc where oid = 'public.save_design'::regproc"));

// One save_design call as a given caller: 'anon', or a user id signed in as authenticated. Returns
// the stored selections. Selections go in as JSON text (null = SQL null).
const uidOf = (n) => `00000000-0000-4000-8000-0000000000${n}`;
async function save(db, who, code, selections, client = "acme-sheds") {
  const claims = who === "anon" ? "" : JSON.stringify({ sub: who, role: "authenticated" });
  await db.query("select set_config('request.jwt.claims', $1, false)", [claims]);
  await db.exec(`set role ${who === "anon" ? "anon" : "authenticated"}`);
  try {
    const r = await db.query(
      "select (public.save_design($1, $2, '{}'::jsonb, $3::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 10, 12, null, null)).selections as s",
      [code, client, selections == null ? null : JSON.stringify(selections)]);
    return r.rows[0].s;
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}
const versionsWith = async (db, code) => Number((await one(db,
  "select count(*) as n from public.design_versions where short_code = $1 and selections ? 'priceOverrides'", [code])).n);
const src0 = () => MIG_TEXT().replace(/\r\n/g, "\n");
const spliceBlock = (text) => {
  const s = text.replace(/\r\n/g, "\n");
  const a = s.indexOf("do $splice$"), b = s.indexOf("$splice$;", a + 12);
  if (a < 0 || b < 0) throw new Error("PART 3's splice block moved");
  return s.slice(a, b + 9);
};

// Every area either side knows, plus one nobody does.
function areaKeysOf(sql) {
  const at = /k_areas\s+constant\s+jsonb\s*:=/.exec(sql);
  const open = sql.indexOf("$j$", at.index), close = sql.indexOf("$j$", open + 3);
  return Object.keys(JSON.parse(sql.slice(open + 3, close)));
}

(async () => {
  // The real permission model, imported as TypeScript (Node strips the types).
  const access = await import(pathToFileURL(path.join(WT, "supabase/functions/_shared/access.ts")).href);
  const AREAS = [...new Set([...areaKeysOf(MIG("254_sss_phone.sql")), ...areaKeysOf(MIG_TEXT()), ...access.AREA_KEYS, "no_such_area"])];

  console.log("migration 277: the blast radius before, the apply, the blast radius after");
  const db = await fresh();
  const preview = async () => (await db.query(
    "select cu.user_id::text as u, public.area_level_for(cu.role, cu.title, cu.access, 'price_override') as p from public.client_users cu order by 1")).rows;
  const before = await preview();
  ok(before.every((r) => r.p === "none"), "PART 0 before: every row 'none' (the area does not exist yet)", JSON.stringify(before));

  // Every cell 254 answers, recorded before the apply.
  const cells = [];
  for (const t of TITLES) for (const role of ROLES_FOR(t)) for (const m of MAPS) for (const a of AREAS) {
    cells.push({ role, t, m, a, was: await level(db, role, t, m, a) });
  }

  await db.exec(MIG_TEXT());
  const after = await preview();
  const want = { 1: "edit", 2: "edit", 3: "edit", 4: "none", 5: "none", 6: "none", 7: "none", 8: "edit", 9: "none" };
  ok(after.every((r) => r.p === want[Number(r.u.slice(-1))]),
    "PART 0 after: the owners, the admin and the granted rep 'edit' (a stored none cannot reduce an owner; it does an admin), everyone else 'none'", JSON.stringify(after));

  console.log("migration 277: who holds Override prices");
  ok(await level(db, "owner", "owner", null, "price_override") === "edit", "an owner");
  ok(await level(db, "owner", null, null, "price_override") === "edit", "an owner with no title (most live owners)");
  ok(await level(db, "admin", "admin", null, "price_override") === "edit", "an admin, by preset");
  ok(await level(db, "user", "admin", null, "price_override") === "edit", "the admin TITLE carries it whatever the coarse role says");
  for (const t of ["office_staff", "sales_manager", "sales_rep", "dealer", "scheduler", "crew_leader", "crew_member", "driver", "nonsense", null]) {
    ok(await level(db, "user", t, null, "price_override") === "none", `${t === null ? "a NULL title" : t}: denied by default`);
  }
  ok(await level(db, "user", "sales_rep", { price_override: "edit" }, "price_override") === "edit", "a Team grant gives it to one rep");
  ok(await level(db, "admin", "admin", { price_override: "none" }, "price_override") === "none", "an owner can take it from an admin");
  ok(await level(db, "owner", "owner", { price_override: "none" }, "price_override") === "edit", "...never from an owner");
  ok(await level(db, "user", "sales_rep", { price_override: "view" }, "price_override") === "none", "'view' is not one of its two levels and is discarded");

  console.log("migration 277: nothing else moved, and the SQL agrees with access.ts on every cell");
  let moved = 0, drift = 0, checked = 0;
  const firstMoved = [], firstDrift = [];
  for (const c of cells) {
    const now = await level(db, c.role, c.t, c.m, c.a);
    checked++;
    if (c.a !== "price_override" && now !== c.was) { moved++; if (firstMoved.length < 5) firstMoved.push({ ...c, now }); }
    if (c.a !== "no_such_area") {
      const ts = access.effectiveAccess(c.role, c.t, c.m)[c.a] ?? "none";
      if (ts !== now) { drift++; if (firstDrift.length < 5) firstDrift.push({ ...c, now, ts }); }
    }
  }
  ok(moved === 0, `no area other than price_override changed answer (${checked} cells)`, JSON.stringify(firstMoved));
  ok(drift === 0, `area_level_for == effectiveAccess on every cell, price_override included (${checked} cells)`, JSON.stringify(firstDrift));
  ok(cells.some((c) => c.a === "price_override" && c.was === "none"), "(the price_override cells really were 'none' before)");

  console.log("migration 277: grants, re-apply, CRLF");
  ok(!(await one(db, "select has_function_privilege('anon', 'public.area_level_for(text,text,jsonb,text)', 'EXECUTE') as x")).x, "anon cannot execute area_level_for");
  ok((await one(db, "select has_function_privilege('authenticated', 'public.area_level_for(text,text,jsonb,text)', 'EXECUTE') as x")).x, "authenticated can (the RLS policies call it as the signed-in user)");
  ok((await one(db, "select has_function_privilege('service_role', 'public.area_level_for(text,text,jsonb,text)', 'EXECUTE') as x")).x, "service_role can");
  const h1 = await fnDef(db);
  const s1 = await sdDef(db);
  await db.exec(MIG_TEXT());
  ok(await fnDef(db) === h1, "a re-apply leaves the function byte-identical");
  ok(await sdDef(db) === s1, "...and save_design too (PART 3 sees its marker and does nothing)");
  await db.close();

  const crlf = await fresh();
  await crlf.exec(MIG_TEXT().replace(/\r?\n/g, "\r\n"));
  const crlfDef = await sdDef(crlf);
  ok(await level(crlf, "admin", "admin", null, "price_override") === "edit"
    && await level(crlf, "user", "sales_rep", null, "price_override") === "none"
    && crlfDef.includes("277: a line's own price") && !crlfDef.includes("\r"),
    "a CRLF checkout of the file applies the same, and puts no carriage return into save_design");
  await crlf.close();

  console.log("migration 277 PART 3: save_design keeps a line's own price away from anyone without the area");
  {
    const P = { building: { amount: "8500", was: 9000 }, "ro:104": { amount: "275", was: 150 } };
    const BAD = { building: { amount: "1", was: 9000 } };
    // jsonb keeps its own key order, so objects are compared with their keys sorted.
    const canon = (v) => (v && typeof v === "object"
      ? (Array.isArray(v) ? v.map(canon) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])))
      : v);
    const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
    const OWNER = uidOf("01"), ADMIN = uidOf("03"), REP = uidOf("04"), NO_TITLE = uidOf("05"), OTHER_TENANT = uidOf("06");
    const GRANTED = uidOf("08"), ADMIN_OFF = uidOf("09"), OP_WRITE = uidOf("a1"), OP_READ = uidOf("a2");

    // Saves that never carry the key, on a design that never has it: what every save is today.
    const plainSeq = async (d) => {
      const out = [];
      out.push(await save(d, "anon", "SS-PLAANNAAA", { style: "a", roofType: "Metal" }));
      out.push(await save(d, REP, "SS-PLAANNAAA", { style: "b", discounts: [{ amount: "5" }] }));
      out.push(await save(d, OWNER, "SS-PLAANNAAA", { style: "c" }));
      out.push(await save(d, "anon", "SS-PLAANNAAA", null));
      out.push(await save(d, "anon", "SS-PLAANNAAB", ["not", "an", "object"]));
      const v = (await d.query("select short_code, version, selections from public.design_versions where short_code like 'SS-PLAANNAA%' order by 1, 2")).rows;
      return JSON.stringify({ out, v });
    };

    const A = await fresh();
    const def0 = await sdDef(A);
    const meta0 = await sdMeta(A);
    const planted = await save(A, "anon", "SS-PRCHLEAAA", { style: "x", priceOverrides: BAD });
    ok(same(planted.priceOverrides, BAD), "(before 277: an anonymous save stores a price — the hole PART 3 closes)");
    const today = await plainSeq(A);

    const B = await fresh();
    await B.exec(MIG_TEXT());
    ok(await plainSeq(B) === today,
      "with the key on neither side every save stores exactly what it did before 277 (rows and versions; anon, rep, owner, a null and a non-object alike)");
    const def1 = await sdDef(B);
    ok(def1.includes("277: a line's own price") && def1.includes("241: born a draft."), "the live text carries the guard, beside 241's");
    ok(JSON.stringify(await sdMeta(B)) === JSON.stringify(meta0), "grants, search_path and SECURITY DEFINER did not move", JSON.stringify(meta0));

    // A brand-new design: nobody without the area can plant a price; the rest of the save lands.
    let s = await save(B, "anon", "SS-PRCNEWAAA", { style: "x", priceOverrides: BAD });
    ok(s.style === "x" && !("priceOverrides" in s), "anon cannot plant a price on a new design (the rest of the save lands)", JSON.stringify(s));
    ok(await versionsWith(B, "SS-PRCNEWAAA") === 0, "...and its version row carries none either");
    for (const [who, label] of [[REP, "a sales rep"], [NO_TITLE, "a member with no title"], [ADMIN_OFF, "an admin whose switch an owner turned off"],
      [OP_READ, "a read-only operator"], [OTHER_TENANT, "a member of ANOTHER tenant"]]) {
      s = await save(B, who, "SS-PRCNEWAAB", { style: "y", priceOverrides: BAD });
      ok(s.style === "y" && !("priceOverrides" in s), `${label} cannot plant a price`, JSON.stringify(s));
    }

    // Everyone who holds it stores one.
    const held = [[OWNER, "an owner", "SS-PRCSETAAB"], [ADMIN, "an admin (preset)", "SS-PRCSETAAC"],
      [GRANTED, "a rep granted Override prices", "SS-PRCSETAAD"], [OP_WRITE, "an operator who may write", "SS-PRCSETAAE"]];
    for (const [who, label, code] of held) {
      s = await save(B, who, code, { style: "z", priceOverrides: P });
      ok(same(s.priceOverrides, P), `${label} stores a price`, JSON.stringify(s));
    }

    // On a design a holder priced, nobody else moves the prices; everything else they save lands.
    const code = "SS-PRCSETAAB";
    for (const [who, label] of [["anon", "anon (the share link)"], [REP, "a sales rep"], [ADMIN_OFF, "an admin whose switch is off"], [OP_READ, "a read-only operator"]]) {
      s = await save(B, who, code, { style: "w", priceOverrides: BAD });
      ok(same(s.priceOverrides, P) && s.style === "w", `${label}: its own price is ignored and the stored one kept`, JSON.stringify(s));
      s = await save(B, who, code, { style: "v" });
      ok(same(s.priceOverrides, P) && s.style === "v", `${label}: a save with no prices keeps the stored ones (it cannot clear them)`, JSON.stringify(s));
    }
    s = await save(B, "anon", code, null);
    ok(same(s, { priceOverrides: P }), "a null selections from anon keeps the stored prices (and, as before, nothing else)", JSON.stringify(s));
    s = await save(B, "anon", code, ["x"]);
    ok(same(s, { priceOverrides: P }), "a non-object selections from anon keeps them too", JSON.stringify(s));
    ok(await versionsWith(B, code) > 0
      && Number((await one(B, "select count(*) as n from public.design_versions where short_code = $1 and selections->'priceOverrides' @> '{\"building\":{\"amount\":\"1\"}}'", [code])).n) === 0,
      "no version of that design ever held anon's $1");

    // ...and every holder may change and clear them.
    const P2 = { building: { amount: "8000", was: 9000 } };
    for (const [who, label] of [[GRANTED, "the granted rep"], [OP_WRITE, "the writing operator"], [OWNER, "the owner"]]) {
      s = await save(B, who, code, { style: "u", priceOverrides: P2 });
      ok(same(s.priceOverrides, P2), `${label} changes them`);
      s = await save(B, who, code, { style: "u" });
      ok(!("priceOverrides" in s), `${label} clears them`);
      s = await save(B, who, code, { style: "u", priceOverrides: P });
    }

    // ROLLBACK: the splice block with its switch flipped gives back the live text exactly.
    const back = spliceBlock(MIG_TEXT()).replace("c_reverse    constant boolean := false;", "c_reverse    constant boolean := true;");
    ok(back !== spliceBlock(MIG_TEXT()), "(the rollback switch found)");
    await B.exec(back);
    ok(await sdDef(B) === def0, "c_reverse = true restores save_design byte for byte");
    ok(JSON.stringify(await sdMeta(B)) === JSON.stringify(meta0), "...with its grants and settings as they were");
    s = await save(B, "anon", "SS-PRCBACKAA", { priceOverrides: BAD });
    ok(same(s.priceOverrides, BAD), "...and behaves as it did (the guard is really gone)");
    await B.exec(back);
    ok(await sdDef(B) === def0, "a second rollback run finds nothing to undo");
    await A.close();
    await B.close();
  }

  console.log("migration 277: a broken copy is refused and the whole file is taken back");
  const refused = async (text, re, label) => {
    const d = await fresh();
    const h0 = await fnDef(d);
    let err = null;
    // The file opens its own transaction, so a RAISE leaves the session aborted inside it; end it
    // the way the connection would, then read what is left.
    try { await d.exec(text); } catch (e) { err = e; await d.exec("rollback"); }
    const h = await fnDef(d);
    ok(!!err && re.test(String(err.message)) && h === h0, label, err ? err.message : "applied without error");
    await d.close();
  };
  const src = src0();
  const noAdmin = src.replace(/("admin": \{\n[^\n]*\n)      "price_override":"edit",\n/, "$1");
  ok(noAdmin !== src, "(mutant built: the admin cell removed)");
  await refused(noAdmin, /277: an admin does not hold Override prices by preset/, "without the admin cell: refused, area_level_for left exactly as 254 had it");
  const noArea = src.replace('    "price_override":        {"levels": ["none","edit"]},\n', "");
  ok(noArea !== src, "(mutant built: the k_areas row removed)");
  await refused(noArea, /277: an OWNER cannot override prices|277: an admin does not hold/, "without the k_areas row: refused, nothing left behind");
  const repGets = src.replace('    "sales_rep": {\n', '    "sales_rep": {\n      "price_override":"edit",\n');
  ok(repGets !== src, "(mutant built: sales_rep handed the area)");
  await refused(repGets, /277: sales_rep holds Override prices by preset/, "a preset that hands every rep the power: refused");
  const lostPhone = src.replace('"reports":"edit","phone":"edit","settings_structures"', '"reports":"edit","settings_structures"');
  ok(lostPhone !== src, "(mutant built: the admin phone cell lost)");
  await refused(lostPhone, /277: admin phone/, "a cell 254 added, lost in the copy: refused");

  console.log("migration 277: PART 3 and PART 4 refuse what they must, and take the whole file with them");
  {
    // A live save_design that does not carry 241 (drifted): refused before anything is re-issued.
    const no241 = LIVE_SAVE_DESIGN.replace("-- 241: born a draft.", "-- (drifted)");
    ok(no241 !== LIVE_SAVE_DESIGN, "(mutant built: live save_design without 241)");
    const d = await fresh(no241);
    const h0 = await fnDef(d), s0 = await sdDef(d);
    let err = null;
    try { await d.exec(MIG_TEXT()); } catch (e) { err = e; await d.exec("rollback"); }
    ok(!!err && /277: live save_design does not carry 241/.test(String(err.message)) && await fnDef(d) === h0 && await sdDef(d) === s0,
      "a live save_design without 241: refused, area_level_for and save_design both left as they were", err ? err.message : "applied");
    await d.close();

    // A guard that lets anon through: PART 4's probe catches it, and nothing of 277 is left behind.
    const leaky = src0().replace("    if auth.uid() is null or not (\n", "    if auth.uid() is not null and not (\n");
    ok(leaky !== src0(), "(mutant built: the guard skips anon)");
    const d2 = await fresh();
    const h2 = await fnDef(d2), s2 = await sdDef(d2);
    err = null;
    try { await d2.exec(leaky); } catch (e) { err = e; await d2.exec("rollback"); }
    ok(!!err && /277 probe: AN ANONYMOUS SAVE STORED A PRICE/.test(String(err.message)) && await fnDef(d2) === h2 && await sdDef(d2) === s2,
      "a guard that lets anon store a price: the probe refuses it, and the whole file is rolled back", err ? err.message : "applied");
    await d2.close();

    // Two save_design overloads: refused, by hand.
    const d3 = await fresh();
    await d3.exec("create function public.save_design(p_code text) returns void language sql as $f$ select $f$;");
    err = null;
    try { await d3.exec(MIG_TEXT()); } catch (e) { err = e; await d3.exec("rollback"); }
    ok(!!err && /277: expected exactly one public.save_design, found 2/.test(String(err.message)), "two save_design overloads: refused", err ? err.message : "applied");
    await d3.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  // exitCode, not process.exit(): see migration270.test.cjs (a libuv assertion on Windows after a
  // .ts import). Every PGlite here is closed, so the event loop drains on its own.
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
