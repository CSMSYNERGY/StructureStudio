// Unit tests for _shared/designPromotion.ts (migration 241, 2026-09-15).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access, the same rule the other _shared tests follow.
//
// The failures worth pinning are the quiet ones. A promote that is not guarded on 'draft'
// would silently move an accepted or invoiced design back to 'sent' on a resubmit, and a
// promote that writes a null id would erase the CRM estimate reference the next resubmit
// needs, seeding a duplicate estimate. Neither throws, and neither shows up anywhere until a
// customer or a builder notices. So the cases below spend most of their effort on what the
// write must NOT do.
//
// Run: deno test supabase/functions/_shared/designPromotion.test.ts
// (the pre-push gate runs this for you, see scripts/preflight.mjs)

import { issueFields, promoteIssuedDesign } from "./designPromotion.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

type Recorded = { table: string | null; patch: Record<string, unknown> | null; filters: [string, unknown][]; calls: number };

/** Minimal service-role stub covering only what promoteIssuedDesign touches. */
function makeDb(opts: { error?: { message: string } | null; throws?: boolean } = {}) {
  const rec: Recorded = { table: null, patch: null, filters: [], calls: 0 };
  const chain: Record<string, unknown> = {};
  let pending = 0;
  chain.eq = (col: string, val: unknown) => {
    rec.filters.push([col, val]);
    pending -= 1;
    // The third filter is the last one; resolve like PostgREST does when the builder is awaited.
    return pending === 0 ? Promise.resolve({ data: null, error: opts.error ?? null }) : chain;
  };
  chain.update = (patch: Record<string, unknown>) => {
    rec.patch = patch;
    pending = 3;
    return chain;
  };
  const db = {
    from(table: string) {
      rec.calls += 1;
      rec.table = table;
      if (opts.throws) throw new Error("connection reset");
      return chain;
    },
  };
  return { db, rec };
}

// ── What must NOT be written ─────────────────────────────────────────────────────────

Deno.test("a design already past draft is never written: resubmits, accepted designs and change orders", async () => {
  for (const status of ["sent", "accepted", "invoiced", "delivered", "inventory", "", null, undefined]) {
    const { db, rec } = makeDb();
    const r = await promoteIssuedDesign(db, { clientId: "acme", designId: "SS-ABCDEFGHJK", currentStatus: status, fields: { ghl_estimate_id: "est_1" } });
    assertEquals(r, { attempted: false, error: null }, `status ${String(status)}`);
    assertEquals(rec.calls, 0, `status ${String(status)} touched the database`);
  }
});

Deno.test("the WHERE carries the draft guard, the code and the tenant, so a stale read cannot demote or cross tenants", async () => {
  const { db, rec } = makeDb();
  const r = await promoteIssuedDesign(db, { clientId: "acme", designId: "SS-ABCDEFGHJK", currentStatus: "draft" });
  assertEquals(r, { attempted: true, error: null });
  assertEquals(rec.table, "designs");
  assertEquals(rec.filters, [["short_code", "SS-ABCDEFGHJK"], ["client_id", "acme"], ["status", "draft"]]);
  assertEquals(rec.patch?.status, "sent");
});

Deno.test("a null or blank id is left out, never written over a stored one", async () => {
  const { db, rec } = makeDb();
  await promoteIssuedDesign(db, {
    clientId: "acme", designId: "SS-ABCDEFGHJK", currentStatus: "draft",
    fields: { ghl_estimate_id: null, ghl_estimate_number: "  ", ss_quote_number: undefined, total_cents: 0 },
  });
  const keys = Object.keys(rec.patch ?? {}).sort();
  assertEquals(keys, ["status", "total_cents", "updated_at"], "only real values ride along (0 is a real value)");
});

Deno.test("no field can override the status it is promoted to", async () => {
  const { db, rec } = makeDb();
  await promoteIssuedDesign(db, { clientId: "acme", designId: "SS-ABCDEFGHJK", currentStatus: "draft", fields: { status: "accepted" } });
  assertEquals(rec.patch?.status, "sent");
});

// ── What must still happen ───────────────────────────────────────────────────────────

Deno.test("the proof of issue rides in the same write", async () => {
  const { db, rec } = makeDb();
  const lines = { lines: [{ desc: "10x12", total: 5000 }] };
  await promoteIssuedDesign(db, {
    clientId: "acme", designId: "SS-ABCDEFGHJK", currentStatus: "draft",
    fields: { ss_quote_number: "Q-1001", estimate_lines: lines, total_cents: 500000 },
  });
  assertEquals(rec.patch?.ss_quote_number, "Q-1001");
  assertEquals(rec.patch?.estimate_lines, lines);
  assertEquals(rec.patch?.total_cents, 500000);
  assert(typeof rec.patch?.updated_at === "string", "updated_at is stamped");
});

Deno.test("a failed write is reported, not thrown: the quote already exists", async () => {
  const { db } = makeDb({ error: { message: "permission denied for table designs" } });
  const r = await promoteIssuedDesign(db, { clientId: "acme", designId: "SS-ABCDEFGHJK", currentStatus: "draft" });
  assertEquals(r, { attempted: true, error: "permission denied for table designs" });
});

Deno.test("a client that throws is reported, not thrown", async () => {
  const { db } = makeDb({ throws: true });
  const r = await promoteIssuedDesign(db, { clientId: "acme", designId: "SS-ABCDEFGHJK", currentStatus: "draft" });
  assertEquals(r, { attempted: true, error: "connection reset" });
});

Deno.test("issueFields keeps objects, numbers and false; drops null, undefined and blank strings", () => {
  assertEquals(
    issueFields({ a: null, b: undefined, c: "", d: " ", e: "x", f: 0, g: false, h: { k: 1 } }),
    { e: "x", f: 0, g: false, h: { k: 1 } },
  );
});
