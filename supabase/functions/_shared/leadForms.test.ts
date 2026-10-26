import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkSubmission, cleanDefinition, cleanSettings, customPatch, recommendations, starterDefinition, submissionNote } from "./leadForms.ts";

const SB = "https://example.supabase.co";

Deno.test("cleanDefinition keeps only known fields and drops duplicates and junk", () => {
  const d = cleanDefinition({
    fields: [
      { id: "email", type: "email", label: "Your email", required: true, evil: "<script>" },
      { id: "email", type: "text" },
      { id: "Bad Id", type: "text" },
      { id: "x", type: "not_a_type" },
      { id: "terms", type: "terms", required: false },
      { id: "sms", type: "sms_consent", required: true },
    ],
    style: { width: 99999, colors: { accent: "red; background:url(x)" }, cssClass: "ok-class" },
    theme: "nope",
  }, SB);
  assertEquals(d.fields.map((f) => f.id), ["email", "terms", "sms"]);
  assertEquals((d.fields[0] as unknown as Record<string, unknown>).evil, undefined);
  assertEquals(d.fields[1].required, true, "terms is always required");
  assertEquals(d.fields[2].required, false, "texting consent is never required");
  assertEquals(d.style.width, 1200);
  assertEquals(d.style.colors.accent, "#2563EB");
  assertEquals(d.theme, "clean");
  assertEquals(d.style.cssClass, "ok-class");
});

Deno.test("images must come from the form-assets bucket", () => {
  const good = `${SB}/storage/v1/object/public/form-assets/acme/0b8f5d1c-1234-4cde-9abc-0123456789ab.png`;
  const d = cleanDefinition({ fields: [{ id: "i1", type: "image", imageUrl: good }, { id: "i2", type: "image", imageUrl: "https://evil.example/x.png" }] }, SB);
  assertEquals(d.fields[0].imageUrl, good);
  assertEquals(d.fields[1].imageUrl, "");
});

Deno.test("links are https only", () => {
  const d = cleanDefinition({ footerLinks: { privacy: "javascript:alert(1)", terms: "https://ok.example/terms" } }, SB);
  assertEquals(d.footerLinks.privacy, "");
  assertEquals(d.footerLinks.terms, "https://ok.example/terms");
  const st = cleanSettings({ afterSubmit: { mode: "redirect", redirectUrl: "http://plain.example" } });
  assertEquals(st.afterSubmit.mode, "message", "an unusable redirect falls back to the message");
});

Deno.test("checkSubmission validates, maps contact roles and drops unknown answers", () => {
  const { definition } = starterDefinition("contact", SB);
  const r = checkSubmission(definition, {
    first_name: "Pat", last_name: "Lee", email: "pat@example.com", phone: "816-555-0100",
    message: "Need a 10x12", hacker: "drop me",
  }, { styles: [], sizes: [] });
  assertEquals(Object.keys(r.errors).length, 0);
  assertEquals(r.contact.name, "Pat Lee");
  assertEquals(r.contact.email, "pat@example.com");
  assertEquals(r.answers.some((a) => a.id === "hacker"), false);
});

Deno.test("required fields and bad values are refused", () => {
  const { definition } = starterDefinition("contact", SB);
  const r = checkSubmission(definition, { email: "not-an-email", phone: "12" }, { styles: [], sizes: [] });
  assert(r.errors.first_name);
  assert(r.errors.email);
  assert(r.errors.phone);
});

Deno.test("choices must be one of the field's options or the live catalog", () => {
  const def = cleanDefinition({ fields: [
    { id: "pick", type: "select", options: ["A", "B"] },
    { id: "many", type: "checkboxes", options: ["X", "Y"] },
    { id: "style", type: "building_style" },
  ] }, SB);
  const r = checkSubmission(def, { pick: "C", many: ["X", "Z", "X"], style: "Lofted Barn" }, { styles: ["Lofted Barn"], sizes: [] });
  assertEquals(r.answers.find((a) => a.id === "pick"), undefined);
  assertEquals(r.answers.find((a) => a.id === "many")?.value, "X");
  assertEquals(r.answers.find((a) => a.id === "style")?.value, "Lofted Barn");
});

Deno.test("sms consent is read only from a ticked consent field", () => {
  const def = cleanDefinition({ fields: [{ id: "phone", type: "phone" }, { id: "sms", type: "sms_consent" }] }, SB);
  assertEquals(checkSubmission(def, { phone: "8165550100", sms: true }, { styles: [], sizes: [] }).smsConsent, true);
  assertEquals(checkSubmission(def, { phone: "8165550100" }, { styles: [], sizes: [] }).smsConsent, false);
});

