begin;
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 370 — AUTOMATIONS, ROUND 3b: three new things a rule can DO
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Carolyn, 2026-11-06: "Start round 3B" — the plan's last round ("emails from templates,
-- GoHighLevel push, webhooks"). 367 gave rules thirteen new things to wait for; this gives them
-- three new things to do:
--
--   webhook     POST the rule's facts (who, which rule, when) to an https address the builder
--               gives: a Zapier or Make catch hook, or their own server. Signed with a secret
--               portal-settings makes per action (X-SS-Signature, HMAC-SHA256). crm-rules-tick
--               sends it through safeFetchText's guard, never follows a redirect and never reads
--               the answer's body (_shared/ruleWebhook.ts).
--   ghl_push    create or update the customer in the builder's own GoHighLevel with their saved
--               key, and ADD tags there (_shared/ghlPush.ts).
--   send_email  from a SAVED email (325's email_templates), rendered by the same renderEmailDesign
--               the template editor previews with. NO schema change: the action's params carry
--               {templateId} instead of {subject, body}. Named here so all of round 3b is in one
--               file for whoever reads the migrations.
--
-- What this file changes:
--   PART 1  crm_rule_actions.kind and crm_rule_outbox.kind admit 'webhook' and 'ghl_push'.
--   PART 2  crm_rules_run, 367's body with two lines changed (marked 370): a push needs a
--           customer, and both new kinds are QUEUED for the tick like the messages, never done
--           inside the write that fired the rule (a slow far end must not hold a payment insert).
--   PART 3  crm_rules_sweep, 365's body with one line changed: a schedule for a group must be
--           ARMED to do either, exactly as it must to text or email them. A GoHighLevel tag can
--           start a GoHighLevel workflow that texts everyone tagged; a webhook can feed a Zapier
--           step that emails them. "Every Monday, everyone tagged X" is the same mistake either way.
--   PART 4  checks on a made-up account, rolled back whatever happens.
--
-- ⚠️ DEPLOY ORDER: crm-rules-tick FIRST. Until 370 the tick's email branch was its final `else`,
-- so an older tick handed a 'webhook' row would have sent the customer an EMPTY EMAIL. The outbox
-- CHECK kept such rows out until this file; the new tick names every kind and stops on one it does
-- not know. Then this file, then portal-settings (which saves the new kinds), then the bundle.
--
-- Both functions are re-issued from the exact bodies live when this was written. $pre$ refuses
-- to run if either has changed since (md5 of prosrc), rather than overwrite somebody's change.
-- Not touched: the webhook's secret lives in crm_rule_actions.params and is copied into
-- crm_rule_outbox.params, both service-role only (355); the run log never selects params.

do $pre$
declare v_run text; v_sweep text;
begin
  select md5(prosrc) into v_run from pg_proc
   where oid = to_regprocedure('public.crm_rules_run(text, text, uuid, uuid, jsonb, uuid, text, text[])');
  select md5(prosrc) into v_sweep from pg_proc
   where oid = to_regprocedure('public.crm_rules_sweep(integer)');
  if v_run is distinct from 'f4c838ba5c2d5e2b6f217e522b946345' then
    raise exception '370: live crm_rules_run is not 367''s (md5 %) -- it was re-issued since; splice by hand', v_run;
  end if;
  if v_sweep is distinct from '5d140b9cde1caf239bd5e0b4544ea81c' then
    raise exception '370: live crm_rules_sweep is not 365''s (md5 %) -- it was re-issued since; splice by hand', v_sweep;
  end if;
end;
$pre$;

-- ── PART 1 — the two kinds ───────────────────────────────────────────────────────────────
-- 'push' (a phone notification) is still NOT here: it needs a route on the phone Worker that does
-- not exist, and a kind the database admits but nothing sends is a rule that silently never works.
alter table public.crm_rule_actions drop constraint if exists crm_rule_actions_kind_check;
alter table public.crm_rule_actions add constraint crm_rule_actions_kind_check check (kind in (
  'set_status', 'move_stage', 'mark_lost', 'reopen', 'set_follow_up', 'set_close_date', 'add_note', 'create_card',
  'add_label', 'remove_label', 'assign_owner', 'create_task', 'send_sms', 'send_email', 'notify_team',
  'webhook', 'ghl_push'));
alter table public.crm_rule_outbox drop constraint if exists crm_rule_outbox_kind_check;
alter table public.crm_rule_outbox add constraint crm_rule_outbox_kind_check
  check (kind in ('send_sms', 'send_email', 'notify_team', 'webhook', 'ghl_push'));

-- ── PART 2 — crm_rules_run: 367's body, two lines changed (370) ───────────────────────────
create or replace function public.crm_rules_run(
  p_client     text,
  p_trigger    text,
  p_contact    uuid,
  p_deal       uuid,
  p_payload    jsonb  default '{}'::jsonb,
  p_rule       uuid   default null,
  p_occurrence text   default '',
  p_scopes     text[] default null)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_deal     public.crm_deals%rowtype;
  v_has_deal boolean := false;
  v_contact  uuid := p_contact;
  v_n        integer := 0;
  r          record;
  a          record;
  v_run      bigint;
  v_done     jsonb;
  v_stage    uuid;
  v_facts    jsonb;
  v_occ      text;
  v_once     boolean;
  v_label    text;
  v_user     uuid;
  v_tz       text;
  v_short    text;
begin
  if coalesce(btrim(coalesce(p_client, '')), '') = '' then return 0; end if;
  if p_deal is not null then
    select * into v_deal from public.crm_deals
     where id = p_deal and client_id = p_client and archived_at is null;
    if not found then return 0; end if;
    v_has_deal := true;
    v_contact := coalesce(v_contact, v_deal.contact_id);
  end if;
  -- No subject is allowed only for one named rule — a 'none' schedule, from the sweep.
  if not v_has_deal and v_contact is null and p_rule is null then return 0; end if;
  v_short := case when v_has_deal then v_deal.short_code end;

  for r in
    select * from public.crm_rules x
     where x.client_id = p_client
       and x.archived_at is null
       and x.enabled
       and (case when p_rule is not null then x.id = p_rule
                 else x.trigger_kind = 'event' and x.trigger_event = p_trigger end)
       and (p_scopes is null or x.scope_kind = any (p_scopes))
       and (   (x.scope_kind = 'pipeline'      and v_has_deal and x.pipeline_id = v_deal.pipeline_id)
            or (x.scope_kind = 'all_pipelines' and v_has_deal)
            or (x.scope_kind = 'contacts'      and not v_has_deal and v_contact is not null)
            or (x.scope_kind = 'none'          and p_rule is not null and not v_has_deal and v_contact is null))
       and (p_rule is not null or now() >= x.applies_from)
     order by x.position, x.created_at
  loop
    begin
      -- Once a day, not every time, on the facts a customer can produce at will (365's three
      -- phone facts, and 367's three email facts: opens and bounces can loop on their own).
      v_occ := coalesce(p_occurrence, '');
      if v_occ = '' and not r.once_per_card and p_trigger in ('text_received', 'call_missed', 'voicemail_left',
                                                                  'email_received', 'email_opened', 'email_bounced') then
        v_tz := coalesce(v_tz, public.crm_tenant_time_zone(p_client));
        v_occ := 'day:' || to_char(now() at time zone v_tz, 'YYYY-MM-DD');
      end if;
      v_once := r.once_per_card or v_occ like 'day:%';

      if jsonb_array_length(r.conditions) > 0 then
        if v_facts is null then
          v_facts := public.crm_rule_facts(p_client, case when v_has_deal then v_deal.id end, v_contact, p_payload);
        end if;
        if not public.crm_rule_conditions_hold(v_facts, r.conditions) then
          insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard, occurrence, detail)
          values (p_client, r.id, case when v_has_deal then v_deal.id end, v_contact, p_trigger, 'skipped', false, v_occ,
                  jsonb_build_object('reason', 'conditions'));
          continue;
        end if;
      end if;

      insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard, occurrence, detail)
      values (p_client, r.id, case when v_has_deal then v_deal.id end, v_contact, p_trigger, 'done', v_once, v_occ, '{}'::jsonb)
      returning id into v_run;

      v_done := '[]'::jsonb;
      for a in
        select * from public.crm_rule_actions
         where rule_id = r.id and client_id = p_client
         order by position, created_at
      loop
        if a.kind in ('set_status', 'move_stage', 'mark_lost', 'reopen', 'set_follow_up', 'set_close_date')
           and not v_has_deal then
          raise exception 'That action needs a card, and this rule runs on a customer' using errcode = 'check_violation';
        end if;
        -- 370: a push to GoHighLevel needs somebody to push. (A webhook does not: a rule for nobody
        -- may call one.)
        if a.kind in ('add_note', 'create_card', 'send_sms', 'send_email', 'add_label', 'remove_label', 'assign_owner', 'create_task',
                      'ghl_push')
           and v_contact is null then
          raise exception 'That action needs a customer, and this rule has none' using errcode = 'check_violation';
        end if;

        if a.kind = 'set_status' then
          perform public.crm_set_deal_status(p_client, v_deal.id, (a.params ->> 'statusId')::uuid, null, false);
        elsif a.kind = 'move_stage' then
          perform public.crm_move_deal(p_client, v_deal.id, (a.params ->> 'stageId')::uuid, null, null);
        elsif a.kind = 'mark_lost' then
          perform public.crm_set_deal_lost(p_client, v_deal.id, null, a.params ->> 'reason');
        elsif a.kind = 'reopen' then
          perform public.crm_clear_deal_lost(p_client, v_deal.id, null);
        elsif a.kind = 'set_follow_up' then
          update public.crm_deals
             set next_follow_up_at = now() + make_interval(days => coalesce((a.params ->> 'days')::int, 0)), updated_at = now()
           where id = v_deal.id;
        elsif a.kind = 'set_close_date' then
          update public.crm_deals
             set expected_close_date = (now() + make_interval(days => coalesce((a.params ->> 'days')::int, 0)))::date, updated_at = now()
           where id = v_deal.id;
        elsif a.kind = 'add_note' then
          insert into public.crm_notes (client_id, contact_id, short_code, body)
          values (p_client, v_contact, v_short, left(coalesce(a.params ->> 'body', ''), 4000));
        elsif a.kind = 'create_card' then
          v_stage := public.crm_rule_first_stage(p_client, (a.params ->> 'pipelineId')::uuid);
          if v_stage is not null and not exists (
            select 1 from public.crm_deals d
             where d.client_id = p_client and d.pipeline_id = (a.params ->> 'pipelineId')::uuid
               and d.contact_id = v_contact and d.archived_at is null)
          then
            insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, title, source)
            values (p_client, (a.params ->> 'pipelineId')::uuid, v_stage, v_contact,
                    left(nullif(btrim(coalesce(a.params ->> 'title', '')), ''), 200), 'manual');
          end if;

        -- ── 365's actions ─────────────────────────────────────────────────────────────────
        elsif a.kind = 'add_label' then
          -- A tag already there is left alone: no write, so no "tag added" fact, so a rule that
          -- adds the tag another rule listens for cannot feed it twice.
          v_label := left(btrim(coalesce(a.params ->> 'label', '')), 60);
          if v_label = '' then raise exception 'That rule names no tag' using errcode = 'check_violation'; end if;
          update public.crm_contacts set labels = array_append(labels, v_label), updated_at = now()
           where id = v_contact and client_id = p_client
             and not exists (select 1 from unnest(labels) x where lower(btrim(x)) = lower(v_label));
        elsif a.kind = 'remove_label' then
          v_label := lower(btrim(coalesce(a.params ->> 'label', '')));
          update public.crm_contacts
             set labels = coalesce((select array_agg(x) from unnest(labels) x where lower(btrim(x)) <> v_label), '{}'), updated_at = now()
           where id = v_contact and client_id = p_client
             and exists (select 1 from unnest(labels) x where lower(btrim(x)) = v_label);
        elsif a.kind = 'assign_owner' then
          -- Only someone on THIS builder's team; a stale id fails the rule in words.
          select user_id into v_user from public.client_users
           where client_id = p_client and user_id = (a.params ->> 'userId')::uuid;
          if v_user is null then raise exception 'The person this rule assigns to is no longer on your team' using errcode = 'check_violation'; end if;
          update public.crm_contacts set owner_user_id = v_user, updated_at = now()
           where id = v_contact and client_id = p_client;
        elsif a.kind = 'create_task' then
          -- A task on the customer, which is what lists under their Planned section. Due at 9am
          -- on the day, in the ACCOUNT's time zone; for the named person, else the owner.
          v_tz := coalesce(v_tz, public.crm_tenant_time_zone(p_client));
          v_user := nullif(a.params ->> 'assigneeUserId', '')::uuid;
          if v_user is not null and not exists (select 1 from public.client_users where client_id = p_client and user_id = v_user) then
            raise exception 'The person this task is for is no longer on your team' using errcode = 'check_violation';
          end if;
          insert into public.crm_activities (client_id, contact_id, short_code, kind, subject, due_at, all_day, assignee_user_id, done)
          values (p_client, v_contact, v_short, 'task',
                  left(coalesce(nullif(btrim(a.params ->> 'title'), ''), 'Follow up'), 200),
                  ((((now() at time zone v_tz)::date) + coalesce((a.params ->> 'dueDays')::int, 0)) + time '09:00') at time zone v_tz,
                  false,
                  coalesce(v_user, (select owner_user_id from public.crm_contacts where id = v_contact)),
                  false);
        -- 370: the webhook and the GoHighLevel push are QUEUED for the tick like the messages, never
        -- done here: this runs inside whatever write fired the rule, and a slow far end must not hold it.
        elsif a.kind in ('send_sms', 'send_email', 'notify_team', 'webhook', 'ghl_push') then
          insert into public.crm_rule_outbox (client_id, run_id, rule_id, deal_id, contact_id, kind, params)
          values (p_client, v_run, r.id, case when v_has_deal then v_deal.id end, v_contact, a.kind, a.params);
        else
          raise exception 'unknown rule action %', a.kind using errcode = 'check_violation';
        end if;
        v_done := v_done || jsonb_build_object('action', a.id, 'kind', a.kind);
      end loop;

      update public.crm_rule_runs
         set detail = jsonb_build_object('actions', v_done)
                      || case when p_payload is not null and p_payload <> '{}'::jsonb
                              then jsonb_build_object('payload', p_payload) else '{}'::jsonb end
       where id = v_run;
      v_n := v_n + 1;
    exception
      when unique_violation then
        begin
          insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard, occurrence, detail)
          values (p_client, r.id, case when v_has_deal then v_deal.id end, v_contact, p_trigger, 'skipped', false, v_occ,
                  jsonb_build_object('reason', case when v_occ like 'day:%' then 'already run for them today'
                                                    when v_has_deal then 'already run for this card'
                                                    when v_contact is not null then 'already run for this customer'
                                                    else 'already run' end));
        exception when others then null;
        end;
      when others then
        begin
          insert into public.crm_rule_runs (client_id, rule_id, deal_id, contact_id, trigger, outcome, once_guard, occurrence, detail)
          values (p_client, r.id, case when v_has_deal then v_deal.id end, v_contact, p_trigger, 'failed', false, v_occ,
                  jsonb_build_object('sqlstate', sqlstate, 'error', sqlerrm));
        exception when others then null;
        end;
    end;
  end loop;
  return v_n;
