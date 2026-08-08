// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
import { addressFrom, hasDestination, territoryFor } from "./contactAddress.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}

Deno.test("addressFrom reads the current key names", () => {
  assertEquals(
    addressFrom({ name: "Ann", street: "12 Oak Rd", city: "West Salem", state: "Ohio", zip: "44287" }),
    { street: "12 Oak Rd", city: "West Salem", state: "Ohio", zip: "44287" },
  );
});

Deno.test("addressFrom falls back to the legacy key names", () => {
  // Older designs wrote `address`/`postalCode`. Missing these is not an error anyone sees —
  // it is a stop with no destination — so the fallback is pinned.
  assertEquals(
    addressFrom({ address: "9 Mill St", city: "Rolla", state: "MO", postalCode: "65401" }),
    { street: "9 Mill St", city: "Rolla", state: "MO", zip: "65401" },
  );
});

Deno.test("addressFrom prefers the current names when a row carries both", () => {
  const a = addressFrom({ street: "new", address: "old", zip: "11111", postalCode: "22222" });
  assertEquals([a.street, a.zip], ["new", "11111"]);
});

Deno.test("addressFrom survives null, undefined and blank strings", () => {
  const empty = { street: null, city: null, state: null, zip: null };
  assertEquals(addressFrom(null), empty);
  assertEquals(addressFrom(undefined), empty);
  assertEquals(addressFrom({}), empty);
  // Whitespace is not an address: it would otherwise pass a truthiness check and produce a
  // stop that looks addressed and cannot be delivered to.
  assertEquals(addressFrom({ street: "   ", city: "\t", zip: "" }), empty);
});

Deno.test("addressFrom trims", () => {
  assertEquals(addressFrom({ city: "  Linn  " }).city, "Linn");
});

Deno.test("hasDestination needs a city or a zip, not a street", () => {
  assertEquals(hasDestination(addressFrom({ city: "Linn" })), true);
  assertEquals(hasDestination(addressFrom({ zip: "65051" })), true);
  assertEquals(hasDestination(addressFrom({ street: "12 Oak Rd" })), false);
  assertEquals(hasDestination(addressFrom({})), false);
});

Deno.test("territoryFor prefers zip over city", () => {
  // Springfield exists in ~35 states; the postcode does not. If city won, a Springfield MO
  // load would collect stops from Springfield IL.
  const t = territoryFor(
    addressFrom({ city: "Springfield", zip: "65801" }),
    { "65801": "west-id" },
    { springfield: "east-id" },
  );
  assertEquals(t, "west-id");
});

Deno.test("territoryFor matches city case- and space-insensitively", () => {
  assertEquals(territoryFor(addressFrom({ city: "  KANSAS city " }), {}, { "kansas city": "west-id" }), "west-id");
});

Deno.test("territoryFor returns null rather than guessing", () => {
  assertEquals(territoryFor(addressFrom({ city: "Nowhere" }), {}, { linn: "x" }), null);
  assertEquals(territoryFor(addressFrom({}), { "65051": "x" }, { linn: "x" }), null);
});
