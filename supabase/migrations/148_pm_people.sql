-- 148_pm_people: assignable PEOPLE are their own roster, separate from operator access.
-- Carolyn 2026-08-27: "split them, assignable people separate from operator access, but
-- one profile can have both."
--
-- Until now the Assignee picker WAS app_operators, so making someone assignable meant
-- granting them access to every builder's account. Now:
--   * pm_people     — who can be assigned work. A name is enough; no login required.
--   * app_operators — who can open builders' accounts (unchanged, still the privilege).
--   * pm_people.user_id links the two, so ONE profile can be both.
--
-- ⚠️ This migration REWRITES DATA: existing assignments (and any saved-view assignee
-- facet) hold auth user ids and are re-pointed to the new person ids. Verified live on
-- application: 8 assignments before, 8 resolving to people after.
--
-- APPLIED LIVE + LEDGERED as version 148 on 2026-08-27. Check the LEDGER for the next
-- free number, not this folder.
create table if not exists public.pm_people (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text,
  -- Optional link to a real login. Operator access can only be granted to a person who
  -- has one (you cannot sign in as a name), which is what keeps the two concepts joined
  -- without merging them again.
  user_id    uuid unique,
  active     boolean not null default true,
  position   double precision not null default 1024,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pm_people_active_idx on public.pm_people (active, position);

alter table public.pm_people enable row level security;
revoke all on public.pm_people from anon, authenticated;

-- Seed one person per existing operator, carrying the display names set on 147.
insert into public.pm_people (name, email, user_id, position)
select coalesce(nullif(trim(o.display_name), ''), split_part(o.email, '@', 1)),
       o.email, o.user_id,
       (row_number() over (order by o.email)) * 1024
from public.app_operators o
where not exists (select 1 from public.pm_people p where p.user_id = o.user_id);

-- Re-point every existing assignment from auth user ids to the new person ids. Item
-- values are jsonb keyed by column id, so this walks each people column per board.
do $$
declare it record; col record; newarr jsonb;
begin
  for it in select i.id, i.values, i.board_id from public.pm_items i loop
    for col in select c.id from public.pm_columns c where c.type = 'people' and c.board_id = it.board_id loop
      if it.values ? col.id::text and jsonb_typeof(it.values -> col.id::text) = 'array' then
        select coalesce(jsonb_agg(to_jsonb(p.id::text)), '[]'::jsonb) into newarr
        from jsonb_array_elements_text(it.values -> col.id::text) as e(uid)
        join public.pm_people p on p.user_id::text = e.uid;
        update public.pm_items set values = jsonb_set(values, array[col.id::text], newarr) where id = it.id;
      end if;
    end loop;
  end loop;
end $$;

-- Saved views can filter on an assignee, and that facet holds the same id. A view that
-- silently matched nothing after this change would look like the view was broken.
do $$
declare v record; col record; oldval text; newid text; f jsonb;
begin
  for v in select w.id, w.snap, w.board_id from public.pm_views w loop
    f := coalesce(v.snap -> 'facets', '{}'::jsonb);
    for col in select c.id from public.pm_columns c where c.type = 'people' and c.board_id = v.board_id loop
      oldval := f ->> col.id::text;
      if oldval is not null then
        select p.id::text into newid from public.pm_people p where p.user_id::text = oldval;
        if newid is not null then
          f := jsonb_set(f, array[col.id::text], to_jsonb(newid));
        end if;
      end if;
    end loop;
    update public.pm_views set snap = jsonb_set(v.snap, '{facets}', f) where id = v.id;
  end loop;
end $$;

-- Rollback: assignments would have to be mapped back to user ids first.
--   drop table public.pm_people;
