-- 125_ss_invoice: StructureStudio-issued invoices — numbering + where the invoice lives.
--
-- SS-mode tenants (invoice_in_ghl = false, migration 121) invoice from the same Send
-- invoice button, but the invoice is OURS: its own number sequence, its own 3-sheet PDF,
-- emailed by us. There is still NO invoices table — invoice_sends stays "the invoice on
-- our side" (102:134); these columns teach it whose invoice a row records.
--
--   ss_invoice_next / ss_invoice_prefix   the builder's own INVOICE numbering, a separate
--       sequence from quotes by decision (Carolyn 2026-08-23): a builder whose invoices
--       continue from QuickBooks doesn't want quote gaps burning invoice numbers. Same
--       NULL-means-not-set contract as ss_quote_next (121).
--   invoice_sends.issued_by   'ghl' (default — every existing row was a GHL convert) or
--       'structurestudio'. For SS rows invoice_id/ghl_estimate_id stay NULL and
--       invoice_number carries the SS number, prefix included.
--   invoice_sends.invoice_pdf_url   the SS invoice document; the 'created' recovery path
--       re-sends this exact URL rather than rebuilding.
--
-- The partial unique index mirrors designs_ss_quote_number_uniq (122): the allocator makes
-- duplicates impossible in normal operation, so a collision is a bug or a hand-edit — and
-- two invoices sharing a number is an accounting dispute, not a curiosity.
--
-- Hand-apply via the SQL editor / MCP and record as version 125 — NEVER `supabase db push`.

alter table public.client_settings
  add column if not exists ss_invoice_next   integer,
  add column if not exists ss_invoice_prefix text not null default '';

alter table public.invoice_sends
  add column if not exists issued_by text not null default 'ghl'
    check (issued_by in ('ghl','structurestudio')),
  add column if not exists invoice_pdf_url text;

create unique index if not exists invoice_sends_ss_number_uniq
  on public.invoice_sends (client_id, invoice_number)
  where issued_by = 'structurestudio' and invoice_number is not null;

-- The invoice-number allocator — a byte-level mirror of allocate_ss_quote_number (123)
-- over the invoice pair. See 123 for the full why (atomic pre-increment, gaps-are-fine,
-- NULL means refuse-don't-invent-a-1).
create or replace function public.allocate_ss_invoice_number(p_client_id text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_used   integer;
  v_prefix text;
begin
  update public.client_settings
     set ss_invoice_next = ss_invoice_next + 1,
         updated_at      = now()
   where client_id = p_client_id
     and ss_invoice_next is not null
  returning ss_invoice_next - 1, coalesce(ss_invoice_prefix, '')
       into v_used, v_prefix;

  if v_used is null then
    return null;   -- no row, or no starting number set
  end if;

  return v_prefix || v_used::text;
end;
$fn$;

revoke execute on function public.allocate_ss_invoice_number(text) from public;
revoke execute on function public.allocate_ss_invoice_number(text) from anon;
revoke execute on function public.allocate_ss_invoice_number(text) from authenticated;

-- Rollback:
--   drop function if exists public.allocate_ss_invoice_number(text);
--   drop index if exists public.invoice_sends_ss_number_uniq;
--   alter table public.invoice_sends
--     drop column if exists issued_by,
--     drop column if exists invoice_pdf_url;
--   alter table public.client_settings
--     drop column if exists ss_invoice_next,
--     drop column if exists ss_invoice_prefix;
