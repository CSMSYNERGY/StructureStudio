// Unit tests for paymentSettings.ts: which merchant account a builder takes cards on (workstream 1
// phase 3, migration 296).
//
// The rules held here are the ones that decide where money goes, and each fails quietly:
//   * no merchant id is NO merchant. Never a default (the old CARDPOINTE_MERCHID fallback took a
//     MID-less builder's customers' cards into the platform's own account);
//   * a missing system (a row or attempt from before 296) is UAT, the system every charge before it
//     went to; an UNKNOWN system is no merchant at all, never a guess;
//   * the tolerant read asks again without cardpointe_env only when the database says that column
//     is missing, and returns every other error as it is.
//
// Dependency-free (no jsr:/npm: imports), like the other _shared tests. Merchant ids are made up.

import { cpEnvOf, cpMerchant, isMissingColumn, midLast4, readPaymentSettings } from "./paymentSettings.ts";

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

Deno.test("cpEnvOf: null/undefined is uat, uat and prod as named, anything else is unrecognised", () => {
  const cases: [unknown, string | null][] = [
    [null, "uat"], [undefined, "uat"], ["uat", "uat"], ["prod", "prod"],
    ["", null], ["live", null], ["test", null], ["PROD", null], [" prod", null], [1, null], [true, null], [{}, null],
  ];
  for (const [raw, want] of cases) check(`cpEnvOf(${JSON.stringify(raw)})`, cpEnvOf(raw) === want, String(cpEnvOf(raw)));
});

Deno.test("cpMerchant: the row's own MID and system, and nothing when either is missing or unknown", () => {
  check("uat", same(cpMerchant({ cardpointe_merchid: "100200300400", cardpointe_env: "uat" }), { merchid: "100200300400", env: "uat" }));
  check("prod, trimmed", same(cpMerchant({ cardpointe_merchid: " 100200300500 ", cardpointe_env: "prod" }), { merchid: "100200300500", env: "prod" }));
  check("no env column (pre-296) is uat", same(cpMerchant({ cardpointe_merchid: "100200300400" }), { merchid: "100200300400", env: "uat" }));
  for (const mid of [null, undefined, "", "   ", 100200300400]) {
    check(`no merchant for MID ${JSON.stringify(mid)}`, cpMerchant({ cardpointe_merchid: mid, cardpointe_env: "uat" }) === null);
  }
  check("an unknown system is no merchant", cpMerchant({ cardpointe_merchid: "100200300400", cardpointe_env: "live" }) === null);
  check("no row", cpMerchant(null) === null && cpMerchant(undefined) === null && cpMerchant("x") === null);
});

Deno.test("midLast4 never hands out more than four digits", () => {
  check("12 digits", midLast4("100200300400") === "0400");
  check("trimmed", midLast4(" 100200300401 ") === "0401");
  check("short", midLast4("123") === null);
  check("none", midLast4(null) === null && midLast4("") === null && midLast4(100200300400) === null);
});

Deno.test("isMissingColumn: 42703 and PGRST204 only", () => {
  check("42703", isMissingColumn({ code: "42703" }));
  check("PGRST204", isMissingColumn({ code: "PGRST204" }));
  for (const e of [{ code: "57014" }, { code: "23505" }, { message: "column x does not exist" }, null, undefined, "42703"]) {
    check(`not ${JSON.stringify(e)}`, !isMissingColumn(e));
  }
});

/** A one-table fake: answers each client_settings read in turn, and records the columns asked for. */
// deno-lint-ignore no-explicit-any
function fakeAdmin(answers: any[], asked: string[]) {
  return {
    from(table: string) {
      check("only client_settings", table === "client_settings", table);
      let cols = "";
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select(c: string) { cols = c; return q; },
        eq(col: string, v: unknown) { check("scoped to the tenant", col === "client_id" && v === "acme-sheds", `${col}=${v}`); return q; },
        maybeSingle() { asked.push(cols); return Promise.resolve(answers.shift()); },
      };
      return q;
    },
  };
}

Deno.test("readPaymentSettings asks for the switch, the MID, the system and the extras, in one read", async () => {
  const asked: string[] = [];
  const r = await readPaymentSettings(fakeAdmin([{ data: { payments_online_enabled: true, cardpointe_merchid: "100200300400", cardpointe_env: "prod", billing_exempt: false }, error: null }], asked), "acme-sheds", ["billing_exempt"]);
  check("one read", asked.length === 1 && asked[0] === "payments_online_enabled, cardpointe_merchid, billing_exempt, cardpointe_env", JSON.stringify(asked));
  check("the row", r.row?.cardpointe_env === "prod" && r.error === null && r.envColumn === true, JSON.stringify(r));
  const none = await readPaymentSettings(fakeAdmin([{ data: null, error: null }], []), "acme-sheds");
  check("no row is null, not an error", none.row === null && none.error === null, JSON.stringify(none));
});

Deno.test("readPaymentSettings on a database WITHOUT 296 asks again without the column, and the row reads uat", async () => {
  const asked: string[] = [];
  const r = await readPaymentSettings(fakeAdmin([
    { data: null, error: { code: "42703", message: "column client_settings.cardpointe_env does not exist" } },
    { data: { payments_online_enabled: true, cardpointe_merchid: "100200300400" }, error: null },
  ], asked), "acme-sheds");
  check("two reads, the second without cardpointe_env", asked.length === 2 && !asked[1].includes("cardpointe_env"), JSON.stringify(asked));
  check("envColumn false", r.envColumn === false && r.error === null, JSON.stringify(r));
  check("cardpointe_env null, so uat", r.row?.cardpointe_env === null && same(cpMerchant(r.row), { merchid: "100200300400", env: "uat" }), JSON.stringify(r.row));
});

Deno.test("readPaymentSettings returns any OTHER error as it is, and never asks again", async () => {
  const asked: string[] = [];
  const err = { code: "57014", message: "canceling statement due to statement timeout" };
  const r = await readPaymentSettings(fakeAdmin([{ data: null, error: err }, { data: { cardpointe_merchid: "100200300400" }, error: null }], asked), "acme-sheds");
  check("one read", asked.length === 1, JSON.stringify(asked));
  check("the error, no row", r.error === err && r.row === null, JSON.stringify(r));
  // A second read that fails is returned too, not turned into "no row".
  const r2 = await readPaymentSettings(fakeAdmin([{ data: null, error: { code: "42703" } }, { data: null, error: err }], []), "acme-sheds");
  check("second failure returned", r2.error === err && r2.row === null && r2.envColumn === false, JSON.stringify(r2));
});
