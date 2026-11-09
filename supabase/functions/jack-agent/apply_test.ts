import { assert, assertEquals } from "./test_assert.ts";
import { applyPayload, type PortalCall, undoPayload } from "./apply.ts";
import type { Payload } from "./preview.ts";

const V2 = "2026-11-05T00:00:00.000000+00:00";

/** Stands in for portal-settings' save_pricing_cells: records each call and answers from `answer`. */
function portal(answer: (body: Record<string, unknown>) => { status?: number; data?: Record<string, unknown> | null }) {
  const calls: Record<string, unknown>[] = [];
  const call: PortalCall = (action, body) => {
    assertEquals(action, "save_pricing_cells");
    calls.push(body);
    const a = answer(body);
    return Promise.resolve({ status: a.status ?? 200, data: a.data === undefined ? {} : a.data });
  };
  return { call, calls };
}
// deno-lint-ignore no-explicit-any
const savedAll = (b: any) => ({ data: { results: (b.sizes ?? []).map((s: any) => ({ id: s.id, status: "saved", version: V2, row: { active: true } })), created: (b.creates ?? []).map((c: any) => ({ id: c.id, status: "created", version: V2 })), removed: (b.removes ?? []).map((r: any) => ({ id: r.id, status: "removed" })) } });

const payload: Payload = {
  creates: [{ id: "new1", styleId: "garden", label: "10x20", width: 10, length: 20, price: 6000, cells: { single: 1 } }],
  sizes: [
    { id: "s1", label: "10x12", base: "v1", from: { price: 4000 }, to: { price: 4200 }, wasActive: true },
    { id: "s2", label: "10x14", base: "v1", from: { price: 4500 }, to: { price: null }, wasActive: true },
  ],
};

Deno.test("sizes are created first, then priced, and only what the payload holds is sent", async () => {
  const p = portal(savedAll);
  const out = await applyPayload(p.call, payload);
  assertEquals(p.calls.length, 2);
  assertEquals(p.calls[0], { creates: [{ id: "new1", styleId: "garden", width: 10, length: 20 }] });
  // deno-lint-ignore no-explicit-any
  const sizes = (p.calls[1] as any).sizes;
  assertEquals(sizes.map((s: { id: string }) => s.id), ["s1", "s2", "new1"]);
  assertEquals(sizes[2], { id: "new1", base: V2, from: { price: null, cells: { single: 0 } }, to: { price: 6000, cells: { single: 1 } } });
  assertEquals(out.created, 1);
  assertEquals(out.saved, 3);
  assertEquals(out.reports, []);
});

Deno.test("undo holds the new versions, swaps the values and removes what was created", async () => {
  const out = await applyPayload(portal(savedAll).call, payload);
  assertEquals(out.undo.removes, [{ id: "new1", label: "10x20", base: V2 }]);
  assertEquals(out.undo.sizes[0], { id: "s1", label: "10x12", base: V2, from: { price: 4200 }, to: { price: 4000 } });
  // Taking a price off hid the size, so putting it back says it was offered.
  assertEquals(out.undo.sizes[1], { id: "s2", label: "10x14", base: V2, from: { price: null, active: true }, to: { price: 4500, active: true } });
});

Deno.test("a size someone changed during the review is left alone and reported", async () => {
  const p = portal((b) => {
    if (b.creates) return savedAll(b);
    // deno-lint-ignore no-explicit-any
    return { data: { results: (b.sizes as any[]).map((s) => ({ id: s.id, status: s.id === "s1" ? "conflict" : "saved", version: V2, row: { active: false } })) } };
  });
  const out = await applyPayload(p.call, payload);
  assertEquals(out.saved, 2);
  assertEquals(out.reports.length, 1);
  assertEquals(out.reports[0].label, "10x12");
  assert(out.reports[0].reason.includes("left alone"));
  assert(!out.undo.sizes.some((s) => s.id === "s1"));
});

Deno.test("a size someone else added first isn't touched", async () => {
  const p = portal((b) => (b.creates ? { data: { created: [{ id: "new1", status: "exists", existingId: "x", version: V2 }] } } : savedAll(b)));
  const out = await applyPayload(p.call, payload);
  assertEquals(out.created, 0);
  assertEquals(out.reports[0].status, "exists");
  assertEquals(out.undo.removes, []);
  // deno-lint-ignore no-explicit-any
  assert(!(p.calls[1] as any).sizes.some((s: { id: string }) => s.id === "new1"));
});

Deno.test("a route failure is retried once, and a refusal never is", async () => {
  let fives = 0;
  const flaky = portal((b) => (fives++ === 0 ? { status: 500, data: null } : savedAll(b)));
  const one = await applyPayload(flaky.call, { creates: [], sizes: payload.sizes });
  assertEquals(flaky.calls.length, 2);
  assertEquals(one.saved, 2);

  const refused = portal(() => ({ status: 403, data: { error: "That isn't part of your access." } }));
  const two = await applyPayload(refused.call, { creates: [], sizes: payload.sizes });
  assertEquals(refused.calls.length, 1);
  assertEquals(two.saved, 0);
  assertEquals(two.reports.map((r) => r.reason), ["That isn't part of your access.", "That isn't part of your access."]);
});

