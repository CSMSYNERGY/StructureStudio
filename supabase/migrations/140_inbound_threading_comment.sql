-- 140_inbound_threading_comment.sql — correct a comment that documents a join which cannot
-- execute. COMMENTS ONLY: no table, column, index, policy or grant changes anywhere.
--
-- Migration 135 shipped this on public.email_inbound:
--
--   'Matched to a contact/design by In-Reply-To against email_sends.provider_message_id,
--    falling back to the sender address.'
--
-- and repeated it inline above the `in_reply_to` column: "we store our own provider id on
-- email_sends.provider_message_id at send time, so this is the join that puts a reply back
-- on the right design."
--
-- THAT JOIN HAS NEVER MATCHED A SINGLE ROW, and it never could. `provider_message_id` is
-- written from Resend's send-API `id` — a bare uuid (`4ef9a417-02e9-…`). In-Reply-To always
-- carries an RFC 5322 Message-ID, which by definition ends `@domain`. `_shared/emailInbound.ts`
-- `messageIds()` strips only the angle brackets and keeps the `local@domain` form, so the
-- webhook compared "has an @" against "has no @". A string equality between those two shapes
-- is unsatisfiable. Both sides are pinned by existing tests that never met each other:
-- emailInbound.test.ts asserts the parsed output shape `a@x.com`, emailSend.test.ts asserts
-- the stored value `rs-msg-1`.
--
-- Nothing failed loudly, which is why it survived: the reply token in the local part covered
-- the case everyone tested, and the header path only runs when the token path found nothing
-- — exactly the population it was written to rescue (mail sent before a tenant configured
-- inbound, and clients like Outlook that rewrite References).
--
-- WHAT REPLACES IT. sendTenantEmail now sets a Message-ID we generate ourselves
-- (`buildThreadMessageId`), which is self-describing:
--
--   <ss.junior-barns.d.ss-9r8uhjgtdj.k3f9x2@jrbarns.com>
--
-- so a reply routes by PARSING the echoed id, with no database join at all. `client_id` is
-- carried inside it purely so the webhook can verify it against the tenant the SMTP envelope
-- already proved — a Message-ID is echoed back to the customer and is therefore
-- attacker-visible, so it narrows within a tenant and must never select one.
--
-- `provider_message_id` keeps its real job: matching Resend's delivery/bounce events, which
-- carry that same API id. It was only ever wrong as a THREADING key.
--
-- Rollback: restore the two comments from 135. There is no data or structure to revert.

comment on table public.email_inbound is
  'Customer replies, so the record page shows a conversation rather than a monologue. '
  'ATTRIBUTION IS TWO-STAGE and the order is a security property: the TENANT is resolved '
  'from the SMTP envelope recipient alone (client_settings.inbound_domain with '
  'inbound_status = ''active'', else email_domain), because the To: header, the reply token, '
  'a Message-ID and the sender address are all attacker-controlled. Only then is the '
  'design/contact chosen WITHIN that tenant, by the reply token, then our own threading '
  'Message-ID, then the sender address. An UNMATCHED reply is still stored — see '
  'email_inbound_unmatched_idx.';

comment on column public.email_inbound.in_reply_to is
  'Message-ID of the mail being answered. Matched by PARSING our self-describing threading '
  'id (ss.<client>.<d|c>.<id>.<rand>@<domain>, built in _shared/emailInbound.ts), NOT by '
  'joining email_sends.provider_message_id — that column holds the provider API id, which '
  'has no @ and can never equal an RFC 5322 Message-ID. See this migration''s header.';

comment on column public.email_sends.provider_message_id is
  'The provider''s own send id, for matching delivery/bounce webhook events. NOT a threading '
  'key: it is a bare uuid and can never equal an RFC 5322 Message-ID. See migration 140.';
