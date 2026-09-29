// SSS Phone — sms-inbound stores NumMedia (supabase/functions/sms-inbound/numMedia.ts).
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/

import { assert, assertEquals } from "jsr:@std/assert@1";
import { insertInbound, parseNumMedia } from "../../supabase/functions/sms-inbound/numMedia.ts";

Deno.test("parseNumMedia: Twilio's NumMedia → a stored count, junk as none", () => {
  assertEquals(parseNumMedia("0"), 0);
  assertEquals(parseNumMedia("2"), 2);
  assertEquals(parseNumMedia(" 10 "), 10);
  assertEquals(parseNumMedia(undefined), 0);
  assertEquals(parseNumMedia(""), 0);
  assertEquals(parseNumMedia("11"), 0);       // Twilio caps at 10; anything above is not a count we trust
  assertEquals(parseNumMedia("-1"), 0);
  assertEquals(parseNumMedia("1.5"), 0);
  assertEquals(parseNumMedia("two"), 0);
});

/** A fake client recording each insert, answering with the queued results in order. */
function fakeAdmin(results: { error: { code?: string; message?: string } | null }[]) {
  const inserts: Record<string, unknown>[] = [];
  return {
    inserts,
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        assertEquals(table, "sms_messages");
        inserts.push(row);
        return Promise.resolve(results.shift() ?? { error: null });
      },
    }),
  };
}
const ROW = { client_id: "demo-tenant", direction: "in", from_number: "+15555550100", to_number: "+15555550199", body: "" };

Deno.test("the photo count is stored with the text", async () => {
  const admin = fakeAdmin([{ error: null }]);
  const out = await insertInbound(admin, ROW, 2);
  assertEquals(out, { error: null, retriedWithoutMedia: false });
  assertEquals(admin.inserts.length, 1);
  assertEquals(admin.inserts[0].num_media, 2);
  assertEquals(admin.inserts[0].body, "");
});

Deno.test("before migration 254 the text is STILL stored — retried without the column", async () => {
  for (const code of ["PGRST204", "42703"]) {
    const admin = fakeAdmin([{ error: { code, message: "column num_media does not exist" } }, { error: null }]);
    const out = await insertInbound(admin, ROW, 3);
    assertEquals(out, { error: null, retriedWithoutMedia: true }, code);
    assertEquals(admin.inserts.length, 2);
    assert(!("num_media" in admin.inserts[1]), "the retry must not name the missing column");
    assertEquals(admin.inserts[1].body, ROW.body);
  }
});

Deno.test("any other error is handed back untouched — a Twilio retry (23505) is not retried here", async () => {
  const admin = fakeAdmin([{ error: { code: "23505", message: "duplicate key" } }]);
  const out = await insertInbound(admin, ROW, 0);
  assertEquals(out.error?.code, "23505");
  assertEquals(out.retriedWithoutMedia, false);
  assertEquals(admin.inserts.length, 1);
});

Deno.test("sms-inbound's handler really goes through insertInbound with NumMedia", async () => {
  // Wiring, read from the shipped source: the insert is the one place a text is stored, so a
  // refactor that went back to a bare insert would silently drop the photo count again.
  const src = (await Deno.readTextFile(new URL("../../supabase/functions/sms-inbound/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(/parseNumMedia\(params\.NumMedia\)/.test(src), "NumMedia is not parsed from the Twilio params");
  assert(/await insertInbound\(admin,/.test(src), "the inbound row is not stored through insertInbound");
  assert(!/admin\.from\("sms_messages"\)\.insert\(/.test(src), "a bare sms_messages insert is back in the handler");
});
