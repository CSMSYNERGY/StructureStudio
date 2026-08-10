-- 105_settings_audit_release_notes: What's New entries for the 2026-08-07/08 Settings
-- audit fixes (commits b3c6777, 9da5a18, 8b6a91c, c399cbe/5441d85, 57b4549, dafdbfd).
--
-- WHAT IS DELIBERATELY ABSENT, per CLAUDE.md's release-note rule (Carolyn 2026-07-26):
--   * The billing_plans price redaction (migration 102). Pricing VISIBILITY is exactly the
--     thing that rule names — announcing "unpublished prices are now really hidden" tells
--     every tenant to go look at what they can no longer see and anchors them to whatever
--     they last saw. Ships silently.
--   * The operator lockout on portal-commissions. Internal posture: "operators can no
--     longer change your commissions" invites the question of what operators could do
--     before. Ships silently.
--   * Validation caps, the dead-endpoint deletion, and the GHL error-body redirection —
--     none of them is something a tenant can USE.
--
-- The beta-mode entry is worded as what the switch DOES NOW. It is kind 'fix' because the
-- control existed and its label already made this promise; calling it a new feature would
-- be false in the other direction. The detail deliberately spells out the refuse-if-unset
-- behaviour — a tenant who flips it on and gets a refused submission should recognise the
-- message as designed, not as a bug to report.
--
-- status = 'beta' (migration 103): this code is on beta and not yet on main. The Monday
-- merge workflow flips these to 'shipped' — do not hand-set 'shipped'.
--
-- Hand-apply via the SQL editor / MCP and record as version 105 — NEVER `supabase db push`.

insert into public.release_notes (released_at, kind, title, detail, status, sort_order)
values
  (current_date, 'fix',
   'Beta mode now really sends estimates to your test inbox',
   'Turn on Beta mode (Settings → Branding → Testing) with a test inbox and every estimate '
   || 'email goes there instead of to the customer — so you can try changes end-to-end '
   || 'without a real lead ever seeing a test quote. It refuses to send at all if beta mode '
   || 'is on but no working inbox is set, rather than quietly falling back to the customer. '
   || 'Remember to turn it off when you finish testing: while it is on, your customers '
   || 'receive nothing.',
   'beta', 10),

  (current_date, 'feature',
   'Let customers type their own color',
   'Colors (Settings → Colors) now has a Custom switch. Tick it on one entry per palette — '
   || 'name it something like "Other — my own color" — and when a customer picks it in the '
   || 'designer, the swatch list swaps for a text box so they can ask for a color you don''t '
   || 'stock. One entry per palette can be the custom one; ticking a second unticks the first.',
   'beta', 20),

  (current_date, 'fix',
   'Hand a truck to a different driver without rebuilding it',
   'The driver on a truck (Settings → Team) is a dropdown again, on existing trucks too. '
   || 'Before, the person was locked in once the truck was saved — reassigning it meant '
   || 'deleting the driver and re-entering the truck, deck, width and territories by hand. '
   || 'Pick the new person and save; the truck and its territories go with it.',
   'beta', 30),

  (current_date, 'fix',
   'Editing a crew or territory no longer un-archives it',
   'Renaming or recoloring a crew or delivery territory used to quietly restore it if it '
   || 'was archived, and knock it to the front of the list order. Edits now leave the '
   || 'archived state and the order exactly as they were.',
   'beta', 40),

  (current_date, 'feature',
   'Remove your designer logo',
   'The logo on your customer designer link (Settings → Branding) has a Remove button. It '
   || 'stages the change so you can see the preview and undo before saving; once saved, the '
   || 'designer shows your company initials until you upload a new one.',
   'beta', 50),

  (current_date, 'fix',
   'Error messages you can actually act on',
   'When a save or load fails in Settings, you now get a plain sentence about what '
   || 'couldn''t happen — with a short reference like "save that style" — instead of raw '
   || 'database text. Quote the reference to support and they can find the exact failure. '
   || 'Permission switches on the Team tab also work by keyboard now, not just mouse.',
   'beta', 60);
