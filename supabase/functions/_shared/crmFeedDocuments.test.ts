// The documents a record's History carries (crmFeed.ts), against a stub that honours SELECT.
//
// Deliberately dependency-free (no jsr:/npm: imports), the same rule the other _shared tests
// follow. The other feed tests (tests/phone/crmFeed*) use a stub that hands back whole rows
// whatever was selected, so a column missing from a select list cannot fail them — which is
// exactly how `floor_plan` went unemitted: the designs read never selected image_url, so
// `d.image_url` was always undefined, and every one of those tests stayed green.
//
// Run: deno test --node-modules-dir=none supabase/functions/_shared/crmFeedDocuments.test.ts

import { buildCrmFeed, CRM_FEED_TYPES } from "./crmFeed.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};

/** A PostgREST stand-in that returns ONLY the selected columns, like the real one. */
function projectingAdmin(tables: Record<string, Record<string, unknown>[]>) {
  const builder = (table: string) => {
    let cols: string[] | null = null;
    const b: Record<string, unknown> = {};
    b.select = (s: string) => {
      // Top-level names only; an embed like `phone_voicemails(...)` is kept by its name.
      cols = String(s).replace(/\([^)]*\)/g, "").split(",").map((c) => c.trim()).filter(Boolean);
      return b;
    };
    for (const m of ["eq", "in", "or", "is", "order", "limit"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      const rows = (tables[table] ?? []).map((r) =>
        cols ? Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])) : r
      );
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    };
    return b;
  };
  return { from: builder, storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) } };
}

const PDF = "https://jzeamjbhdrsbygdnphbm.supabase.co/storage/v1/object/public/floor-plans/demo/SS-DEMO2345-1.pdf";

Deno.test("a design with a floor-plan PDF puts it in History under the documents chip", async () => {
  const admin = projectingAdmin({
    designs: [{
      short_code: "SS-DEMO2345", created_at: "2026-09-20T15:00:00Z", updated_at: "2026-09-20T15:00:00Z",
      status: "sent", selections: { style: "Utility", size: "12x16" }, contact: { name: "Pat" },
      image_url: PDF,
    }],
  });
  const feed = await buildCrmFeed(admin, "demo", { codes: ["SS-DEMO2345"], contactId: null });
  const fp = feed.find((e) => e.type === "floor_plan");
  assert(fp, `no floor_plan event — got ${JSON.stringify(feed.map((e) => e.type))}`);
  assert(fp!.url === PDF, `floor_plan url is ${fp!.url}`);
  assert((CRM_FEED_TYPES.document as readonly string[]).includes("floor_plan"), "the documents chip no longer asks for floor_plan");
});

Deno.test("a draft with no PDF emits no floor_plan", async () => {
  const admin = projectingAdmin({
    designs: [{ short_code: "SS-DEMO2346", created_at: "2026-09-20T15:00:00Z", status: "draft", selections: {}, image_url: null }],
  });
  const feed = await buildCrmFeed(admin, "demo", { codes: ["SS-DEMO2346"], contactId: null });
  assert(!feed.some((e) => e.type === "floor_plan"), "a draft without a PDF should list no floor plan");
  assert(feed.some((e) => e.type === "design_created"), "the design itself should still be listed");
});