end;
$fn$;
revoke execute on function public.crm_rules_run(text, text, uuid, uuid, jsonb, uuid, text, text[]) from public, anon, authenticated;
grant  execute on function public.crm_rules_run(text, text, uuid, uuid, jsonb, uuid, text, text[]) to service_role;

-- ── PART 3 — crm_rules_sweep: 365's body, one line changed (370) ──────────────────────────
create or replace function public.crm_rules_sweep(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_n integer := 0;
  r   record;
  d   record;
  v_trigger text;
  v_tz   text;
  v_occ  text;
  v_on   date;
  v_cap  integer;
  v_got  integer;
  v_out  boolean;
begin
  -- ── A. CARD CLOCKS (355/363, unchanged) ─────────────────────────────────────────────────
  for r in
    select * from public.crm_rules
     where trigger_kind = 'elapsed' and enabled and archived_at is null
       and scope_kind in ('pipeline', 'all_pipelines')
     order by client_id, position
  loop
    begin
      v_trigger := 'elapsed:' || r.elapsed_anchor || '+' || r.elapsed_days || 'd';
      for d in
        select * from (
          select dl.id as deal_id, dl.contact_id,
                 (case r.elapsed_anchor
                    when 'stage_entered'  then dl.stage_entered_at
                    when 'expected_close' then dl.expected_close_date::timestamptz
                    when 'delivered'      then (select g.delivered_at from public.designs g
                                                 where g.client_id = dl.client_id and g.short_code = dl.short_code limit 1)
                    when 'last_contact'   then public.crm_rule_last_contact(dl.client_id, dl.contact_id, dl.created_at)
                    else null
                  end) as at
            from public.crm_deals dl
           where dl.client_id = r.client_id
             and (r.scope_kind = 'all_pipelines' or dl.pipeline_id = r.pipeline_id)
             and dl.archived_at is null
             and not exists (select 1 from public.crm_rule_runs n
                              where n.rule_id = r.id and n.deal_id = dl.id and n.occurrence = ''
                                and n.once_guard and n.outcome <> 'failed')
        ) q
        where q.at is not null
          and q.at + make_interval(days => r.elapsed_days) <= now()
          and q.at >= r.applies_from          -- ⚠️ THE LINE (355)
          and (jsonb_array_length(r.conditions) = 0
               or public.crm_rule_conditions_hold(public.crm_rule_facts(r.client_id, q.deal_id, q.contact_id), r.conditions))
        order by q.at
        limit greatest(coalesce(p_limit, 200), 1)
      loop
        perform public.crm_rules_run(r.client_id, v_trigger, d.contact_id, d.deal_id, '{}'::jsonb, r.id, '');
        v_n := v_n + 1;
      end loop;
    exception when others then
      begin
        insert into public.app_errors (client_id, source, severity, code, message, context)
        values (r.client_id, 'db:crm_rules_sweep', 'error', 'crm_rules_sweep_failed',
                'crm_rules_sweep: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'rule_id', r.id));
      exception when others then null;
      end;
    end;
  end loop;

  -- ── B. CUSTOMER CLOCKS (365): "no contact for 30 days", "7 days after they were added" ──
  -- "No contact" is keyed by WHEN they were last contacted, so it fires once per quiet spell —
  -- go quiet, get the nudge, talk, go quiet again, get it again — and never twice for one spell.
  for r in
    select * from public.crm_rules
     where trigger_kind = 'elapsed' and enabled and archived_at is null and scope_kind = 'contacts'
     order by client_id, position
  loop
    begin
      v_trigger := 'elapsed:' || r.elapsed_anchor || '+' || r.elapsed_days || 'd';
      for d in
        select * from (
          select c.id as contact_id,
                 (case r.elapsed_anchor
                    when 'contact_created' then c.created_at
                    when 'last_contact'    then public.crm_rule_last_contact(c.client_id, c.id, c.created_at)
                  end) as at
            from public.crm_contacts c
           where c.client_id = r.client_id and c.merged_into is null
        ) q
        where q.at is not null
          and q.at + make_interval(days => r.elapsed_days) <= now()
          and q.at >= r.applies_from          -- ⚠️ THE LINE, for customers too
          and not exists (select 1 from public.crm_rule_runs n
                           where n.rule_id = r.id and n.contact_id = q.contact_id and n.deal_id is null
                             and n.occurrence = (case when r.elapsed_anchor = 'last_contact'
                                                      then 'lc:' || to_char(q.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') else '' end)
                             and n.once_guard and n.outcome <> 'failed')
          and (jsonb_array_length(r.conditions) = 0
               or public.crm_rule_conditions_hold(public.crm_rule_facts(r.client_id, null, q.contact_id), r.conditions))
        order by q.at
        limit greatest(coalesce(p_limit, 200), 1)
      loop
        perform public.crm_rules_run(r.client_id, v_trigger, d.contact_id, null, '{}'::jsonb, r.id,
          case when r.elapsed_anchor = 'last_contact' then 'lc:' || to_char(d.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') else '' end);
        v_n := v_n + 1;
      end loop;
    exception when others then
      begin
        insert into public.app_errors (client_id, source, severity, code, message, context)
        values (r.client_id, 'db:crm_rules_sweep', 'error', 'crm_rules_sweep_failed',
                'crm_rules_sweep: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'rule_id', r.id));
      exception when others then null;
      end;
    end;
  end loop;

  -- ── C. SCHEDULES (365) — see the header, points 2 and 3 ────────────────────────────────
  for r in
    select * from public.crm_rules
     where trigger_kind = 'schedule' and enabled and archived_at is null
       and next_run_at is not null and next_run_at <= now()
     order by next_run_at
  loop
    begin
      v_tz  := public.crm_tenant_time_zone(r.client_id);
      v_on  := (r.next_run_at at time zone v_tz)::date;
      v_occ := to_char(v_on, 'YYYY-MM-DD');
      v_trigger := 'schedule:' || coalesce(r.schedule ->> 'freq', '?');
      -- 370: handing them to GoHighLevel or a webhook needs the arm too (_shared/crmRules.ts RULE_ARMED).
      v_out := exists (select 1 from public.crm_rule_actions a where a.rule_id = r.id
                        and a.kind in ('send_sms', 'send_email', 'webhook', 'ghl_push'));
      if now() - r.next_run_at > interval '6 hours' then
        -- A day-late "8am" text is worse than none.
        insert into public.crm_rule_runs (client_id, rule_id, trigger, outcome, once_guard, occurrence, detail)
        values (r.client_id, r.id, v_trigger, 'skipped', false, v_occ, jsonb_build_object('reason', 'missed its time by more than six hours'));
        update public.crm_rules set next_run_at = public.crm_rule_next_run(r.schedule, v_tz, now()) where id = r.id;
      elsif v_out and r.armed_count is null and r.scope_kind <> 'none' then
        -- ⛔ NOT ARMED: it would message a group nobody has counted. Logged, never sent.
        insert into public.crm_rule_runs (client_id, rule_id, trigger, outcome, once_guard, occurrence, detail)
        values (r.client_id, r.id, v_trigger, 'skipped', false, v_occ, jsonb_build_object('reason', 'not armed — open the rule and arm it'));
        update public.crm_rules set next_run_at = public.crm_rule_next_run(r.schedule, v_tz, now()) where id = r.id;
      else
        v_cap := r.max_per_run;
        v_got := 0;
        for d in select * from public.crm_rule_audience(r.id, v_on, v_occ, v_cap + 1) loop
          v_got := v_got + 1;
          exit when v_got > v_cap;
          perform public.crm_rules_run(r.client_id, v_trigger, d.contact_id, d.deal_id, '{}'::jsonb, r.id, v_occ);
          v_n := v_n + 1;
        end loop;
        -- More than a tick's worth: leave next_run_at where it is, and the next tick carries on
        -- under the SAME occurrence (the once key stops anyone getting it twice).
        if v_got <= v_cap then
          update public.crm_rules set next_run_at = public.crm_rule_next_run(r.schedule, v_tz, now()) where id = r.id;
        end if;
      end if;
    exception when others then
      begin
        insert into public.app_errors (client_id, source, severity, code, message, context)
        values (r.client_id, 'db:crm_rules_sweep', 'error', 'crm_rules_sweep_failed',
                'crm_rules_sweep: ' || sqlerrm, jsonb_build_object('sqlstate', sqlstate, 'rule_id', r.id));
      exception when others then null;
      end;
    end;
  end loop;
  return v_n;
end;
$fn$;
revoke execute on function public.crm_rules_sweep(integer) from public, anon, authenticated;
grant  execute on function public.crm_rules_sweep(integer) to service_role;

-- ── PART 4 — checks, on a made-up account, and ROLLED BACK whatever happens ──────────────
-- Every write below happens inside one sub-block that ends by raising 'm370-rollback' (367's
-- shape), so the rehearsal account and everything it queued vanish with it. The sweep it calls
-- (365's own check does the same) runs over every account's due rules, and those writes roll
-- back with the sub-block too.
do $chk$
declare
  v_t    text := 'm370-rehearsal-' || substr(md5(random()::text), 1, 8);
  v_fail text;
  v_ok   boolean := false;
  v_c    uuid; v_tpl uuid; v_a uuid; v_b uuid; v_x uuid; v_s uuid;
  v_n    integer;
begin
  begin
    insert into public.crm_contacts (client_id, name, phone, phone_digits, email, source, labels)
    values (v_t, 'Gil Rehearsal', '(555) 010-3700', '5550103700', 'gil370@example.invalid', 'manual', array['Lot visitor'])
    returning id into v_c;
    insert into public.email_templates (client_id, name, purpose, subject)
    values (v_t, '370 thank you', 'general', 'Thanks {{contact.first_name}}') returning id into v_tpl;

    -- 1. THE KINDS: both new ones are admitted, and 'push' still is not.
    insert into public.crm_rules (client_id, scope_kind, trigger_kind, trigger_event, once_per_card, name)
    values (v_t, 'contacts', 'event', 'label_added', false, '370 customer rule') returning id into v_a;
    insert into public.crm_rule_actions (client_id, rule_id, kind, params, position) values
      (v_t, v_a, 'webhook', jsonb_build_object('url', 'https://hooks.example.com/370', 'secret', repeat('ab', 32)), 1),
      (v_t, v_a, 'ghl_push', '{"tags":["lot-buyer"]}', 2),
      (v_t, v_a, 'send_email', jsonb_build_object('templateId', v_tpl), 3);
    begin
      insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_a, 'push', '{}');
      v_fail := '370: the actions CHECK admitted push'; raise exception 'm370-stop';
    exception when check_violation then null;
    end;

    -- 2. A CUSTOMER RULE QUEUES all three for the tick, with their params, and does none of them
    --    itself: three outbox rows, one 'done' run.
    perform public.crm_rules_run(v_t, 'label_added', v_c, null, '{}'::jsonb, v_a, 'm370-1', null);
    if (select count(*) from public.crm_rule_outbox where rule_id = v_a and contact_id = v_c and state = 'queued') <> 3
       or not exists (select 1 from public.crm_rule_outbox where rule_id = v_a and kind = 'webhook' and params ->> 'secret' = repeat('ab', 32))
       or not exists (select 1 from public.crm_rule_outbox where rule_id = v_a and kind = 'ghl_push' and params -> 'tags' = '["lot-buyer"]'::jsonb)
       or not exists (select 1 from public.crm_rule_outbox where rule_id = v_a and kind = 'send_email' and params ->> 'templateId' = v_tpl::text)
       or (select outcome from public.crm_rule_runs where rule_id = v_a) is distinct from 'done' then
      v_fail := '370: a customer rule did not queue its webhook, push and saved email'; raise exception 'm370-stop';
    end if;

    -- 3. A RULE FOR NOBODY may call a webhook (a schedule that just says "it is Monday"), with no
    --    customer on the row; it may NOT push, because there is nobody to push.
    insert into public.crm_rules (client_id, scope_kind, trigger_kind, schedule, name)
    values (v_t, 'none', 'schedule', '{"freq":"daily","at":"08:00"}', '370 team webhook') returning id into v_b;
    insert into public.crm_rule_actions (client_id, rule_id, kind, params)
    values (v_t, v_b, 'webhook', '{"url":"https://hooks.example.com/370-team"}');
    perform public.crm_rules_run(v_t, 'schedule:daily', null, null, '{}'::jsonb, v_b, 'm370-2', null);
    if (select count(*) from public.crm_rule_outbox where rule_id = v_b and contact_id is null and deal_id is null and kind = 'webhook') <> 1 then
      v_fail := '370: a rule for nobody did not queue its webhook'; raise exception 'm370-stop';
    end if;
    insert into public.crm_rules (client_id, scope_kind, trigger_kind, schedule, name)
    values (v_t, 'none', 'schedule', '{"freq":"daily","at":"08:00"}', '370 push for nobody') returning id into v_x;
    insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_x, 'ghl_push', '{}');
    perform public.crm_rules_run(v_t, 'schedule:daily', null, null, '{}'::jsonb, v_x, 'm370-3', null);
    if exists (select 1 from public.crm_rule_outbox where rule_id = v_x)
       or (select outcome from public.crm_rule_runs where rule_id = v_x) is distinct from 'failed' then
      v_fail := '370: a push with nobody to push was not refused'; raise exception 'm370-stop';
    end if;

    -- 4. NOT ARMED: a schedule for customers that pushes them to GoHighLevel sends nothing, logs
    --    why and moves its clock on (365's check, with the new kind).
    insert into public.crm_rules (client_id, scope_kind, trigger_kind, schedule, max_per_run, name)
    values (v_t, 'contacts', 'schedule', '{"freq":"daily","at":"08:00"}', 5, '370 unarmed push') returning id into v_s;
    insert into public.crm_rule_actions (client_id, rule_id, kind, params) values (v_t, v_s, 'ghl_push', '{"tags":["x"]}');
    update public.crm_rules set next_run_at = now() - interval '1 minute' where id = v_s;
    perform public.crm_rules_sweep(500);
    if exists (select 1 from public.crm_rule_outbox where rule_id = v_s)
       or not exists (select 1 from public.crm_rule_runs where rule_id = v_s and outcome = 'skipped' and detail ->> 'reason' like 'not armed%')
       or (select next_run_at from public.crm_rules where id = v_s) <= now() then
      v_fail := '370: an unarmed schedule that pushes customers to GoHighLevel was not stopped'; raise exception 'm370-stop';
    end if;
    -- …and ARMED, it reaches the one customer.
    delete from public.crm_rule_runs where rule_id = v_s;
    update public.crm_rules set armed_count = 1, next_run_at = now() - interval '1 minute' where id = v_s;
    perform public.crm_rules_sweep(500);
    select count(*) into v_n from public.crm_rule_outbox where rule_id = v_s and contact_id = v_c and kind = 'ghl_push';
    if v_n <> 1 then
      v_fail := format('370: an armed push schedule queued %s row(s), expected 1', v_n); raise exception 'm370-stop';
    end if;

    -- 5. Still closed to the browser.
    if has_function_privilege('anon', 'public.crm_rules_run(text, text, uuid, uuid, jsonb, uuid, text, text[])', 'execute')
       or has_function_privilege('authenticated', 'public.crm_rules_run(text, text, uuid, uuid, jsonb, uuid, text, text[])', 'execute')
       or has_function_privilege('anon', 'public.crm_rules_sweep(integer)', 'execute')
       or has_function_privilege('authenticated', 'public.crm_rules_sweep(integer)', 'execute') then
      v_fail := '370: the evaluator is callable from the browser'; raise exception 'm370-stop';
    end if;

    raise exception 'm370-rollback';
  exception when others then
    if sqlerrm = 'm370-rollback' then
      v_ok := true;
    elsif sqlerrm <> 'm370-stop' then
      v_fail := coalesce(v_fail, '370: a check crashed: ' || sqlerrm || ' (' || sqlstate || ')');
    end if;
  end;
  if v_fail is not null then raise exception '%', v_fail; end if;
  if not v_ok then raise exception '370: the checks did not finish'; end if;
  if exists (select 1 from public.crm_contacts where client_id = v_t)
     or exists (select 1 from public.crm_rules where client_id = v_t)
     or exists (select 1 from public.email_templates where client_id = v_t) then
    raise exception '370: the rehearsal account outlived its roll back';
  end if;
  raise notice '370 checks: OK';
end;
$chk$;
