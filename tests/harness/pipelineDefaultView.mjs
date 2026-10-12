// SUPERSEDED (2026-10-12) by contactsHub.mjs, which this now runs.
//
// This harness drove the Pipeline tab's DEFAULT VIEW (Carolyn Q12, 2026-10-06): the List | Pipeline
// toggle and My Profile's "How the Pipeline tab opens". Both are gone: the Pipeline page became tabs
// of the Contacts hub (Carolyn 2026-10-12), and its default became "which tab Contacts opens on".
// Every scenario it held carries on in contactsHub.mjs — the CRM default (A), no CRM (E), a saved
// pick and the old designsView (H), an address naming a view (I), the CRM answer held (G), failed
// (L), and My Profile (K) — so the old name still runs the checks rather than failing on UI that no
// longer exists.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/pipelineDefaultView.mjs      (exit 0 = every check held)
await import("./contactsHub.mjs");
