// The generation ledger's write, RUN against a database that has not had migration 247 yet.
//
// WHY THIS EXISTS. 226 added `drafted`, `observed`, `frames` and `video_count` to
// `ai_style_calls` because a draft the builder never saves exists nowhere else, and three
// rounds of "it is not accurate" had to be diagnosed from a screenshot. 247 adds `dims` beside
// them — the three numbers the builder measured, which are now the single biggest thing about
// what a generation read.
//
// The trap is that adding one key to that update is not additive. PostgREST refuses the WHOLE
// statement when any key names a column it cannot find (PGRST204), and the write is deliberately
// BEST-EFFORT — a builder who has already been charged must never lose their draft over a
// diagnostics failure — so it does not throw, does not retry on its own and does not surface
// anywhere. Between an edge deploy and the migration being applied by hand, a naive
// `{ ...recorded, dims }` would therefore lose `drafted` on EVERY generation, silently, and
// reopen the exact blind spot 226 was written to close. That is the failure this pins.
//
// HOW: the same slice-and-run idiom crmRecordGate_test, wallSlab_test and orderTotals_test use.
// The shipped block is lifted between stable anchors and executed against a hand-rolled client
// that behaves like a database WITHOUT the column, so nothing is copied out and nothing can
// drift. The block is written as plain JavaScript on purpose (see its own comment) so it can be
// parsed here; if someone reintroduces a type annotation inside it, the factory below throws
// with a message saying so rather than quietly skipping the test.
//
// ⚠️ WHAT THIS DOES NOT PROVE. That PostgREST really answers PGRST204 for an unknown column —
// that is an assumption ENCODED in the fake, not verified by it, because the suite runs with no
// network. What it does prove is that the handler's own reaction to such an answer keeps the
// four 226 columns.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../portal-settings/index.ts", import.meta.url),
);

const START = "    if (ledgerRow?.id) {\n      const recorded = {";
// Ends where 253's frame-map write begins: that is its own update, after this one, and
// aiDraftStreamWiring_test drives it (a failing map write never costs `drafted`).
const END = "    // ── THE FRAME MAP, KEPT FOR A DRAFT PICKED UP AFTER A DROP";
// A Windows checkout reads CRLF (core.autocrlf), and `new Function` does not care, but the
// anchors have to match either way.
const SOURCE = SRC.replace(/\r\n/g, "\n");
const i = SOURCE.indexOf(START);
const j = i < 0 ? -1 : SOURCE.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    "aiLedgerDimsWiring_test: could not find the ai_style_calls ledger-write block in " +
      `portal-settings/index.ts (start=${i}, end=${j}). The anchors moved — re-point them ` +
      "rather than deleting this test.",
  );
}
const BLOCK = SOURCE.slice(i, j);

for (const name of ["recorded", "video_count", "ai_style_dims_write_failed", "ai_style_result_log_failed"]) {
  assert(BLOCK.includes(name), `the extracted block is missing ${name} — re-point the anchors`);
}
// The guard IS the retry. A block with only one update call in it is a block that lost it.
assertEquals(
  BLOCK.split(".update(").length - 1,
  2,
  "the lifted block must still make TWO update calls: the one with dims and the retry without",
);

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Logged = { code: string; message: string };

/** A fake `ai_style_calls` that answers the way PostgREST does when 247 has NOT been applied:
 *  any payload naming a column it does not have is refused WHOLE, and nothing is written. */
function fakeAdmin(known: string[]) {
  const attempts: Row[] = [];
  const stored: Row[] = [];
  return {
    attempts,
    stored,
    from(table: string) {
      assertEquals(table, "ai_style_calls", "the ledger write must go to ai_style_calls");
      return {
        update(row: Row) {
          attempts.push(row);
          const unknown = Object.keys(row).filter((k) => !known.includes(k));
          return {
            // deno-lint-ignore require-await
            async eq(col: string, _id: unknown) {
              assertEquals(col, "id", "the write is scoped to the row by id");
              if (unknown.length) {
                return {
                  error: {
                    code: "PGRST204",
                    message: `Could not find the '${unknown[0]}' column of 'ai_style_calls' in the schema cache`,
                  },
                };
              }
              stored.push(row);
              return { error: null };
            },
          };
        },
      };
    },
  };
}

const BEFORE_247 = ["drafted", "observed", "frames", "video_count"];
const AFTER_247 = [...BEFORE_247, "dims"];

const D3 = { roof: { type: "gambrel", pitch: 0.9 }, siding: null, colors: {}, wallHeightFt: 9 };
const NOTES = { porch: "projecting", confidence: "medium" };
const DIMS = { widthFt: 16, lengthFt: 24, wallHeightFt: 9 };

