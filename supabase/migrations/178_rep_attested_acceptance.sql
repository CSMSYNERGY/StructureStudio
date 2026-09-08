-- 178_rep_attested_acceptance: the rep can invoice a quote the customer hasn't accepted.
--
-- Carolyn, 2026-09-01: after submitting a quote the rep should be able to PUSH it straight
-- to an invoice, without waiting for the customer to click Accept. The customer still signs
-- the invoice — that rung of the ladder (136) is untouched.
--
-- WHY THIS TOUCHES THE ACCEPTANCE TABLE AT ALL, which is the part worth reading. "Skip the
-- accept step" cannot mean "skip the acceptance", because acceptance is not a checkbox — it
-- is what BUILDS the four things invoicing reads:
--
--     the orders row            (designs_ensure_order on status->accepted, plus the
--                                belt-and-braces upsert in customer-accept)
--     designs.accepted_snapshot (153) the frozen agreement every change order diffs against
--     orders.total_cents        the amount amendedInvoiceDocument bills
--     a design_acceptances row  which the amendment trail and the customer card render from
--
-- Issuing an invoice with none of them present fails in five places at once, and every one
-- of them is silent. The worst: with no accepted_snapshot, submit-estimate's 9-ALT change
-- order block (gated on accepted_at) never fires, so a rep who revises AFTER invoicing
-- rewrites estimate_lines with no change order — and customer-accept's sign_invoice then
-- recomputes the total from the NEW lines, so the countersigned certificate names an amount
-- that is not the one on the invoice PDF the customer is looking at. Nothing catches it: the
-- staleness guard compares a CO's acknowledged_at to the invoice, and there is no CO.
--
-- So push_to_invoice does not bypass the acceptance. It PERFORMS one, attributed to the rep
-- instead of forged as the customer's, and the existing gate in portal-settings send_invoice
-- is left byte-identical and simply passes. Same posture as change_orders' verbal
-- acknowledgement (126): a rep may assert the customer's agreement, and the record says
-- plainly that it was the rep who asserted it.
--
-- WHAT MAKES THIS SAFE TO ADD. design_acceptances has RLS on with no insert policy at all
-- (124:63-69) — writes are service-role only. So a 'rep' row can only ever be minted by an
-- edge function that has already passed the {area:'orders', level:'edit'} gate; the browser
-- cannot mint one whatever it sends, and no trigger is needed to say so. Compare 126, which
-- DID need a trigger, because change_orders is browser-writable under RLS.
--
-- NOT DONE HERE, deliberately: phone_digits stays NOT NULL. push_to_invoice refuses outright
-- when the contact has no usable phone (Carolyn, 2026-09-01), because signing is phone-OTP —
-- an invoice raised against a contact with no phone could never be signed, while still
-- burning an invoice number and claiming an inventory unit. So there is always a phone to
-- record, and the column keeps its guarantee.
--
-- Constraint name confirmed against live 2026-09-02 (pg_constraint), not assumed:
--   design_acceptances_method_check  CHECK (method = ANY (ARRAY['drawn','typed','click']))

-- 1. The new method. 'rep' joins 'click' in the no-signature bucket: acceptancePdf only
--    appends a certificate page for 'drawn'/'typed', so a rep attestation correctly
--    produces no certificate and asserts no signature.
alter table public.design_acceptances
  drop constraint if exists design_acceptances_method_check;
alter table public.design_acceptances
  add constraint design_acceptances_method_check
  check (method in ('drawn','typed','click','rep'));

-- 2. WHO attested. Resolved server-side from the JWT and never read from the request body —
--    the change_orders.verbal_recorded_by posture (126:55). recorded_by_name is denormalised
--    on purpose: it is evidence, and it must still read correctly years later when the user
--    row has been renamed or removed.
alter table public.design_acceptances
  add column if not exists recorded_by_user_id uuid,
  add column if not exists recorded_by_name    text;

-- 3. A rep attestation can never be anonymous. This is the whole value of the row — an
--    acceptance nobody is named on is worse than no acceptance record at all, because the
--    portal renders it as though the sale were agreed.
alter table public.design_acceptances
  drop constraint if exists design_acceptances_rep_named_check;
alter table public.design_acceptances
  add constraint design_acceptances_rep_named_check
  check (method <> 'rep' or recorded_by_name is not null);

comment on column public.design_acceptances.recorded_by_user_id is
  'method=''rep'' only: the signed-in user who issued the invoice on the customer''s behalf. From the JWT, never the body.';
comment on column public.design_acceptances.recorded_by_name is
  'method=''rep'' only: their name as of the attestation. Denormalised deliberately — this row is evidence.';

-- Every existing row satisfies both new CHECKs (no row has method='rep'), so this applies
-- without a backfill and is inert until portal-settings ships the action.
--
-- ROLLBACK (reverse order). The two CHECK restorations fail loudly if a 'rep' row already
-- exists, which is the intended behaviour — deleting acceptance evidence to fit a schema
-- change is not something a rollback should do quietly.
--   alter table public.design_acceptances drop constraint design_acceptances_rep_named_check;
--   alter table public.design_acceptances drop column recorded_by_name, drop column recorded_by_user_id;
--   alter table public.design_acceptances drop constraint design_acceptances_method_check;
--   alter table public.design_acceptances add  constraint design_acceptances_method_check
--     check (method in ('drawn','typed','click'));
