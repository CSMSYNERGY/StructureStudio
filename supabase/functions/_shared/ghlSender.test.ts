// The pinned CRM sender (migration 356): what "no pin", "a pin GHL still lists", "a pin it no longer
// lists" and "we could not find out" each mean, decided once here. submitEstimateSenderWiring_test
// drives the same rules through the shipped handler.
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite runs offline, like the other
// self-contained _shared tests. Ids are made up (the repo is public).

import { readGhlSenderPin, resolveGhlSenderPin } from "./ghlSender.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}

// A client_settings read that answers `result`, recording what it was asked for.
function fakeDb(result: unknown, seen: unknown[] = []) {
  const q = {
    select: (c: string) => (seen.push(["select", c]), q),
    eq: (c: string, v: string) => (seen.push(["eq", c, v]), q),
    maybeSingle: () => result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  };
  return { from: (t: string) => (seen.push(["from", t]), q) };
}

const row = (v: unknown) => ({ data: { ghl_sender_user_id: v }, error: null });
const HEADERS = { Authorization: "Bearer harness-key" };

// Runs `f` with fetch answering `answer`, and hands back every URL asked for.
async function withFetch<T>(answer: () => Response | Promise<Response>, f: () => Promise<T>): Promise<{ out: T; urls: string[] }> {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve().then(answer);
  }) as typeof fetch;
  try {
    return { out: await f(), urls };
  } finally {
    globalThis.fetch = real;
  }
}
const usersAnswer = (users: unknown[]) => () => new Response(JSON.stringify({ users }), { status: 200 });

Deno.test("read: asks for its one column on this tenant's row", async () => {
  const seen: unknown[] = [];
  assertEquals(await readGhlSenderPin(fakeDb(row("user-1"), seen), "acme-sheds"), "user-1");
  assertEquals(seen, [["from", "client_settings"], ["select", "ghl_sender_user_id"], ["eq", "client_id", "acme-sheds"]]);
});

Deno.test("read: a value is trimmed; null, blank and non-text are no pin", async () => {
  assertEquals(await readGhlSenderPin(fakeDb(row("  user-1 ")), "t"), "user-1");
  for (const v of [null, undefined, "", "   ", 42, true, {}]) {
    assertEquals(await readGhlSenderPin(fakeDb(row(v)), "t"), "", `value ${JSON.stringify(v)}`);
  }
});

Deno.test("read: no row, the column not there yet, and a thrown read are all no pin", async () => {
  assertEquals(await readGhlSenderPin(fakeDb({ data: null, error: null }), "t"), "");
  assertEquals(await readGhlSenderPin(fakeDb({ data: null, error: { code: "42703" } }), "t"), "");
  assertEquals(await readGhlSenderPin(fakeDb({ data: null, error: { code: "PGRST204" } }), "t"), "");
  assertEquals(await readGhlSenderPin(fakeDb(new Error("network")), "t"), "");
});

Deno.test("resolve: no pin makes no CRM call at all", async () => {
  const { out, urls } = await withFetch(usersAnswer([]), () => resolveGhlSenderPin(fakeDb(row(null)), "t", "loc-1", HEADERS));
  assertEquals(out, { userId: "", stale: false });
  assertEquals(urls, []);
});

Deno.test("resolve: a pin GHL lists is used, whichever id field the list carries", async () => {
  for (const users of [[{ id: "other" }, { id: "user-1" }], [{ _id: "user-1" }]]) {
    const { out, urls } = await withFetch(usersAnswer(users), () => resolveGhlSenderPin(fakeDb(row("user-1")), "t", "loc 1", HEADERS));
    assertEquals(out, { userId: "user-1", stale: false });
    assertEquals(urls, ["https://services.leadconnectorhq.com/users/?locationId=loc%201"]);
  }
});

Deno.test("resolve: a pin GHL no longer lists is dropped and reported", async () => {
  const { out } = await withFetch(usersAnswer([{ id: "other" }]), () => resolveGhlSenderPin(fakeDb(row("user-1")), "t", "loc-1", HEADERS));
  assertEquals(out, { userId: "", stale: true });
});

Deno.test("resolve: when the list says nothing about the user, the pin stands", async () => {
  const answers: Array<() => Response> = [
    () => new Response("{}", { status: 500 }),
    () => new Response("{}", { status: 401 }),
    () => new Response("not json", { status: 200 }),
    () => new Response(JSON.stringify({ users: "nope" }), { status: 200 }),
    usersAnswer([]),
    () => { throw new Error("network"); },
  ];
  for (const [i, a] of answers.entries()) {
    const { out } = await withFetch(a, () => resolveGhlSenderPin(fakeDb(row("user-1")), "t", "loc-1", HEADERS));
    assertEquals(out, { userId: "user-1", stale: false }, `answer ${i}`);
  }
});
