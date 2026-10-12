// recordTwilioOptOut (smsOptOut.ts): the ONE way a Twilio 21610 is written, whether it came at
// send time (smsSend.ts) or later in a delivery status (sms-status). Self-contained: a recording
// fake of the supabase client, no network.
// Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/smsOptOut.test.ts

import { recordTwilioOptOut, TWILIO_OPT_OUT_NOTE, TWILIO_OPTED_OUT } from "./smsOptOut.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

type Write = { table: string; op: string; row: Record<string, unknown>; opts?: unknown; filters: string[] };

/** A fake admin client: every write recorded; `fail` makes a table's write answer an error, `throws` throw. */
function fakeAdmin(o: { fail?: Record<string, string>; throws?: string[] } = {}) {
  const writes: Write[] = [];
  const admin = {
    from(table: string) {
      const w: Write = { table, op: "", row: {}, filters: [] };
      const result = () => ({ data: null, error: o.fail?.[table] ? { code: o.fail[table], message: "phone_digits 5550100002 refused" } : null });
      // deno-lint-ignore no-explicit-any
      const q: any = {
        upsert(row: Record<string, unknown>, opts: unknown) {
          if (o.throws?.includes(table)) throw new Error("network down 5550100002");
          Object.assign(w, { op: "upsert", row, opts });
          writes.push(w);
          return Promise.resolve(result());
        },
        update(row: Record<string, unknown>) {
          if (o.throws?.includes(table)) throw new Error("network down 5550100002");
          Object.assign(w, { op: "update", row });
          writes.push(w);
          return q;
        },
        eq(col: string, val: unknown) {
          w.filters.push(`${col}=${val}`);
          return q;
        },
        then(ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) {
          return Promise.resolve(result()).then(ok, bad);
        },
      };
      return q;
    },
  };
  return { admin, writes };
}

Deno.test("21610 is the code", () => {
  assertEquals(TWILIO_OPTED_OUT, 21610);
});

Deno.test("records the number (sms_stop) and the contact's flag, keyed on this business", async () => {
  const { admin, writes } = fakeAdmin();
  const failed = await recordTwilioOptOut(admin, "tenant-a", "5550100002", "contact-1");
  assertEquals(failed, null);
  assertEquals(writes.map((w) => [w.table, w.op]), [["sms_opt_outs", "upsert"], ["crm_contacts", "update"]]);
  assertEquals(writes[0].row, { client_id: "tenant-a", phone_digits: "5550100002", reason: "sms_stop", note: TWILIO_OPT_OUT_NOTE });
  assertEquals(writes[0].opts, { onConflict: "client_id,phone_digits" });
  assert(typeof writes[1].row.sms_opt_out_at === "string" && !Number.isNaN(Date.parse(String(writes[1].row.sms_opt_out_at))), "a time");
  assertEquals(writes[1].filters, ["client_id=tenant-a", "id=contact-1"]);
});

Deno.test("no contact: the number alone", async () => {
  for (const contact of [null, undefined, ""]) {
    const { admin, writes } = fakeAdmin();
    assertEquals(await recordTwilioOptOut(admin, "tenant-a", "5550100002", contact), null);
    assertEquals(writes.map((w) => w.table), ["sms_opt_outs"]);
  }
});

Deno.test("never throws; says what failed first by table and code, never the database's message or the number", async () => {
  const one = fakeAdmin({ fail: { sms_opt_outs: "42501" } });
  const failed = await recordTwilioOptOut(one.admin, "tenant-a", "5550100002", "contact-1");
  assertEquals(failed, "sms_opt_outs: 42501");
  // The contact's flag is still written: one failure doesn't stop the other.
  assertEquals(one.writes.map((w) => w.table), ["sms_opt_outs", "crm_contacts"]);

  const contactOnly = fakeAdmin({ fail: { crm_contacts: "57014" } });
  assertEquals(await recordTwilioOptOut(contactOnly.admin, "tenant-a", "5550100002", "contact-1"), "crm_contacts: 57014");

  const thrown = fakeAdmin({ throws: ["sms_opt_outs", "crm_contacts"] });
  const said = await recordTwilioOptOut(thrown.admin, "tenant-a", "5550100002", "contact-1");
  assertEquals(said, "sms_opt_outs: threw");
  assert(!String(said).includes("5550100002"));
});
