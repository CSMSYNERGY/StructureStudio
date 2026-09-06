-- 156_load_design_legacy_code_redaction.sql
-- Withhold customer PII from designs whose share code is too short to be a credential.
--
-- APPLY BY HAND (SQL editor / MCP execute_sql / `supabase db query --linked`), then record
-- the row in supabase_migrations.schema_migrations. NEVER `supabase db push`.
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────────────
-- The share code IS the capability: load_design is anon-callable and hands back the whole
-- designs row for anyone who knows the code. That is the intended model and it is fine at
-- the current code length — genShortCode emits 10 characters of a 32-symbol alphabet, so
-- guessing one is a 32^10 (~2^50) problem.
--
-- 48 designs predate that and carry SIX-character codes (all junior-barns, created
-- 2026-05-04 → 2026-07-01; 40 sent, 7 invoiced, 1 accepted). Six characters is 32^6 ≈ 1.07e9,
-- and the arithmetic that matters is NOT per-design: an attacker enumerating the short space
-- hits ANY of the 48, so the expected number of probes is ~1.07e9/48 ≈ 22 MILLION. That is
-- hours-to-days of ordinary traffic, not a theoretical attack, and every one of those 48 rows
-- carries a real customer's name, phone, email and address.
--
-- ── WHY THIS AND NOT THE OBVIOUS FIXES ───────────────────────────────────────
-- ⛔ NOT rotating the codes to 10 characters. Those 40 'sent' quotes were EMAILED to
--    customers as ?id=<code> links, and the code is referenced by 17 other tables
--    (orders, build_jobs, delivery_stops, invoice_sends, change_orders, design_versions,
--    crm_*, email_*, sms_messages, inventory_units…). Rotating breaks live customer links to
--    close a slow enumeration hole — trading a certain support problem for a possible one.
-- ⛔ NOT rate-limiting load_design. It would have to become VOLATILE to record attempts, and
--    the only caller identity available is a forwarded header, which the client controls.
--    Fragile, and it puts every quote link in the product behind new failure modes.
--
-- Instead: keep every link working, and make a guessed legacy code WORTHLESS. The design
-- still loads and still renders — the customer's identity does not come with it.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────────
-- For codes shorter than 8 characters only, four fields are nulled on the way out:
--   contact           the PII itself
--   image_url         the quote PDF — the bucket is public by design (migration 042), and
--                     that PDF prints the customer's name, phone, email and address
--   ss_quote_pdf_url  the same exposure by another column
--   contact_id        pointer into crm_contacts; no anon caller has any use for it
-- Verified against the shipped designer before choosing this list: its load path reads
-- short_code, status, client_id, selections, items, ro_dimensions, paint_colors,
-- custom_options, inventory_unit_id and the ghl_*/ss_quote_number refs — and NONE of the
-- four above except `contact`, which it uses only to prefill the quote form. So the visible
-- cost is exactly this: reopening one of those 48 legacy links no longer prefills the
-- customer's own details. Everything else about the page is unchanged.
--
-- Modern codes (>= 8 chars) are untouched and keep the full row. The threshold is 8, not 10,
-- deliberately: the two 8- and 9-character codes are 2^40 and 2^45 problems with ONE target
-- each — not enumerable — so redacting them would cost prefill for no security gain.
--
-- ── WHAT THIS MIGRATION DOES *NOT* CLOSE ─────────────────────────────────────
-- 1. THE OTHER TWO CAPABILITY RPCs. load_design is not the only SECURITY DEFINER function
--    granted to anon and keyed on short_code: list_design_versions (032) and
--    load_design_version (031) return design_versions rows carrying their own `contact` and
--    `image_url`. A legacy design has no version rows today (031 shipped after all 48 were
--    created), but the next save of one appends a full snapshot and the same information
--    becomes readable through the same guessed code under a different function name.
--    → migration 193 applies this same redaction, at the same threshold, to both of them.
--
-- 2. THE PDF OBJECT ITSELF. Nulling image_url hides the LINK, not the FILE. The floor-plans
--    bucket is public by design (042), and the uploads these legacy designs carry are keyed
--    on the bare code — `<client_id>/SS-<code>.pdf`, with no timestamp suffix (031 widened
--    the key shape to add one, and every upload since carries it). An object key DERIVED
--    from the capability is not protected by redacting the column that quotes it: whoever
--    resolves a legacy code can still reach the PDF, and the PDF prints the same name,
--    phone, email and address this migration withholds.
--    Closing it means re-keying those objects with entropy the code does not supply and
--    repointing designs.image_url / designs.ss_quote_pdf_url / design_versions.image_url at
--    the new keys. That is a storage-API job, NOT SQL — renaming the row in storage.objects
--    leaves the file behind at its old backend key and the link 404s. It also breaks the PDF
--    link inside the quote emails already delivered to those customers, which is a business
--    decision rather than a migration. Deliberately out of scope here; tracked separately.
--
-- ⛔ CONSIDERED AND REJECTED: redacting only when `auth.role() = 'anon'`, so signed-in staff
--    keep the prefill. It works (auth.role() is available here), and it was tempting because
--    the visible cost above lands on staff too — opening one of these 48 in the PORTAL
--    designer also stops prefilling. Rejected for two reasons. First, load_design is
--    SECURITY DEFINER and deliberately cross-tenant (a rep opens a share link from another
--    builder), so 'authenticated' is not a tenant boundary: it would leave the same
--    enumeration open to anyone holding any login on any tenant, which is a smaller door,
--    not a closed one. Second, a projection that returns different columns depending on who
--    asks is the kind of thing that reads as a bug for years — someone tests as staff, sees
--    the contact, and concludes the redaction never shipped. One rule for every caller.
--    Staff have not lost the information: the portal reads `designs` directly (RLS-scoped),
--    so Contacts, the CRM record page and the Orders row all still show the customer.
--
-- ⚠️ jsonb_populate_record, not a hand-written row constructor. The column list of `designs`
-- has grown repeatedly (accepted_snapshot, ss_invoice_sent_at, view3d_image_url…), and a
-- positional row literal here would silently mis-map the day someone adds another. Building
-- the row from jsonb is order-independent and survives schema changes; omitted keys come
-- back NULL, which is exactly the redaction.
--
-- This is a projection change ONLY. The function stays STABLE + SECURITY DEFINER with an
-- empty search_path, and its signature and return type are unchanged, so every caller —
-- including the portal's own reads — keeps working.
--
-- ROLLBACK (restores the previous definition verbatim):
--   create or replace function public.load_design(p_code text)
--   returns setof public.designs language sql stable security definer set search_path to ''
--   as $$ select * from public.designs where short_code = p_code $$;

create or replace function public.load_design(p_code text)
returns setof public.designs
language sql
stable
security definer
set search_path to ''
as $function$
  select (
    jsonb_populate_record(
      null::public.designs,
      case
        when length(regexp_replace(d.short_code, '^SS-', '')) < 8
          then to_jsonb(d) - 'contact' - 'image_url' - 'ss_quote_pdf_url' - 'contact_id'
        else to_jsonb(d)
      end
    )
  ).*
  from public.designs d
  where d.short_code = p_code
$function$;
