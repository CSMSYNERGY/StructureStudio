-- 281_billing_webhook_redact.sql — take the payer's card and contact details out of the stored
-- copies of the payment gateway's subscription notices (billing_webhook_events.payload).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, AND ONLY AFTER billing-webhook IS DEPLOYED WITH
--    redactWebhookPayload (see ORDER). Pipe this file to `supabase db query --linked` (stdin; see
--    270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('281', '281_billing_webhook_redact') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check takes the
--    whole scrub with it. `db query` prints no NOTICE, only the last statement's rows: THE RECORD at
--    the end is what the apply shows. No row printed means the file did not run. To see the same
--    row and change nothing, pipe it with the last `commit;` swapped for `rollback;` (a dry run).
--
-- ⚠️ THIS DESTROYS DATA ON PURPOSE, AND THERE IS NO ROLLBACK. That is the point of it: the removed
--    values must not survive anywhere we control. Nothing reads them (see WHAT DOES NOT CHANGE).
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- The 2026-07-31 review (a security card on the Tasks board): the published Terms say card details
-- are collected by the payment gateway and not stored on our systems, and the Privacy policy says we
-- store only the gateway's token plus non-sensitive details such as the card brand and last four.
-- billing-webhook stored every Deposyt/NMI event body verbatim, and NMI's event_body carries:
--   card             the number masked to first six + last four, expiry, BIN, card type, issue
--                    number/start date, and the AVS / security-code RESULT codes
--   billing_address  first and last name, company, street address, email, phone, cell, fax
--   merchant         the gateway merchant account's id and name
--   shipping         (a charge amount string in today's shape; an address block in NMI's docs)
-- All 40 rows (2026-07-28 → 2026-10-05) held card and billing_address, and about half belonged to
-- OTHER products' customers on the shared gateway, acked as foreign but kept. Never a full card
-- number and never a security code (no PCI DSS breach: first-six/last-four is the truncation PCI
-- permits), but more than the policy says, for people who are not ours.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   lock the table against the webhook's inserts for the few ms this takes
--   PART 2   remove card, billing_address, shipping and merchant from each of the three container
--            shapes the webhook accepts (event_body; data.subscription; subscription), wherever
--            that container is a JSON object (pg_temp.m281_scrub, below)
--   PART 3   checks: no row's payload still names a card or contact key, or holds a masked-card or
--            email-shaped value (pg_temp.m281_carries, below), and no other column of any row moved
--   RECORD   one row the CLI prints
--
-- ── WHAT DOES NOT CHANGE ─────────────────────────────────────────────────────────────────
--   * Nothing reads payload back. billing-webhook reads only id + status here (idempotency) and
--     processes the parsed body in memory; no other function, view, policy or job names the table
--     (grep, 2026-10-05). It is service-role only (050: RLS on, no policy, nothing for the browser).
--   * id, event_type, status, error, created_at and processed_at are untouched; PART 3 proves it.
--   * What stays in each scrubbed row: subscription_id, order_id, order_description, plan,
--     next_charge_date, the payment counts, processor_id, subscription_type, ponumber, tax,
--     features, website. Checked live 2026-10-05: none holds an '@' or a masked card number.
--     Rows written by the redacting billing-webhook keep a stricter whitelist (no tax, features or
--     website); the difference is harmless, and those rows have none of the removed keys, so this
--     file leaves them byte-for-byte.
--   * No schema change, no table, no function left behind (the two pg_temp functions are dropped
--     at the end, and the temp table goes with the commit).
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- billing-webhook FIRST (deployed with --workdir from the tree carrying this file; grep the live
-- copy for redactWebhookPayload), THEN this file. The other way round, an event landing in between
-- is stored raw again. That is recoverable — the file is idempotent, so re-applying it scrubs the
-- straggler — and PART 1's lock means no row can land between PART 2 and PART 3 of one apply.
-- Read back after, read-only (the same three patterns as pg_temp.m281_carries; expect 0 of all):
--   select count(*) filter (where payload::text ~ '"(card|cc_[a-z0-9_]+|cvv2?|billing_address|shipping_address|first_name|last_name|email|phone|cell_phone)"' or payload::text ~ '[0-9]{6}\*+[0-9]{4}' or payload::text ~ '[^ "]+@[^ "]+\.[a-zA-Z]{2,}') as carrying, count(*) as total from public.billing_webhook_events;
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-05: 277 is the newest; 268, 271, 273 and 274 were never applied; 280 is held
-- for the batch building beside this one. Confirm at apply time that the ledger does not show 281:
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;

begin;

-- ── PART 1. Hold the webhook's inserts while this runs ──────────────────────────────────
-- EXCLUSIVE blocks INSERT/UPDATE/DELETE and nothing that only reads, so billing-webhook's
-- idempotency SELECT still answers and its INSERT waits a few milliseconds. A hung apply gives up
-- rather than hold a gateway delivery (the gateway retries a failed one anyway).
set local lock_timeout = '5s';
lock table public.billing_webhook_events in exclusive mode;

-- The one definition of "still carries card or contact details", used by the checks AND the record
-- (and read by _shared/billingWebhookRedact.test.ts, which runs the same three patterns over the
-- webhook's new output). Keys anywhere in the document, plus two value shapes that would betray a
-- block that moved under a name nobody listed: a masked card number and an email address.
-- Checked live 2026-10-05: all 40 rows match before PART 2, none after.
create or replace function pg_temp.m281_carries(p jsonb) returns boolean
  language sql immutable
as $fn$
  select p::text ~ '"(card|cc_[a-z0-9_]+|cvv2?|billing_address|shipping_address|first_name|last_name|email|phone|cell_phone)"'
      or p::text ~ '[0-9]{6}\*+[0-9]{4}'
      or p::text ~ '[^ "]+@[^ "]+\.[a-zA-Z]{2,}'
$fn$;

-- One container (event_body, data.subscription or subscription) without the four blocks. Applied
-- only where the container IS an object: `#-` through a jsonb array raises ("path element is not an
-- integer"), and the webhook never stores one, but a hand-inserted test row must not take the whole
-- file down. A container of any other shape is left for PART 3 to judge.
create or replace function pg_temp.m281_scrub(p jsonb) returns jsonb
  language plpgsql immutable
as $fn$
declare
  k_drop constant text[] := array['card', 'billing_address', 'shipping', 'merchant'];
begin
  if jsonb_typeof(p) <> 'object' then return p; end if;
  if jsonb_typeof(p -> 'event_body') = 'object' then
    p := jsonb_set(p, '{event_body}', (p -> 'event_body') - k_drop);
  end if;
  if jsonb_typeof(p -> 'data' -> 'subscription') = 'object' then
    p := jsonb_set(p, '{data,subscription}', (p -> 'data' -> 'subscription') - k_drop);
  end if;
  if jsonb_typeof(p -> 'subscription') = 'object' then
    p := jsonb_set(p, '{subscription}', (p -> 'subscription') - k_drop);
  end if;
  return p;
end
$fn$;

-- Every row as it was, for PART 3 and THE RECORD.
create temp table m281_before on commit drop as
  select id, event_type, status, error, created_at, processed_at,
         md5(payload::text) as payload_md5, pg_temp.m281_carries(payload) as carried
    from public.billing_webhook_events;

-- ── PART 2. The scrub ────────────────────────────────────────────────────────────────────
-- Only rows it changes are written, so a re-run touches nothing. Removing a key that is not there
-- is a no-op, so one function covers all three shapes.
update public.billing_webhook_events
   set payload = pg_temp.m281_scrub(payload)
 where pg_temp.m281_scrub(payload) is distinct from payload;

-- ── PART 3. Checks: raise (and so roll the whole file back) rather than commit a surprise ─
do $check$
declare
  v_left    int;
  v_left_at text;
  v_moved   int;
  v_total   int;
  v_done    int;
begin
  -- Nothing may still carry card or contact details, whatever path it sits on. A row that does
  -- holds them somewhere PART 2 does not reach: add the path to m281_scrub, never narrow the
  -- patterns.
  select count(*) into v_left from public.billing_webhook_events where pg_temp.m281_carries(payload);
  if v_left > 0 then
    select string_agg(id, ', ' order by id) into v_left_at
      from (select id from public.billing_webhook_events
             where pg_temp.m281_carries(payload) order by id limit 5) x;
    raise exception '281: % row(s) of billing_webhook_events still carry card or contact details after the scrub (first: %) — nothing was changed',
      v_left, v_left_at;
  end if;

  -- Only payload moved: same rows, and every other column exactly as it was.
  select count(*) into v_moved
    from m281_before b
    full join public.billing_webhook_events e on e.id = b.id
   where b.id is null or e.id is null
      or (b.event_type, b.status, b.error, b.created_at, b.processed_at)
         is distinct from (e.event_type, e.status, e.error, e.created_at, e.processed_at);
  if v_moved > 0 then
    raise exception '281: % row(s) of billing_webhook_events changed outside payload, or appeared or vanished — nothing was changed', v_moved;
  end if;

  select count(*) into v_total from m281_before;
  select count(*) into v_done from m281_before b join public.billing_webhook_events e on e.id = b.id
   where md5(e.payload::text) <> b.payload_md5;
  raise notice '281: checks hold; % of % row(s) scrubbed; none still carries card or contact details', v_done, v_total;
end
$check$;

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- It sits BEFORE the commit so a dry run (last `commit;` swapped for `rollback;`) prints the same
-- row and leaves nothing behind. Expected on the first apply (2026-10-05 numbers; more rows by the
-- time it runs): rows_total = carried_before = rows_scrubbed for every row stored before
-- billing-webhook was redeployed, carried_after 0, other_columns_moved 0. A re-apply: rows_scrubbed
-- 0, carried_before 0, carried_after 0. Anything else did not happen: PART 3 would have raised.
select
  '281' as migration,
  (select count(*) from public.billing_webhook_events)::int as rows_total,
  (select count(*) from m281_before where carried)::int as carried_before,
  (select count(*) from m281_before b join public.billing_webhook_events e on e.id = b.id
    where md5(e.payload::text) <> b.payload_md5)::int as rows_scrubbed,
  (select count(*) from public.billing_webhook_events where pg_temp.m281_carries(payload))::int as carried_after,
  (select count(*) from m281_before b full join public.billing_webhook_events e on e.id = b.id
    where b.id is null or e.id is null
       or (b.event_type, b.status, b.error, b.created_at, b.processed_at)
          is distinct from (e.event_type, e.status, e.error, e.created_at, e.processed_at))::int as other_columns_moved;

commit;

drop function if exists pg_temp.m281_carries(jsonb);
drop function if exists pg_temp.m281_scrub(jsonb);

-- After this: billing_webhook_events keeps every event's id, type, status, error and timestamps,
-- and a payload with the subscription facts only. No card digits, expiry dates or payer contact
-- details are left in it, and the redacting billing-webhook stores none from here on.
