-- tenant-orphans.sql: READ ONLY. Rows that outlived their builder (2026-10-21, board item
-- "delete_client leaves 7 per-tenant tables behind, including crm_contacts").
--
-- For every public base table with a client_id column (read from the live catalog, so a table
-- the registry has not heard of still shows up), the rows whose client_id is not a live tenant in
-- client_configs, by table and slug. Compare the tables with supabase/functions/_shared/tenantTables.ts:
-- a retained table's rows are kept on purpose; any other row here is what Track G part 2's one-off
-- purge would remove (SELECT first, and only with Ahsan's go).
--
--   npx supabase db query --linked -o table --file scripts/tenant-orphans.sql
--
-- Nothing here writes. query_to_xml runs one count per table; ~105 tables take a few seconds.
with tenant_tables as (
  select c.table_name
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public' and c.column_name = 'client_id' and t.table_type = 'BASE TABLE'
    and c.table_name <> 'client_configs'
)
select tt.table_name, x.client_id, x.n as orphan_rows
from tenant_tables tt
cross join lateral (
  select (xpath('/row/client_id/text()', r))[1]::text as client_id,
         (xpath('/row/n/text()', r))[1]::text::bigint as n
  from unnest(xpath('/table/row', query_to_xml(format(
    'select client_id::text as client_id, count(*) as n from public.%I'
    ' where client_id is not null and client_id::text not in (select client_id::text from public.client_configs)'
    ' group by 1', tt.table_name), false, false, ''))) as r
) x
order by x.n desc, tt.table_name, x.client_id;
