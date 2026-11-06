// Unit tests for _shared/customerNaming.ts (quote to a business entity, 2026-10-21).
// Dependency-free (no jsr:/npm: imports), like every other _shared/*.test.ts.
// Made-up people and businesses only: this repo is public.
import {
  billTo,
  companyOf,
  displayName,
  ghlContactNameFields,
  greetingFirst,
  NAMING,
  personName,
  qboCustomerNames,
} from "./customerNaming.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}

// The old rules, verbatim from the readers this module replaced: emailTemplates' firstName()
// (oneLine, then split on " ") and submit-estimate's upsert body ({ name: contact?.name || "" }).
const oldFirst = (name: unknown) =>
  String(name ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().split(" ")[0] || "";

const NAMES: unknown[] = [
  "", "   ", "Pat", "Pat Example", "  Pat   Example  ", "pat\tO'Brien\nJr", "Bear River Band",
  "(555) 555-0100", "Zoë Łukasz", 42, null, undefined, { first: "x" },
];

Deno.test("no company: every reader answers exactly what it did before", () => {
  for (const name of NAMES) {
    for (const contact of [{ name }, { name, company: "" }, { name, company: "   " }, { name, company: null }, { name, company: 7 }]) {
      const tag = JSON.stringify(contact);
      assertEquals(greetingFirst(contact), oldFirst(name), `greetingFirst ${tag}`);
      assertEquals(companyOf(contact), "", `companyOf ${tag}`);
      assertEquals(ghlContactNameFields(contact), { name: (contact as { name: unknown }).name || "" }, `ghl ${tag}`);
      assertEquals(qboCustomerNames(contact, "Legacy Name"), { displayName: "Legacy Name", fallbackDisplayName: null, extra: {} }, `qbo ${tag}`);
      assertEquals(billTo(contact).company, "", `billTo.company ${tag}`);
    }
  }
  // A contact that is not an object reads as nobody, never a throw.
  for (const c of [null, undefined, "Pat", 5, []]) {
    assertEquals([greetingFirst(c), personName(c), displayName(c), companyOf(c)], ["", "", "", ""], `junk ${String(c)}`);
  }
});

Deno.test("Bear River Band: the business stops being the greeting", () => {
  const thomas = { name: "Thomas Example", company: "Bear River Band" };
  assertEquals(greetingFirst(thomas), "Thomas");
  assertEquals(personName(thomas), "Thomas Example");
  assertEquals(displayName(thomas), "Bear River Band");
  assertEquals(billTo(thomas), { company: "Bear River Band", attn: "Thomas Example" });
});

Deno.test("a name that only repeats the company means there is no person", () => {
  for (const name of ["Bear River Band", "  bear   river band ", "BEAR RIVER BAND"]) {
    const c = { name, company: "Bear River Band" };
    assertEquals(personName(c), "", name);
    assertEquals(greetingFirst(c), "", `${name}: "Hi there", not "Hi Bear"`);
    assertEquals(billTo(c), { company: "Bear River Band", attn: "" }, name);
  }
  // Only the company: the same.
  assertEquals(greetingFirst({ company: "Bear River Band" }), "");
  assertEquals(displayName({ company: "Bear River Band" }), "Bear River Band");
  assertEquals(NAMING.greetCompanyWhenNoPerson, false, "the plan's default until Carolyn answers");
});

Deno.test("never guesses from the shape of a name", () => {
  // Business-looking names with no company stay what they always were.
  assertEquals(greetingFirst({ name: "Bear River Band" }), "Bear");
  assertEquals(greetingFirst({ name: "First Baptist Church" }), "First");
  assertEquals(displayName({ name: "Bear River Band" }), "Bear River Band");
  // A person whose name merely CONTAINS the company is still a person.
  assertEquals(greetingFirst({ name: "Thomas Band", company: "Band" }), "Thomas");
});

Deno.test("the company is one clean line", () => {
  assertEquals(companyOf({ company: "  Bear\nRiver \t Band  " }), "Bear River Band");
  assertEquals(displayName({ name: "Pat", company: " Acme   Farm " }), "Acme Farm");
});

Deno.test("GoHighLevel: person and business told apart only when there is a company", () => {
  assertEquals(ghlContactNameFields({ name: "Thomas Q Example", company: "Bear River Band" }),
    { firstName: "Thomas", lastName: "Q Example", companyName: "Bear River Band" });
  assertEquals(ghlContactNameFields({ name: "Thomas", company: "Bear River Band" }),
    { firstName: "Thomas", companyName: "Bear River Band" });
  // No person: no first or last name at all, so a name GoHighLevel already holds is never blanked.
  assertEquals(ghlContactNameFields({ name: "Bear River Band", company: "Bear River Band" }), { companyName: "Bear River Band" });
  assertEquals(ghlContactNameFields({ name: "", company: "Bear River Band" }), { companyName: "Bear River Band" });
});

Deno.test("QuickBooks: company as DisplayName, the person as Given/Family, Company (Person) on a clash", () => {
  assertEquals(NAMING.qboDisplayName, "company", "the plan's default until Carolyn answers");
  assertEquals(qboCustomerNames({ name: "Thomas Example", company: "Bear River Band" }, "Thomas Example"), {
    displayName: "Bear River Band",
    fallbackDisplayName: "Bear River Band (Thomas Example)",
    extra: { CompanyName: "Bear River Band", GivenName: "Thomas", FamilyName: "Example" },
  });
  // Company only: no second name to fall back to.
  assertEquals(qboCustomerNames({ name: "", company: "Bear River Band" }, "x@example.test"), {
    displayName: "Bear River Band",
    fallbackDisplayName: null,
    extra: { CompanyName: "Bear River Band" },
  });
  // QuickBooks' limits: CompanyName 100, GivenName/FamilyName 100.
  const long = qboCustomerNames({ name: "A".repeat(150) + " " + "B".repeat(150), company: "C".repeat(150) }, "x");
  assertEquals([long.extra.CompanyName.length, long.extra.GivenName.length, long.extra.FamilyName.length, long.displayName.length], [100, 100, 100, 100]);
});
