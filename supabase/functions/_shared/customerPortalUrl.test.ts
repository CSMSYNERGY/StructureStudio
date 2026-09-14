// Deliberately dependency-free (no jsr:/npm: imports), like the other _shared tests, so it
// runs on a machine with no registry access. Preflight discovers _shared/*.test.ts itself.
import { myQuotesUrl, portalOrderUrl } from "./customerPortalUrl.ts";

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
