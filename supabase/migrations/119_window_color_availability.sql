-- 119_window_color_availability: not every window comes in every color. Each window
-- fixture can now carry the subset of the client's window_colors it is offered in.
--
--   NULL  = ALL active window colors (the default — existing windows keep offering
--           everything, and a window-color added later automatically appears on every
--           unrestricted window)
--   array = exactly these color ids (a color added later does NOT silently appear on a
--           restricted window; the owner ticks it on deliberately)
--   {}    = no colors (the window places with no color choice, like before 116)
--
-- The portal editor shows one checkbox per client window color (all ticked by default)
-- and stores NULL when every box is ticked, so "comes in all my colors" stays a living
-- statement rather than a frozen list. Ids that stop existing (color deleted) are simply
-- never matched — harmless, no FK needed on an array column.

alter table public.fixture_items add column if not exists window_color_ids uuid[];
