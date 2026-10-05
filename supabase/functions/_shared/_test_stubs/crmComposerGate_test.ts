// The CRM record page's COMPOSERS follow their tab's enabled state, pinned against the SHIPPED
// portal source (2026-10-04).
//
// crmRecordGate_test proves each tab's `enabled` predicate. What it cannot see is the panel
// under the tab bar: those render on the remembered `tab` state, and `tab` starts on "note".
// So a contact opened with no deal picked drew a live note box beneath a greyed Notes tab whose
// hint says "Pick a deal … first", and Save filed the note with shortCode null — the exact
// thing the picker exists to stop. Clearing a pick, or picking a not-yet-accepted deal while
// Invoice was open, left the old panel live the same way.
//
// Each composer must therefore also ask `tabOn(<its key>)`, the tab's own predicate. If an
// anchor moves, re-point it — do not delete the test.

import { assert } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(new URL("../../../../portal/02-sales.jsx", import.meta.url));

Deno.test("tabOn reads the tab's own when + enabled", () => {
  const i = SRC.indexOf("const tabOn = (key) => {");
  assert(i >= 0, "tabOn is gone from CrmRecord — re-point this test");
  const body = SRC.slice(i, SRC.indexOf("};", i));
  assert(/CRM_TABS\.find/.test(body) && /\.when\(ctx\)/.test(body) && /\.enabled\(ctx\)/.test(body),
    "tabOn no longer asks the tab's own when/enabled");
});

Deno.test("every composer panel is gated on tabOn for its own key", () => {
  for (const key of ["note", "activity", "email", "sms", "files", "invoice"]) {
    const re = new RegExp(`\\{tab === "${key}" && ([^\\n]*)`, "g");
    const hits = [...SRC.matchAll(re)];
    assert(hits.length > 0, `no {tab === "${key}"} panel found — re-point this test`);
    for (const m of hits) {
      assert(m[1].includes(`tabOn("${key}")`), `the ${key} panel renders without tabOn("${key}"): ${m[0].slice(0, 120)}`);
    }
  }
});
