// Deliberately dependency-free (no jsr:/npm: imports), like the other _shared tests, so it
// runs on a machine with no registry access. Preflight discovers _shared/*.test.ts itself.
import { customerHomeUrl, myQuotesUrl, portalOrderUrl } from "./customerPortalUrl.ts";

function assertEq(actual: unknown, expected: unknown, msg?: string) {
  if (actual !== expected) {
    throw new Error(`${msg ?? "assertEq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const withOrigin = (origin: string) => new Request("https://edge.example/fn", { method: "POST", headers: { origin } });
const ORDER = "3f2b8c1e-9a4d-4e6f-8b21-5c7d9e0a1b2c";

Deno.test("myQuotesUrl: canonical host without a request, and the tenant is encoded", () => {
  assertEq(myQuotesUrl("junior-barns"), "https://app.structurestudiosuite.com/my-quotes?client=junior-barns");
  assertEq(myQuotesUrl("a b&c"), "https://app.structurestudiosuite.com/my-quotes?client=a%20b%26c");
});

Deno.test("myQuotesUrl: a beta origin stays on beta; anything else falls back to production", () => {
  assertEq(myQuotesUrl("x", withOrigin("https://beta.structurestudiosuite.com")), "https://beta.structurestudiosuite.com/my-quotes?client=x");
  assertEq(myQuotesUrl("x", withOrigin("https://juniorbarns.example.com")), "https://app.structurestudiosuite.com/my-quotes?client=x");
  assertEq(myQuotesUrl("x", withOrigin("not a url")), "https://app.structurestudiosuite.com/my-quotes?client=x");
});

Deno.test("portalOrderUrl: the order deep link, on the same host rule as the customer link", () => {
  assertEq(portalOrderUrl(ORDER), `https://app.structurestudiosuite.com/portal/orders/o-${ORDER}`);
  assertEq(portalOrderUrl(ORDER, withOrigin("https://beta.structurestudiosuite.com")), `https://beta.structurestudiosuite.com/portal/orders/o-${ORDER}`);
  assertEq(portalOrderUrl(ORDER, withOrigin("https://evil.example")), `https://app.structurestudiosuite.com/portal/orders/o-${ORDER}`);
});

Deno.test("portalOrderUrl: no order id, or anything that is not a UUID, lands on the Orders list", () => {
  const list = "https://app.structurestudiosuite.com/portal/orders";
  assertEq(portalOrderUrl(null), list);
  assertEq(portalOrderUrl(undefined), list);
  assertEq(portalOrderUrl(""), list);
  assertEq(portalOrderUrl("1042"), list, "an order_no is not the deep-link key");
  assertEq(portalOrderUrl("../../admin"), list, "never spliced into the path");
  assertEq(portalOrderUrl(`${ORDER}/x`), list);
});

Deno.test("customerHomeUrl: the designer's account panel on the same host rule, quotes by default", () => {
  assertEq(customerHomeUrl("junior-barns"), "https://app.structurestudiosuite.com/?client=junior-barns&account=quotes");
  assertEq(customerHomeUrl("x", withOrigin("https://beta.structurestudiosuite.com"), { view: "invoices" }),
    "https://beta.structurestudiosuite.com/?client=x&account=invoices");
  assertEq(customerHomeUrl("x", withOrigin("https://evil.example"), { ref: "SS-ABC234" }),
    "https://app.structurestudiosuite.com/?client=x&account=quotes&q=SS-ABC234");
  assertEq(customerHomeUrl("a b&c", null, { ref: "SS-ABC234", view: "invoices" }),
    "https://app.structurestudiosuite.com/?client=a%20b%26c&account=invoices&q=SS-ABC234");
});

Deno.test("customerHomeUrl: an unknown view is quotes, and a ref that is not a short code is dropped, never spliced", () => {
  const base = "https://app.structurestudiosuite.com/?client=x&account=quotes";
  assertEq(customerHomeUrl("x", null, { view: "admin" }), base);
  assertEq(customerHomeUrl("x", null, { view: "INVOICES" }), base, "exact match only");
  for (const ref of [null, undefined, "", "abc", "SS-ABC&account=invoices", "../../portal", "a".repeat(33), "SS ABC234"]) {
    assertEq(customerHomeUrl("x", null, { ref }), base, String(ref));
  }
  assertEq(customerHomeUrl("x", null, { ref: "  SS-ABC234 " }), `${base}&q=SS-ABC234`, "surrounding space trimmed");
  // The old link is untouched by the new one.
  assertEq(myQuotesUrl("x"), "https://app.structurestudiosuite.com/my-quotes?client=x");
});