/** Run the SHIPPED block with the free variables the handler gives it. */
async function runBlock(opts: { known: string[]; dims: unknown }) {
  const admin = fakeAdmin(opts.known);
  const logged: Logged[] = [];
  const factory = new Function(
    "ledgerRow", "drafted", "observedNotes", "photoUrls", "videoCount", "dims",
    "admin", "logEdgeError", "req", "clientId",
    `return (async () => { ${BLOCK} })();`,
  );
  await factory(
    { id: "11111111-2222-3333-4444-555555555555" },
    { ok: true, d3: D3 },
    NOTES,
    ["a", "b", "c", "d"],
    4,
    opts.dims,
    admin,
    // deno-lint-ignore require-await
    async (e: { code: string; message: string }) => { logged.push({ code: e.code, message: e.message }); },
    null,
    "harness-tenant",
  );
  return { admin, logged };
}

Deno.test("⚠️ a missing dims column does NOT take the drafted spec down with it", async () => {
  // THE ONE THIS FILE IS FOR. Deploy first, migrate second — the order the guard exists for.
  const { admin, logged } = await runBlock({ known: BEFORE_247, dims: DIMS });
  assertEquals(admin.attempts.length, 2, "it tried with dims, then retried without");
  assert("dims" in admin.attempts[0], "the first attempt carried the builder's numbers");
  assert(!("dims" in admin.attempts[1]), "the retry did not");
  assertEquals(admin.stored.length, 1, "exactly one write landed");
  assertEquals(Object.keys(admin.stored[0]).sort(), ["drafted", "frames", "observed", "video_count"]);
  assertEquals(admin.stored[0].drafted, D3, "the drafted spec survived, which is the whole point");
  assertEquals(admin.stored[0].observed, NOTES);
  assertEquals(admin.stored[0].frames, 4);
  assertEquals(admin.stored[0].video_count, 4);
  // And it says so once, under its own code, naming the migration. Not `ai_style_result_log_failed`:
  // the spec WAS recorded, and a row claiming otherwise would send someone hunting the wrong fault.
  assertEquals(logged.map((l) => l.code), ["ai_style_dims_write_failed"]);
  assert(logged[0].message.includes("247"), "the row names the migration that fixes it");
});

Deno.test("with 247 applied, dims land in one write and nothing is logged", async () => {
  const { admin, logged } = await runBlock({ known: AFTER_247, dims: DIMS });
  assertEquals(admin.attempts.length, 1, "no retry when the first write succeeds");
  assertEquals(admin.stored.length, 1);
  assertEquals(admin.stored[0].dims, DIMS);
  assertEquals(admin.stored[0].drafted, D3);
  assertEquals(logged, [], "a healthy write is silent");
});

Deno.test("⚠️ a generation with NO dims is byte-identical to before this change", async () => {
  // Every production request lands here: its browser has never heard of dims. One round trip,
  // the same four keys, no retry, no error row — on a database with the column and without it.
  for (const known of [BEFORE_247, AFTER_247]) {
    for (const dims of [null, undefined]) {
      const { admin, logged } = await runBlock({ known, dims });
      assertEquals(admin.attempts.length, 1, "one round trip, exactly as before");
      assertEquals(Object.keys(admin.attempts[0]).sort(), ["drafted", "frames", "observed", "video_count"]);
      assertEquals(admin.stored.length, 1);
      assertEquals(logged, [], "nothing to report");
    }
  }
});

Deno.test("a write that fails for some OTHER reason still reports the drafted spec as lost", async () => {
  // The retry must not swallow a real fault. With dims present and BOTH writes refused, the
  // handler ends up logging twice: once about dims, once about the spec — which is the truth.
  const admin = fakeAdmin([]); // a table with no columns at all: every write is refused
  const logged: Logged[] = [];
  const factory = new Function(
    "ledgerRow", "drafted", "observedNotes", "photoUrls", "videoCount", "dims",
    "admin", "logEdgeError", "req", "clientId",
    `return (async () => { ${BLOCK} })();`,
  );
  await factory(
    { id: "row" }, { ok: true, d3: D3 }, NOTES, ["a"], 1, DIMS, admin,
    // deno-lint-ignore require-await
    async (e: { code: string; message: string }) => { logged.push({ code: e.code, message: e.message }); },
    null, "harness-tenant",
  );
  assertEquals(admin.stored.length, 0, "nothing landed");
  assertEquals(logged.map((l) => l.code), ["ai_style_dims_write_failed", "ai_style_result_log_failed"]);
});

Deno.test("no dims, and the write fails: one row, and it is the one about the spec", async () => {
  // The production shape of a real fault. The dims branch must not fire when there are no dims,
  // or every unrelated ledger failure would come with a misleading row about a migration.
  const admin = fakeAdmin([]);
  const logged: Logged[] = [];
  const factory = new Function(
    "ledgerRow", "drafted", "observedNotes", "photoUrls", "videoCount", "dims",
    "admin", "logEdgeError", "req", "clientId",
    `return (async () => { ${BLOCK} })();`,
  );
  await factory(
    { id: "row" }, { ok: true, d3: D3 }, NOTES, ["a"], 1, null, admin,
    // deno-lint-ignore require-await
    async (e: { code: string; message: string }) => { logged.push({ code: e.code, message: e.message }); },
    null, "harness-tenant",
  );
  assertEquals(admin.attempts.length, 1, "no retry to make");
  assertEquals(logged.map((l) => l.code), ["ai_style_result_log_failed"]);
});