Deno.test("the CRM note lists answers but not the consent ticks", () => {
  const note = submissionNote("Contact us", [
    { id: "a", label: "Name", type: "full_name", value: "Pat" },
    { id: "b", label: "Texts", type: "sms_consent", value: "Yes" },
  ], "https://acme.example/contact");
  assert(note.includes("Name: Pat"));
  assert(!note.includes("Texts"));
  assert(note.includes("Page: https://acme.example/contact"));
});

Deno.test("recommendations flag a form that cannot become a contact, and block an empty one", () => {
  const empty = cleanDefinition({ fields: [{ id: "h", type: "heading" }] }, SB);
  assert(recommendations(empty, null).some((r) => r.id === "no_inputs" && r.blocking));
  const noContact = cleanDefinition({ fields: [{ id: "t", type: "text" }] }, SB);
  assert(recommendations(noContact, null).some((r) => r.id === "no_contact"));
});

// ── A BUILDER'S OWN CONTACT FIELDS ON A FORM (Carolyn 2026-10-25) ──────────────────────────
// The `custom` type binds a question to one of the builder's crm_field_defs by `key`. These tests
// are the whitelist's teeth: the key is never carried on trust from the payload, and the field
// cannot hold a value its type refuses.
const DEFS = [
  { key: "lot_number", field_type: "text", label: "Lot number" },
  { key: "budget", field_type: "number", label: "Budget" },
  { key: "visit_on", field_type: "date", label: "Site visit" },
  { key: "surface", field_type: "select", choices: ["Gravel", "Concrete"], label: "Surface" },
  { key: "gate_code_known", field_type: "checkbox", label: "Knows the gate code" },
  { key: "county_site", field_type: "url", label: "County website" },
];
const CF = (id: string, key: string, fieldType: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: "custom", key, fieldType, ...extra });

Deno.test("a custom field whose key the register no longer lists is dropped", () => {
  const d = cleanDefinition({ fields: [CF("a", "lot_number", "text"), CF("b", "deleted_field", "text")] }, SB, DEFS);
  assertEquals(d.fields.map((f) => f.id), ["a"]);
  assertEquals(d.fields[0].key, "lot_number");
  // An archived definition is simply not in the list portal-settings builds, so it drops the
  // same way a deleted one does.
  assertEquals(cleanDefinition({ fields: [CF("a", "lot_number", "text")] }, SB, []).fields.length, 0);
});

Deno.test("a key belonging to another tenant is dropped", () => {
  // `defs` is the TENANT'S OWN register (portal-settings selects it by client_id), so another
  // builder's key simply is not in it — the only way a key is ever accepted.
  const theirs = [{ key: "their_secret_field", field_type: "text", label: "Theirs" }];
  const d = cleanDefinition({ fields: [CF("x", "their_secret_field", "text"), CF("y", "lot_number", "text")] }, SB, theirs);
  assertEquals(d.fields.map((f) => f.key), ["their_secret_field"]);
  // ...and the same payload against this tenant's register keeps the other field instead.
  const e = cleanDefinition({ fields: [CF("x", "their_secret_field", "text"), CF("y", "lot_number", "text")] }, SB, DEFS);
  assertEquals(e.fields.map((f) => f.key), ["lot_number"]);
});

Deno.test("a malformed key or an unknown field type never becomes a field", () => {
  const d = cleanDefinition({
    fields: [
      CF("a", "Lot Number", "text"), // not the key shape (330's key CHECK)
      CF("b", "__proto__", "text"), // nor is this
      CF("c", "9lives", "text"), // a key must start with a letter
      { id: "d", type: "custom", fieldType: "text" }, // no key at all
      CF("f", "lot_number", "text"), // the only good one
    ],
  }, SB, DEFS);
  assertEquals(d.fields.map((f) => f.id), ["f"]);

  // A type that is not one of the eight is dropped when nothing else can say what the field is...
  assertEquals(cleanDefinition({ fields: [CF("e", "lot_number", "colour")] }, SB).fields.length, 0);
  // ...but with the register in hand the REGISTER decides the type, so a payload that names a
  // nonsense one is overruled rather than obeyed. That is the same rule as the test below: what
  // Settings → Fields says the field is, it is.
  const over = cleanDefinition({ fields: [CF("e", "lot_number", "colour")] }, SB, DEFS);
  assertEquals(over.fields.map((f) => f.fieldType), ["text"]);
});

Deno.test("the register is authority on a custom field's type and choices", () => {
  // A field re-typed or re-worded in Settings → Fields must reach every form already using it,
  // and a stored choice the register has since dropped must not stay on the drop-down.
  const d = cleanDefinition({
    fields: [CF("s", "surface", "text", { options: ["Gravel", "Dirt", "Anything"], label: "" })],
  }, SB, DEFS);
  assertEquals(d.fields[0].fieldType, "select");
  assertEquals(d.fields[0].options, ["Gravel", "Concrete"]);
  assertEquals(d.fields[0].label, "Surface"); // falls back to the definition's own label
});

