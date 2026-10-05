// portal-settings' error contract, pinned against the SHIPPED source.
//
// The contract (dbFail's header, and CLAUDE.md's portal-settings note): a sentence THIS function
// writes goes to the browser verbatim; text it did not write does not — a Postgres message, a
// third party's response body (GoHighLevel's), or the runtime's network error text. Those go to
// app_errors under the label the builder is shown, and the builder gets our sentence.
//
// Nine returns had slipped past it: the invoice-number allocation echoed Postgres, the two
// operator audit refusals echoed auditStrict's message (which carries the insert's Postgres text),
// send_invoice's convert / send / resend / estimate-list failures echoed GoHighLevel's body or the
// fetch error, and the two GHL connection checks echoed the fetch error. Separately,
// save_wall_heights and save_cladding sent a malformed styleId straight to a uuid column, so "abc"
// came back as a 500 fault instead of the "not in your catalog" a wrong id gets.
//
// Lifted, not copied, so a drift fails the push. Same technique as style3dErrors_test.

import { assert, assertEquals } from "jsr:@std/assert";
import { isUuid } from "../../portal-settings/phone.ts";

const SRC = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");

// ── 1. No return hands provider text to the browser ──────────────────────────────────────────
// What a leak looks like on one line. setClaim(...) rows are exempt: invoice_sends is service-role
// only and its `error` column is the support record, never put on the wire (the activity read
// leaves it out). skipped.push lines are exempt by colorSaveReason's documented choice.
const RAW = [
  /\berror:\s*\(?\s*[A-Za-z_$][\w$]*\s+as\s+Error\s*\)?\s*\.message\b/, // error: (e as Error).message
  /\berror:\s*[A-Za-z_$][\w$.?]*\.message\b/, //                           error: allocErr.message
  /\berror:\s*`[^`]*\$\{[^}]*(\.message|\bnetErr)\b/, //                  error: `… ${x.message} …`
];

Deno.test("no portal-settings return puts a database, CRM or network message in `error`", () => {
  const hits = SRC.split("\n")
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => !/setClaim\(|skipped\.push|^\s*\/\//.test(l))
    .filter(({ l }) => RAW.some((re) => re.test(l)))
    .map(({ l, n }) => `${n}: ${l.trim().slice(0, 120)}`);
  assertEquals(hits, [], "raw provider text reaches the browser; use dbFail, or log it and write the sentence");
});

Deno.test("the scan still recognises each leak it exists for", () => {
  // If these stop matching, the test above passes blind.
  for (const line of [
    "return json({ error: `Could not allocate an invoice number: ${allocErr.message}` }, 502);",
    "return json({ error: (e as Error).message }, 503);",
    "return json({ error: `Creating the invoice failed: ${convRes.body?.message ?? convRes.status ?? convRes.netErr}` }, 502);",
    "return json({ error: `Could not read estimates from your CRM (${r.status || r.netErr}).` }, 502);",
  ]) assert(RAW.some((re) => re.test(line)), `the scan no longer catches: ${line}`);
});

Deno.test("the activity drawer's invoice_sends read leaves the error column off the wire", () => {
  const i = SRC.indexOf('invoiceSends: sends ?? []');
  assert(i > 0, "settingsErrorContract_test: the invoiceSends return moved — re-point this anchor");
  const sel = SRC.lastIndexOf('.from("invoice_sends")', i);
  const read = SRC.slice(sel, SRC.indexOf(";", sel));
  assert(!/\berror\b/.test(read.replace(/\/\/.*$/gm, "")), `the activity read selects invoice_sends.error: ${read}`);
});

// ── 2. save_wall_heights / save_cladding: a malformed styleId is "not in your catalog" ───────
const NOT_FOUND = 'if (!stRes.data) return json({ error: "That building style is not in your catalog." }, 400);';

function prologue(action: string): string {
  const head = `if (action === "${action}") {`;
  const i = SRC.indexOf(head);
  const j = i < 0 ? -1 : SRC.indexOf(NOT_FOUND, i);
  if (i < 0 || j < 0) {
    throw new Error(`settingsErrorContract_test: could not lift ${action}'s style check (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  const body = SRC.slice(i + head.length, j + NOT_FOUND.length)
    // save_cladding's one cast, taken off so the block runs as plain JS.
    .replace("(payload as Record<string, unknown>)", "payload");
  assert(!/\bas\s+[A-Z]|:\s*(string|number|unknown)\b/.test(body), `${action}'s lifted block gained TypeScript this test does not strip`);
  return body + '\nreturn "past the style check";';
}

type R = { status: number; body: Record<string, unknown> };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function run(action: string, styleId: unknown, answer: { data: unknown; error: unknown }) {
  const calls: string[] = [];
  const fails: string[] = [];
  const q = {
    eq(col: string, v: string) { calls.push(`${col}=${v}`); return q; },
    // What Postgres does with a malformed uuid: the query answers 22P02.
    maybeSingle: () => Promise.resolve(answer),
  };
  const admin = { from(t: string) { calls.push(`from ${t}`); return { select: () => q }; } };
  const json = (body: Record<string, unknown>, status = 200): R => ({ status, body });
  const dbFail = (_req: unknown, _c: unknown, where: string): R => {
    fails.push(where);
    return { status: 500, body: { error: `Couldn't ${where}.`, ref: where } };
  };
  const tooMany = () => null;
  const fn = new AsyncFunction("payload", "admin", "clientId", "json", "dbFail", "isUuid", "tooMany", "req", prologue(action));
  const out = await fn({ styleId, rows: [] }, admin, "acme", json, dbFail, isUuid, tooMany, null) as R | string;
  return { out, calls, fails };
}

const ID = "3f2b7c1e-8d4a-4b6e-9c1f-2a5d7e9b0c11";
const BAD_UUID = { data: null, error: { code: "22P02", message: 'invalid input syntax for type uuid: "abc"' } };

for (const action of ["save_wall_heights", "save_cladding"]) {
  Deno.test(`${action}: a styleId that is not a uuid is not in the catalog, and never reaches Postgres`, async () => {
    for (const bad of ["abc", "new-style", `${ID}x`, "1; drop table x"]) {
      const { out, calls, fails } = await run(action, bad, BAD_UUID);
      assertEquals(out, { status: 400, body: { error: "That building style is not in your catalog." } }, `styleId ${JSON.stringify(bad)}`);
      assertEquals(calls, [], "no query for a malformed id");
      assertEquals(fails, [], "not a fault");
    }
  });

  Deno.test(`${action}: a real id is still checked against THIS tenant's catalog`, async () => {
    const mine = await run(action, ID, { data: { id: ID }, error: null });
    assertEquals(mine.out, "past the style check");
    assertEquals(mine.calls, ["from building_styles", "client_id=acme", `id=${ID}`]);

    const theirs = await run(action, ID, { data: null, error: null });
    assertEquals((theirs.out as R).status, 400);

    const down = await run(action, ID, { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    assertEquals((down.out as R).status, 500);
    assertEquals(down.fails, ["read that style"]);
    assert(!JSON.stringify(down.out).includes("statement timeout"));

    const blank = await run(action, "", { data: null, error: null });
    assertEquals(blank.out, { status: 400, body: { error: "styleId required" } });
  });
}
