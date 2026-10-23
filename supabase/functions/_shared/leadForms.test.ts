import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkSubmission, cleanDefinition, cleanSettings, recommendations, starterDefinition, submissionNote } from "./leadForms.ts";

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
