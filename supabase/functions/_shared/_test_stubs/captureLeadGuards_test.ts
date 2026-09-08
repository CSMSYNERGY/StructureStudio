// capture-lead's abuse guards, tested against the SHIPPED edge-function source.
//
// Why this test exists. capture-lead is a PUBLIC endpoint: anyone holding the browser's anon
// key can call it for any configured tenant. Two properties keep that from being a free hand
// on the tenant's CRM, and both are easy to undo by accident because neither has a visible
// symptom when it breaks:
//
//  1. NOVELTY IS "A FIELD WE DID NOT HAVE", NOT "A FIELD THAT CHANGED". The per-lead debounce
//     lets a request through when it brings something new, so that the gate's name+phone
//     capture is enriched moments later by the Details capture's email+address. Judging that
//     by DIFFERENCE instead of by ABSENCE handed the caller the key: one phone with a rotating
//     name passed on every request, while the per-tenant row count (the other guard) sat at 1
//     because one phone is one row. Written as absence, a single lead can pass at most once
//     per field, ever, whatever the caller sends.
//
//  2. THE GUARDS RUN BEFORE THE WRITES. They used to sit between the local writes and the
//     outbound CRM call, which bounded the CRM call and nothing else — captured_leads,
//     crm_ensure_contact and sms_consent_log each ran once per request, unbounded, for an
//     anonymous caller. Two of those grow a table per request.
//
// Same technique as crmRecordGate_test / wallSlab_test: lift the real expression out of the
// shipped file between stable anchors, guard loudly if the anchors move, then run it. A copy
// of the logic here would keep passing while the real file drifted, which is the one thing
// this test exists to prevent.

import { assert, assertEquals } from "jsr:@std/assert";

// Line endings are normalised because .gitattributes pins eol=lf for .githooks, *.sh, the
// pages, *.compiled.js, *.jsx and the component twin - but NOT for *.ts. On a Windows
// checkout every .ts here is CRLF, so a multi-line anchor below would stop matching and this
// test would fail with "the anchor moved" on a file nobody had touched.
const SRC = (await Deno.readTextFile(
  new URL("../../capture-lead/index.ts", import.meta.url),
)).replace(/\r\n/g, "\n");

// ── 1. The novelty rule, executed ────────────────────────────────────────────────────────
const START = "const addsSomething =";
const i = SRC.indexOf(START);
const j = i < 0 ? -1 : SRC.indexOf(";", i);
if (i < 0 || j < 0) {
  throw new Error(
    "captureLeadGuards_test: could not find the `const addsSomething =` expression in " +
      `supabase/functions/capture-lead/index.ts (start=${i}, end=${j}). The anchor moved — ` +
      "re-point it rather than deleting this test.",
  );
}
const EXPR = SRC.slice(i, j + 1);

type Lead = {
  name?: string | null;
  email?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  source?: string | null;
};
type Req = Partial<Lead> & { source?: string };

const addsSomething = new Function(
  "name",
  "email",
  "street",
  "city",
  "state",
  "zip",
  "source",
  "existingLead",
  `${EXPR}\nreturn addsSomething;`,
) as (
  name: string,
  email: string,
  street: string,
  city: string,
  state: string,
  zip: string,
  source: string,
  existingLead: Lead,
) => boolean;

const run = (req: Req, existing: Lead) =>
  addsSomething(
    req.name ?? "",
    req.email ?? "",
    req.street ?? "",
    req.city ?? "",
    req.state ?? "",
    req.zip ?? "",
    req.source ?? "gate",
    existing,
  );

// A lead the gate has already captured and the Details capture has already enriched: every
// field we ever collect is filled in.
const complete: Lead = {
  name: "A Visitor",
  email: "visitor@example.com",
  street: "1 Main St",
  city: "Springfield",
  state: "MO",
  zip: "65801",
  source: "details",
};

Deno.test("a rotating name on a fully-known lead is not novelty (the guard bypass)", () => {
  // THE REGRESSION. Every one of these passed the debounce when novelty meant "differs".
  assertEquals(run({ name: "A Visitor" }, complete), false);
  assertEquals(run({ name: "Different Name" }, complete), false);
  assertEquals(run({ name: "yet another name" }, complete), false);
});

Deno.test("rotating any other already-known field is not novelty either", () => {
  assertEquals(run({ name: "A Visitor", email: "other@example.com" }, complete), false);
  assertEquals(run({ name: "A Visitor", street: "2 Other St" }, complete), false);
  assertEquals(run({ name: "A Visitor", city: "Elsewhere" }, complete), false);
  assertEquals(run({ name: "A Visitor", state: "KS" }, complete), false);
  assertEquals(run({ name: "A Visitor", zip: "66101" }, complete), false);
});

Deno.test("the enrichment the debounce exists to let through still passes", () => {
  // What the gate leaves behind: name + phone only.
  const fromGate: Lead = { name: "A Visitor", source: "gate" };
  // The Details capture, seconds later, brings the whole contact form.
  assert(run(
    { name: "A Visitor", email: "visitor@example.com", street: "1 Main St", city: "Springfield", state: "MO", zip: "65801", source: "details" },
    fromGate,
  ));
  // Each empty field on its own is enough.
  assert(run({ name: "A Visitor", email: "visitor@example.com" }, fromGate));
  assert(run({ name: "A Visitor", zip: "65801" }, fromGate));
  // "Asked for prices" outranks "passed the gate", and is a one-way transition.
  assert(run({ name: "A Visitor", source: "details" }, fromGate));
  assertEquals(run({ name: "A Visitor", source: "details" }, complete), false);
  // A legacy row with no name at all: filling it is real enrichment.
  assert(run({ name: "A Visitor" }, { ...complete, name: null }));
});

// ── 2. The guards run before the writes ──────────────────────────────────────────────────
const at = (needle: string) => {
  const k = SRC.indexOf(needle);
  if (k < 0) {
    throw new Error(
      `captureLeadGuards_test: "${needle}" is no longer in capture-lead/index.ts. ` +
        "Re-point this anchor rather than deleting the ordering check.",
    );
  }
  return k;
};

Deno.test("both abuse guards are evaluated before any write", () => {
  const debounce = at('reason: "debounced"');
  const volumeCap = at('reason: "rate_limited"');
  const leadUpsert = at('.upsert(leadRow');
  const crmResolve = at('sb.rpc("crm_ensure_contact"');
  const consentInsert = at('from("sms_consent_log").insert(');

  for (const [label, write] of [
    ["captured_leads upsert", leadUpsert],
    ["crm_ensure_contact", crmResolve],
    ["sms_consent_log insert", consentInsert],
  ] as const) {
    assert(debounce < write, `the per-lead debounce must return before the ${label}`);
    assert(volumeCap < write, `the per-tenant volume cap must return before the ${label}`);
  }
});

// ── 3. Consent is filed once per (tenant, phone) ─────────────────────────────────────────
Deno.test("a consent grant is looked up before it is inserted", () => {
  // sms_consent_log is append-only evidence on a public endpoint: without this lookup every
  // repeat tick of the same box grows the table by a row, with no ceiling and no new fact.
  const lookup = at('from("sms_consent_log")\n      .select("id")');
  const insert = at('from("sms_consent_log").insert(');
  assert(lookup < insert, "the prior-grant lookup must run before the insert");
  assert(SRC.includes("if (!priorGrant)"), "the insert must be conditional on there being no prior grant");
});
