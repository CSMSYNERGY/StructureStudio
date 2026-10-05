// The per-builder "quotes are good for N days" rules (migration 269). The PDFs print what
// quoteValidDaysOf says, the Settings save writes what parseQuoteValidDays says, and every reader
// goes through readQuoteValidDays, so these three are where "not set", "out of range" and "the
// database has no such column yet" are decided once.
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite runs offline, like the other
// self-contained _shared tests. Tenants are made up (the repo is public).

import {
  parseQuoteValidDays,
  QUOTE_VALID_DAYS_DEFAULT,
  QUOTE_VALID_DAYS_MAX,
  QUOTE_VALID_DAYS_MIN,
  quoteValidDaysOf,
  readQuoteValidDays,
} from "./quoteValidity.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}

Deno.test("the bounds are the column's: default 30, 1 to 365", () => {
  assertEquals([QUOTE_VALID_DAYS_DEFAULT, QUOTE_VALID_DAYS_MIN, QUOTE_VALID_DAYS_MAX], [30, 1, 365]);
});

Deno.test("quoteValidDaysOf: a stored whole number in range prints as itself", () => {
  assertEquals(quoteValidDaysOf(14), 14);
  assertEquals(quoteValidDaysOf(1), 1);
  assertEquals(quoteValidDaysOf(365), 365);
  assertEquals(quoteValidDaysOf("60"), 60, "a numeric string (PostgREST never sends one, but a fixture might)");
});

Deno.test("quoteValidDaysOf: anything else prints the default, never NaN days or a past date", () => {
  for (const v of [null, undefined, 0, -3, 366, 7.5, Number.NaN, Infinity, "", "abc", "14 days", true, {}, []]) {
    assertEquals(quoteValidDaysOf(v), 30, `for ${JSON.stringify(v)}`);
  }
});

Deno.test("parseQuoteValidDays: blank puts the default back; a whole number in range is kept", () => {
  assertEquals(parseQuoteValidDays(""), 30);
  assertEquals(parseQuoteValidDays("   "), 30);
  assertEquals(parseQuoteValidDays(null), 30);
  assertEquals(parseQuoteValidDays(undefined), 30);
  assertEquals(parseQuoteValidDays(14), 14);
  assertEquals(parseQuoteValidDays(" 45 "), 45);
  assertEquals(parseQuoteValidDays("1"), 1);
  assertEquals(parseQuoteValidDays(365), 365);
});

Deno.test("parseQuoteValidDays: refuses (null) what a builder did not mean, rather than coercing it", () => {
  // Number(true) is 1 and Number("7.5") is 7.5: a quiet coercion here would print a date the
  // builder never chose, so each of these is a refusal the save turns into a sentence.
  for (const v of [0, -1, 366, 1000, 7.5, "7.5", "abc", "14 days", "1e2", true, false, {}, [], Number.NaN]) {
    assertEquals(parseQuoteValidDays(v), null, `for ${JSON.stringify(v)}`);
  }
});

/** A client_settings read that answers `answer`, or throws when `answer` is an Error. */
// deno-lint-ignore no-explicit-any
function db(answer: any, seen: string[] = []) {
  return {
    from(table: string) {
      seen.push(table);
      const q = {
        select(cols: string) { seen.push(cols); return q; },
        eq(col: string, val: string) { seen.push(`${col}=${val}`); return q; },
        maybeSingle() {
          if (answer instanceof Error) throw answer;
          return Promise.resolve(answer);
        },
      };
      return q;
    },
  };
}

Deno.test("readQuoteValidDays: the tenant's number, read on its own", async () => {
  const seen: string[] = [];
  assertEquals(await readQuoteValidDays(db({ data: { quote_valid_days: 14 }, error: null }, seen), "acme-sheds"), { days: 14, ok: true });
  assertEquals(seen, ["client_settings", "quote_valid_days", "client_id=acme-sheds"], "one column, one tenant");
});

Deno.test("readQuoteValidDays: a tenant with no settings row reads the default, and the column is there", async () => {
  assertEquals(await readQuoteValidDays(db({ data: null, error: null }), "acme-sheds"), { days: 30, ok: true });
});

Deno.test("readQuoteValidDays: a database without 269 reads 30 and says it could not read", async () => {
  // What PostgREST answers for a column that does not exist yet: 42703 (or PGRST204 on a write).
  const missing = { data: null, error: { code: "42703", message: "column client_settings.quote_valid_days does not exist" } };
  assertEquals(await readQuoteValidDays(db(missing), "acme-sheds"), { days: 30, ok: false });
});

Deno.test("readQuoteValidDays: any other failure, a throw included, reads 30 and never escapes", async () => {
  assertEquals(await readQuoteValidDays(db({ data: null, error: { message: "timeout" } }), "acme-sheds"), { days: 30, ok: false });
  assertEquals(await readQuoteValidDays(db(new Error("socket closed")), "acme-sheds"), { days: 30, ok: false });
  // A stored value the column's CHECK would never allow still prints a sane date.
  assertEquals(await readQuoteValidDays(db({ data: { quote_valid_days: 0 }, error: null }), "acme-sheds"), { days: 30, ok: true });
});
