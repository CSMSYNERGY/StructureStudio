-- 165_user_prefs: per-USER portal preferences.
--
-- Carolyn, 2026-08-28 @42:00, on the Pipeline tab's List | Pipeline toggle: "I'm trying to
-- think which I want to have the default. I want them to be able to decide if they want the
-- default. I don't want it to always be list. They can decide to set their default to be
-- pipeline or list, whichever one that they want." And @39:00 on the record cards: "they can
-- put their cards in the order that they want them, and they can have a different order
-- under a contact, and a different order under a deal."
--
-- Ahsan, @42:28: "all of these settings for contact cards, the pipeline cards, and the
-- default one, I think should add, in settings, add another tab ... for structure studio
-- settings."
--
-- ⚠️ PER USER, NOT PER TENANT, and that is the whole reason this is a new column rather than
-- another client_settings field. Two people at the same builder want different defaults --
-- the owner lives in the pipeline board, the office manager lives in the list. A tenant-wide
-- setting would make one of them wrong every morning.
--
-- WHY client_users AND NOT A NEW TABLE. The pm_views precedent (146) is server-side SHARED
-- views, and its header records Carolyn choosing that deliberately: "make the saved views
-- server-side so we all share them." That is a different thing from a personal default --
-- sharing a card order across a team is exactly what she asked against here. client_users is
-- already the per-user row, already RLS'd to the person it belongs to, and already read at
-- boot, so this costs no new policy, no new table and no extra round trip.
--
-- NOT localStorage, which is where usePageSize and the schedule's weekend toggle live. Those
-- are single-screen conveniences; a default view follows you to a different machine, and
-- Carolyn works from more than one.
--
-- Shape is deliberately open (jsonb, no CHECK): { designsView: "list" | "pipeline",
-- cardOrder: { contact: [...], design: [...] } }. Unknown keys are ignored by the reader and
-- an unknown card key is dropped when the order is applied, so an older client cannot be
-- broken by a newer one writing a key it has never heard of.

begin;

alter table public.client_users add column if not exists prefs jsonb;

commit;
