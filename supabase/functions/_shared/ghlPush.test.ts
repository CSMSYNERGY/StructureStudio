// Unit tests for _shared/ghlPush.ts (migration 370). Self-contained, and the fetch is a fake.
import { GHL_API, pushContactToGhl } from "./ghlPush.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

type Step = { status: number; json?: unknown; throws?: boolean };
function fake(steps: Step[]) {
  const seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fn = (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const s = steps[seen.length - 1] ?? { status: 500 };
    if (s.throws) return Promise.reject(new TypeError("network"));
    return Promise.resolve(new Response(s.json === undefined ? null : JSON.stringify(s.json), { status: s.status }));
  };
  return { fn, seen };
}
const IN = {
  locationId: "loc1", apiKey: "k",
  contact: { name: "Dee Ann Tester", email: "Dee@Example.invalid", phone: "+1 (555) 010-3670", company: "Dee Co" },
  tags: ["lot-buyer", "review"],
};
const BACK = { contact: { id: "g1", phone: "+15550103670", email: "dee@example.invalid" } };

Deno.test("upsert says who they are with NO tags, then the tags are ADDED by their own call", async () => {
  const f = fake([{ status: 201, json: BACK }, { status: 201, json: {} }]);
  eq(await pushContactToGhl(f.fn, IN), { ok: true, contactId: "g1", tagged: 2 }, "pushed");
  eq(f.seen.map((s) => s.url), [`${GHL_API}/contacts/upsert`, `${GHL_API}/contacts/g1/tags`], "two calls");
  eq(f.seen[0].body, {
    locationId: "loc1", name: "Dee Ann Tester", firstName: "Dee", lastName: "Ann Tester",
    email: "Dee@Example.invalid", phone: "+1 (555) 010-3670", companyName: "Dee Co", source: "StructureStudio automation",
  }, "upsert body has no tags");
  eq(f.seen[1].body, { tags: ["lot-buyer", "review"] }, "tags call");
  eq([f.seen[0].headers.Version, f.seen[0].headers.Authorization], ["2021-07-28", "Bearer k"], "headers");
});

Deno.test("no tags, one call", async () => {
  const f = fake([{ status: 200, json: BACK }]);
  eq((await pushContactToGhl(f.fn, { ...IN, tags: [] })).ok, true, "pushed");
  eq(f.seen.length, 1, "upsert only");
});

Deno.test("nobody to find them by: nothing is sent", async () => {
  const f = fake([]);
  const out = await pushContactToGhl(f.fn, { ...IN, contact: { name: "No One", email: "not-an-email", phone: "555", company: null } });
  eq([out.ok, (out as { code: string }).code, f.seen.length], [false, "no_identity", 0], "refused before any call");
});

Deno.test("a different person came back: no tags on them", async () => {
  const f = fake([{ status: 200, json: { contact: { id: "g2", phone: "+15559990000", email: "someone@else.invalid" } } }]);
  const out = await pushContactToGhl(f.fn, IN);
  eq([out.ok, (out as { code: string }).code, (out as { retry: boolean }).retry, f.seen.length], [false, "mismatch", false, 1], "mismatch");
  // The same phone with another email is still them (a second address), and so is the same email
  // with another phone.
  const g = fake([{ status: 200, json: { contact: { id: "g3", phone: "5550103670", email: "other@x.invalid" } } }, { status: 200, json: {} }]);
  eq((await pushContactToGhl(g.fn, IN)).ok, true, "phone matches");
  const h = fake([{ status: 200, json: { contact: { id: "g4", phone: "+15551112222", email: "dee@example.invalid" } } }, { status: 200, json: {} }]);
  eq((await pushContactToGhl(h.fn, IN)).ok, true, "email matches");
});

Deno.test("what GoHighLevel's answer means", async () => {
  const cases: [Step[], string, boolean][] = [
    [[{ status: 401 }], "auth", false],
    [[{ status: 403 }], "auth", false],
    [[{ status: 422 }], "refused", false],
    [[{ status: 429 }], "busy", true],
    [[{ status: 502 }], "busy", true],
    [[{ status: 0, throws: true }], "busy", true],
    [[{ status: 200, json: {} }], "refused", false],
    [[{ status: 200, json: BACK }, { status: 503 }], "busy", true],
    [[{ status: 200, json: BACK }, { status: 400 }], "refused", false],
  ];
  for (const [steps, code, retry] of cases) {
    const out = await pushContactToGhl(fake(steps).fn, IN);
    eq([out.ok, (out as { code: string }).code, (out as { retry: boolean }).retry], [false, code, retry], JSON.stringify(steps));
  }
});

Deno.test("no message carries the key, an address or a phone number", async () => {
  const cases: Step[][] = [[{ status: 401 }], [{ status: 500 }], [{ status: 200, json: { contact: { id: "g", phone: "+15559990000", email: "x@y.invalid" } } }]];
  for (const steps of cases) {
    const out = await pushContactToGhl(fake(steps).fn, { ...IN, apiKey: "pit-SECRETVALUE" });
    const msg = (out as { error: string }).error;
    for (const bit of ["SECRETVALUE", "example.invalid", "0103670", "9990000"]) {
      if (msg.includes(bit)) throw new Error(`message leaks ${bit}: ${msg}`);
    }
  }
});