Deno.test("omitting the register keeps a shape-valid custom field", () => {
  // THE NO-SILENT-WIPE GUARANTEE. cleanDefinition runs on read as well as on write; if an omitted
  // register meant "drop", one forgotten read path would strip a builder's fields off a saved form
  // and the next save would write the stripped copy back.
  const d = cleanDefinition({ fields: [CF("a", "lot_number", "text"), CF("b", "whatever_key", "number")] }, SB);
  assertEquals(d.fields.map((f) => f.key), ["lot_number", "whatever_key"]);
  // The shape is still enforced without it.
  assertEquals(cleanDefinition({ fields: [CF("a", "Not A Key", "text")] }, SB).fields.length, 0);
});

Deno.test("a typed custom field refuses a value it cannot hold", () => {
  const def = cleanDefinition({
    fields: [
      CF("n", "budget", "number"),
      CF("d", "visit_on", "date"),
      CF("s", "surface", "select"),
      CF("u", "county_site", "url"),
    ],
  }, SB, DEFS);
  const bad = checkSubmission(def, { n: "about ten grand", d: "next tuesday", s: "Dirt", u: "javascript:alert(1)" }, { styles: [], sizes: [] });
  assertEquals(bad.errors.n, "Enter a number.");
  assertEquals(bad.errors.d, "Enter a date.");
  assertEquals(bad.errors.u, "Enter a website address.");
  // An off-list choice is not an error, it is simply not an answer (the built-in selects' rule).
  assertEquals(bad.answers.some((a) => a.id === "s"), false);

  const good = checkSubmission(def, { n: "12,500", d: "2026-11-02", s: "Concrete", u: "county.example.gov" }, { styles: [], sizes: [] });
  assertEquals(good.errors, {});
  assertEquals(good.answers.map((a) => a.value), ["12,500", "2026-11-02", "Concrete", "county.example.gov"]);
  // ⛔ A custom field never carries a contact ROLE, so nothing it collects can reach a built-in
  // column. This is the assertion that fails if somebody ever gives the type a role. (`name` is
  // present-but-undefined on every Contact: checkSubmission always assigns the joined-names
  // fallback, which is undefined when there are no name fields.)
  assertEquals(Object.entries(good.contact).filter(([, v]) => v !== undefined), []);
});

Deno.test("a custom tick box answers Yes or not at all", () => {
  const def = cleanDefinition({ fields: [CF("g", "gate_code_known", "checkbox")] }, SB, DEFS);
  assertEquals(checkSubmission(def, { g: true }, { styles: [], sizes: [] }).answers[0].value, "Yes");
  assertEquals(checkSubmission(def, { g: false }, { styles: [], sizes: [] }).answers.length, 0);
  const req = cleanDefinition({ fields: [CF("g", "gate_code_known", "checkbox", { required: true })] }, SB, DEFS);
  assertEquals(checkSubmission(req, {}, { styles: [], sizes: [] }).errors.g, "This field is required.");
});

Deno.test("customPatch enriches, coerces, and never clobbers what the contact already holds", () => {
  const def = cleanDefinition({
    fields: [
      CF("n", "budget", "number"),
      CF("l", "lot_number", "text"),
      CF("g", "gate_code_known", "checkbox"),
      CF("s", "surface", "select"),
    ],
  }, SB, DEFS);
  const checked = checkSubmission(def, { n: "12,500", l: "B-14", g: true, s: "Gravel" }, { styles: [], sizes: [] });

  // Nothing on the contact yet: everything lands, each coerced to what its field stores.
  assertEquals(customPatch(def, checked.answers, DEFS, {}), {
    budget: 12500,
    lot_number: "B-14",
    gate_code_known: true,
    surface: "Gravel",
  });

  // A key the contact already has a value for is LEFT ALONE; a blank one is still filled.
  assertEquals(customPatch(def, checked.answers, DEFS, { lot_number: "A-1", budget: null, surface: "" }), {
    budget: 12500,
    gate_code_known: true,
    surface: "Gravel",
  });
  // false is a VALUE, not a blank: a contact whose tick box says "no" is not re-ticked by a form.
  assertEquals(customPatch(def, checked.answers, DEFS, { gate_code_known: false }).gate_code_known, undefined);

  // A definition archived between publish and submit stores nothing, though the answer is still
  // in the submission and in the note.
  assertEquals(customPatch(def, checked.answers, DEFS.filter((d) => d.key !== "budget"), {}).budget, undefined);
  assertEquals(customPatch(def, checked.answers, [], {}), {});
});