Deno.test("big changes go in calls the route accepts", async () => {
  const many: Payload = { creates: [], sizes: Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, label: "x", base: "v", from: { price: 1 }, to: { price: 2 }, wasActive: true })) };
  const p = portal(savedAll);
  const out = await applyPayload(p.call, many);
  assertEquals(p.calls.length, 3);
  assertEquals(out.saved, 120);
});

Deno.test("undo: a changed size stays, the rest go back, and created sizes come off", async () => {
  const p = portal((b) => {
    // deno-lint-ignore no-explicit-any
    if (b.sizes) return { data: { results: (b.sizes as any[]).map((s) => ({ id: s.id, status: s.id === "s1" ? "conflict" : "saved", version: V2 })) } };
    return { data: { removed: [{ id: "new1", status: "refused", code: "used" }, { id: "new2", status: "removed" }] } };
  });
  const out = await undoPayload(p.call, {
    removes: [{ id: "new1", label: "10x20", base: V2 }, { id: "new2", label: "10x22", base: V2 }],
    sizes: [{ id: "s1", label: "10x12", base: V2, from: { price: 2 }, to: { price: 1 } }, { id: "s2", label: "10x14", base: V2, from: { price: 2 }, to: { price: 1 } }],
  });
  assertEquals(out.restored, 1);
  assertEquals(out.removed, 1);
  assertEquals(out.reports.map((r) => [r.label, r.status]), [["10x12", "conflict"], ["10x20", "used"]]);
});

Deno.test("a save that landed but lost its answer counts, and gets an Undo line", async () => {
  // The first try commits and the answer is lost; the retry finds the new values already there.
  let calls = 0;
  const p = portal((b) => {
    if (calls++ === 0) return { status: 502, data: null };
    // deno-lint-ignore no-explicit-any
    return { data: { results: (b.sizes as any[]).map((s) => ({ id: s.id, status: "duplicate", version: V2, row: { active: true } })) } };
  });
  const out = await applyPayload(p.call, { creates: [], sizes: [payload.sizes[0]] });
  assertEquals(out.saved, 1);
  assertEquals(out.reports, []);
  assertEquals(out.undo.sizes, [{ id: "s1", label: "10x12", base: V2, from: { price: 4200 }, to: { price: 4000 } }]);
});

Deno.test("a 200 with no readable body is retried like a lost answer", async () => {
  let calls = 0;
  const p = portal((b) => (calls++ === 0 ? { status: 200, data: null } : savedAll(b)));
  const out = await applyPayload(p.call, { creates: [], sizes: [payload.sizes[0]] });
  assertEquals(p.calls.length, 2);
  assertEquals(out.saved, 1);
});

Deno.test("a refused box: the Undo line names only what landed, and the report says why", async () => {
  const both: Payload = { creates: [], sizes: [{ id: "s1", label: "10x12", base: "v1", from: { price: 4000, cells: { d: 0 } }, to: { price: 4400, cells: { d: 1 } }, wasActive: true }] };
  const p = portal(() => ({ data: { results: [{ id: "s1", status: "saved", version: V2, row: { active: true }, cellErrors: { price: "Real-Time Pricing sets prices on this account" } }] } }));
  const out = await applyPayload(p.call, both);
  assertEquals(out.saved, 1);
  assertEquals(out.undo.sizes, [{ id: "s1", label: "10x12", base: V2, from: { cells: { d: 1 } }, to: { cells: { d: 0 } } }]);
  assert(out.reports[0].reason.includes("Real-Time Pricing"));
});

Deno.test("every box refused isn't a save, and leaves nothing to undo", async () => {
  const p = portal(() => ({ data: { results: [{ id: "s2", status: "saved", version: V2, row: { active: false }, cellErrors: { price: "no" } }] } }));
  const out = await applyPayload(p.call, { creates: [], sizes: [payload.sizes[1]] });
  assertEquals(out.saved, 0);
  assertEquals(out.undo.sizes, []);
  assertEquals(out.reports[0].status, "refused");
});

Deno.test("progress is heard after each call, and holds the Undo so far", async () => {
  const many: Payload = { creates: [], sizes: Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, label: "x", base: "v", from: { price: 1 }, to: { price: 2 }, wasActive: true })) };
  const heard: number[] = [];
  await applyPayload(portal(savedAll).call, many, (s) => { heard.push(s.undo.sizes.length); return Promise.resolve(); });
  assertEquals(heard, [50, 100, 120]);
});

Deno.test("undo: a call that never answered is counted, so it can be pressed again", async () => {
  const p = portal(() => ({ status: 503, data: null }));
  const out = await undoPayload(p.call, { removes: [{ id: "n", label: "10x20", base: V2 }], sizes: [{ id: "s1", label: "10x12", base: V2, from: { price: 2 }, to: { price: 1 } }] });
  assertEquals(out.failed, 2);
  assertEquals(out.restored, 0);
});

Deno.test("undo: a refused box on a size that went back is reported", async () => {
  const p = portal(() => ({ data: { results: [{ id: "s1", status: "saved", version: V2, cellErrors: { d: "gone" } }] } }));
  const out = await undoPayload(p.call, { removes: [], sizes: [{ id: "s1", label: "10x12", base: V2, from: { price: 2 }, to: { price: 1 } }] });
  assertEquals(out.restored, 1);
  assertEquals(out.reports[0].status, "partial");
});
