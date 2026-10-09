// numberRequestFlags.ts: the operator console's flags on an open "Bring your number" request
// (review 2026-10-09). A builder's request is stored even when another builder holds or asked for the
// same number; the console is where that shows. Made-up tenants and 555-01xx numbers only.
// Run: deno test --node-modules-dir=none supabase/functions/_shared/numberRequestFlags.test.ts

import { requestFlags } from "./numberRequestFlags.ts";

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

const A = { id: "r-a", client_id: "acme-sheds", numbers: ["+18165550101", "+18165550102"] };
const B = { id: "r-b", client_id: "bravo-barns", numbers: ["+18165550102", "+18165550103"] };
const A2 = { id: "r-a2", client_id: "acme-sheds", numbers: ["+18165550101"] };

Deno.test("requestFlags: a number live on ANOTHER builder's account is flagged; the builder's own is not", () => {
  const live = [{ phone_number: "+18165550101", client_id: "bravo-barns" }, { phone_number: "+18165550102", client_id: "acme-sheds" }];
  assertEquals(requestFlags(A, { live, open: [A] }), { liveElsewhere: [{ number: "+18165550101", clientId: "bravo-barns" }], askedElsewhere: [] });
});

Deno.test("requestFlags: another builder's open request for the same number is flagged, once; the builder's own other request is not", () => {
  assertEquals(requestFlags(A, { live: [], open: [A, B, B, A2] }), { liveElsewhere: [], askedElsewhere: [{ number: "+18165550102", clientId: "bravo-barns" }] });
  assertEquals(requestFlags(B, { live: [], open: [A, B] }).askedElsewhere, [{ number: "+18165550102", clientId: "acme-sheds" }]);
});

Deno.test("requestFlags: nothing shared, nothing flagged", () => {
  assertEquals(requestFlags({ id: "r-c", client_id: "charlie-co", numbers: ["+18165550109"] }, { live: [], open: [A, B] }), { liveElsewhere: [], askedElsewhere: [] });
});
