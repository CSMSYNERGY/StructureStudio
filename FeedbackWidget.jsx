// ─── MOVED (2026-07-26) — this module is intentionally empty ───
//
// The bug / feature feedback widget used to live here: a floating button that opened
// two Monday.com WorkForms in an iframe. It was imported by StructureStudio.jsx and
// hand-inlined into structure-studio.component.js, and rendered on the PUBLIC designer
// (`{!embedded && <FeedbackWidget />}`) — i.e. to anonymous shed-shoppers on a tenant's
// customer-facing page, and nowhere in the owner portal.
//
// Two problems with that:
//   1. An iframe to Monday leaves NO record on our side. A tenant who filed something
//      had no way to confirm it landed or to see what came of it.
//   2. There is no signed-in user on the public designer, so a submission could not be
//      attributed to a person or a tenant.
//
// It now lives in portal.html only, as three components: FeedbackForm, FeedbackWidget
// and MySubmissions. Submissions go through the `portal-feedback` edge function, which
// resolves the tenant + submitter from the JWT (never from the request body), records
// the row in `feedback_submissions`, and then creates the Monday item. Status changes
// and /client-marked replies come back via the `feedback-monday-webhook` function.
// Tenants track it all under What's New → My Submissions.
//
// See migration 054_feedback_submissions.sql for the data model and its trust boundary.
//
// This file is kept only as a signpost — nothing imports it. Safe to delete.

export {};
