-- 102_scheduling_release_notes: LAUNCH SWITCH 2 for the scheduling suite.
--
-- Switch 1 (billing_plans -> 'available', migration 094) is already live, so tenants can
-- subscribe to "Schedule Builds and Delivery" today and nothing in the product tells them
-- it exists. This is the announcement.
--
-- ⚠️ NOT AUTO-APPLIED. This publishes to the What's New tab of EVERY tenant at once — the
-- same class of action as sending mail. A human runs it, deliberately, when the team is
-- ready for the questions it will generate.
--
-- NO PRICING, deliberately (CLAUDE.md's release-note rule, Carolyn 2026-07-26): a release
-- note describes what a tenant can now DO. Anything about what we charge, or about what we
-- are willing to show of what we charge, ships silently.
--
-- released_at is the launch date, not the build date — set it to the day you publish.

insert into public.release_notes (released_at, kind, title, detail, status, sort_order)
values
  (current_date, 'feature',
   'Build Schedule — every building from order to done',
   'Plan your shop on a calendar. Drag a sold order, an inventory build, or a repair onto '
   || 'the day you will build it, and flip between each crew''s own calendar to see what '
   || 'they have on. Name your own build stages to match how your shop actually works — '
   || 'add "Paint" or "Materials Pulled" if that is how you run. Every card carries the '
   || 'building, its size, colors and customer at a glance, and every move is logged with '
   || 'who did it and when.',
   'shipped', 10),

  (current_date, 'feature',
   'Delivery Schedule — plan the truck, not just the date',
   'Deliveries are planned as loads: one driver, one day, one route. Buildings waiting to '
   || 'go out are grouped by the territory they are headed to and sorted by when they are '
   || 'ready, so a load almost plans itself. Each load shows how much deck space is used '
   || 'against that driver''s trailer, flags wide loads automatically from the building''s '
   || 'real dimensions, and will not let a building go out before it is built.',
   'shipped', 20),

  (current_date, 'feature',
   'Repairs — from the phone call to the fix',
   'Log a repair while the customer is still on the phone, with photos and a quote. Look '
   || 'the building up by its serial number or design code — or mark it as not one of '
   || 'yours, because you fix other people''s buildings too. Send the work to the Build '
   || 'Schedule if it is coming to the shop, or add it to a delivery load if you are going '
   || 'out to it. Every building keeps its full service history.',
   'shipped', 30);

-- Rollback:
--   delete from public.release_notes
--    where title in ('Build Schedule — every building from order to done',
--                    'Delivery Schedule — plan the truck, not just the date',
--                    'Repairs — from the phone call to the fix');
