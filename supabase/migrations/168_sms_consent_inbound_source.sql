-- 168_sms_consent_inbound_source.sql
-- Lets an INBOUND message be recorded as consent, which is the thing that makes enforcing
-- consent survivable.
--
-- APPLY BY HAND. NEVER `supabase db push`.
--
-- ⚠️ WHY THIS EXISTS AT ALL. Enforcing consent at send time (smsSend) refuses anyone with no
-- 'granted' record. Without this source, a customer who TEXTS THE BUILDER FIRST could not be
-- replied to — the builder would watch a message arrive and be told they lack permission to
-- answer it. That is absurd on its face, and it is also not what the law says: a person who
-- initiates a conversation has consented to that conversation.
--
-- So sms-inbound records 'sms_inbound' consent on a genuine inbound message. Deliberately a
-- DISTINCT source from 'sms_start': START is an explicit opt-in keyword, this is implied
-- consent from the act of writing to us, and an auditor should be able to tell them apart.
alter table public.sms_consent_log drop constraint if exists sms_consent_log_source_chk;
alter table public.sms_consent_log add constraint sms_consent_log_source_chk
  check (source in ('web_form','sms_start','sms_stop','sms_inbound','operator','import'));
