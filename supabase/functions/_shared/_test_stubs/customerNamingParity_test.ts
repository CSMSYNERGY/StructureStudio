// The portal's copy of the customer-naming rules (portal/01-core.jsx, between the
// ⟦customer-naming:start⟧ and ⟦customer-naming:end⟧ markers) answers what
// _shared/customerNaming.ts answers, for every case below. Quote to a business entity, 2026-10-21.
// The block is lifted out of the portal source and run, so this fails when either copy moves alone.
// Made-up names only: this repo is public.
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { billTo, companyOf, displayName, greetingFirst, NAMING, personName } from "../customerNaming.ts";

const CORE = Deno.readTextFileSync(new URL("../../../../portal/01-core.jsx", import.meta.url)).replace(/\r\n/g, "\n");
const start = CORE.indexOf("// ⟦customer-naming:start⟧");
const end = CORE.indexOf("// ⟦customer-naming:end⟧");
const BLOCK = CORE.slice(start, end);

const portal = new Function(`${BLOCK}\nreturn { ssCompanyOf, ssPersonName, ssGreetingFirst, ssDisplayName, ssBillTo, SS_NAMING_GREET_COMPANY };`)();

const NAMES: unknown[] = ["", "  ", "Pat", "Pat Example", "  Pat   Example ", "pat\tO'Brien\nJr", "Bear River Band", "bear river band", 42, null, undefined];
const COMPANIES: unknown[] = [undefined, null, "", "   ", "Bear River Band", " Bear\nRiver  Band ", "Acme Farm", 7];

Deno.test("the portal block is there, between its markers", () => {
  assert(start >= 0 && end > start, "the ⟦customer-naming⟧ markers are gone from portal/01-core.jsx");
  assertEquals(portal.SS_NAMING_GREET_COMPANY, NAMING.greetCompanyWhenNoPerson, "the greeting switch matches");
});

Deno.test("the portal copy answers what the shared module answers", () => {
  const cases: any[] = [null, undefined, "Pat", 5, []];
  for (const name of NAMES) for (const company of COMPANIES) cases.push({ name, company });
  for (const c of cases) {
    const tag = JSON.stringify(c);
    assertEquals(portal.ssCompanyOf(c), companyOf(c), `companyOf ${tag}`);
    assertEquals(portal.ssPersonName(c), personName(c), `personName ${tag}`);
    assertEquals(portal.ssGreetingFirst(c), greetingFirst(c), `greetingFirst ${tag}`);
    assertEquals(portal.ssDisplayName(c), displayName(c), `displayName ${tag}`);
    assertEquals(portal.ssBillTo(c), billTo(c), `billTo ${tag}`);
  }
});

Deno.test("quick sends fill {first_name} from the person, not the company (02-sales.jsx)", () => {
  const SALES = Deno.readTextFileSync(new URL("../../../../portal/02-sales.jsx", import.meta.url));
  assertEquals((SALES.match(/contactName: ssPersonName\(data\.contact\)/g) ?? []).length, 3, "all three quick-send fills");
  assert(!/contactName: data\.contact && data\.contact\.name/.test(SALES), "no fill left on the raw name");
});
