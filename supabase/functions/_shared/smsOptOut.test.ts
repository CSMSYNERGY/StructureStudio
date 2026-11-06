// recordTwilioOptOut (smsOptOut.ts): the ONE way a Twilio 21610 is written, whether it came at
// send time (smsSend.ts) or later in a delivery status (sms-status). And smsOptOutFacts /
// smsOptOutRefusal: the ONE way the screens read it (portal-settings crm_record and
// crm_record_consent, the phone-api Worker's GET /threads/:key). Self-contained: a recording fake
// of the supabase client, no network.
// Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/smsOptOut.test.ts

import {
  readSmsOptOut, recordTwilioOptOut, smsOptOutFacts, smsOptOutReasonOf, smsOptOutRefusal, TWILIO_OPT_OUT_NOTE, TWILIO_OPTED_OUT,
} from "./smsOptOut.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

type Write = { table: string; op: string; row: Record<string, unknown>; opts?: unknown; filters: string[] };

/**
 * A fake admin client: every write recorded; `fail` makes a table's write answer an error, `throws`
 * throw. `rows` is what sms_opt_outs already holds, keyed client_id|phone_digits: an upsert with
 * ignoreDuplicates leaves an existing row as it is (PostgREST's resolution=ignore-duplicates,
 * ON CONFLICT DO NOTHING), and one without replaces it.
 */
function fakeAdmin(o: { fail?: Record<string, string>; throws?: string[]; rows?: Map<string, Record<string, unknown>> } = {}) {
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
          if (o.rows && !o.fail?.[table]) {
            const k = `${row.client_id}|${row.phone_digits}`;
            if (!(o.rows.has(k) && (opts as { ignoreDuplicates?: boolean })?.ignoreDuplicates)) o.rows.set(k, row);
          }
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
        is(col: string, val: unknown) {
          w.filters.push(`${col}=is.${val}`);
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
  assertEquals(writes[0].opts, { onConflict: "client_id,phone_digits", ignoreDuplicates: true });
  assert(typeof writes[1].row.sms_opt_out_at === "string" && !Number.isNaN(Date.parse(String(writes[1].row.sms_opt_out_at))), "a time");
  assertEquals(writes[1].filters, ["client_id=tenant-a", "id=contact-1", "sms_opt_out_at=is.null"]);
});

Deno.test("adds, never rewrites: an operator's opt-out keeps its reason and note, and the contact keeps its first time", async () => {
  const operator = { client_id: "tenant-a", phone_digits: "5550100002", reason: "operator", note: "asked by phone", effective_at: "2026-10-01T15:00:00.000Z" };
  const rows = new Map([["tenant-a|5550100002", operator]]);
  const { admin, writes } = fakeAdmin({ rows });
  // Twilio sends a failed status twice for the one text.
  assertEquals(await recordTwilioOptOut(admin, "tenant-a", "5550100002", "contact-1"), null);
  assertEquals(await recordTwilioOptOut(admin, "tenant-a", "5550100002", "contact-1"), null);
  assertEquals(rows.get("tenant-a|5550100002"), operator, "the operator's row, as it was");
  assertEquals(rows.size, 1);
  // The contact's flag is only ever filled in, never moved.
  assert(writes.filter((w) => w.table === "crm_contacts").every((w) => w.filters.includes("sms_opt_out_at=is.null")));
  // A number with no row yet gets one.
  assertEquals(await recordTwilioOptOut(admin, "tenant-a", "5550100003"), null);
  assertEquals(rows.get("tenant-a|5550100003")?.reason, "sms_stop");
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

// ── Reading it ───────────────────────────────────────────────────────────────────────────────

Deno.test("the reason in the screens' words: a STOP or 21610 is stop, the team's is team, anything else other", () => {
  assertEquals(smsOptOutReasonOf("sms_stop"), "stop");
  assertEquals(smsOptOutReasonOf("operator"), "team");
  for (const r of ["import", "web_form", "", null, undefined]) assertEquals(smsOptOutReasonOf(r), "other", String(r));
});

/** A read-only fake: sms_opt_outs rows, answered for eq filters the way PostgREST would; every read recorded. */
function readerAdmin(rows: Record<string, unknown>[]) {
  const reads: { table: string; cols: string; filters: string[] }[] = [];
  const admin = {
    from(table: string) {
      const r = { table, cols: "", filters: [] as string[] };
      reads.push(r);
      const eqs: [string, unknown][] = [];
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select(cols: string) { r.cols = cols; return q; },
        eq(col: string, val: unknown) { eqs.push([col, val]); r.filters.push(`${col}=${val}`); return q; },
        maybeSingle() {
          const hits = rows.filter((row) => eqs.every(([c, v]) => String(row[c]) === String(v)));
          return Promise.resolve({ data: hits[0] ?? null, error: null });
        },
      };
      return q;
    },
  };
  return { admin, reads };
}

Deno.test("readSmsOptOut: this business's row for the number, never another's; no number, nothing asked", async () => {
  const rows = [
    { client_id: "tenant-a", phone_digits: "5550100002", reason: "operator", effective_at: "2026-10-01T15:00:00.000Z" },
    { client_id: "tenant-b", phone_digits: "5550100009", reason: "sms_stop", effective_at: "2026-10-02T15:00:00.000Z" },
  ];
  const { admin, reads } = readerAdmin(rows);
  const mine = await readSmsOptOut(admin, "tenant-a", "5550100002");
  assertEquals(mine, { data: { ...rows[0] }, error: null });
  assertEquals(reads[0], { table: "sms_opt_outs", cols: "reason, effective_at", filters: ["client_id=tenant-a", "phone_digits=5550100002"] });
  assertEquals(smsOptOutFacts(mine.data, null), { optedOut: true, at: "2026-10-01T15:00:00.000Z", reason: "team" });
  // Another business opted this number out: not this one's opt-out (migration 164: per tenant).
  const theirs = await readSmsOptOut(admin, "tenant-a", "5550100009");
  assertEquals(theirs.data, null);
  assertEquals(smsOptOutFacts(theirs.data, null).optedOut, false);
  // A contact with no number: nothing to ask, and no read made.
  for (const none of [null, undefined, ""]) {
    const before = reads.length;
    assertEquals(await readSmsOptOut(admin, "tenant-a", none), { data: null, error: null });
    assertEquals(reads.length, before, String(none));
  }
});

Deno.test("opted out on either record, as the send path refuses on either; when and why from the number's row first", () => {
  // The number's row alone: a STOP before the contact was saved, an import, the team.
  assertEquals(smsOptOutFacts({ reason: "operator", effective_at: "2026-10-01T15:00:00.000Z" }, null),
    { optedOut: true, at: "2026-10-01T15:00:00.000Z", reason: "team" });
  // The contact's older flag alone: opted out, why unknown.
  assertEquals(smsOptOutFacts(null, "2026-09-01T15:00:00.000Z"), { optedOut: true, at: "2026-09-01T15:00:00.000Z", reason: "other" });
  // Both: the row says when and why.
  assertEquals(smsOptOutFacts({ reason: "sms_stop", effective_at: "2026-10-02T15:00:00.000Z" }, "2026-09-01T15:00:00.000Z"),
    { optedOut: true, at: "2026-10-02T15:00:00.000Z", reason: "stop" });
  // A row read without its time still counts.
  assertEquals(smsOptOutFacts({ reason: "sms_stop" }), { optedOut: true, at: null, reason: "stop" });
  // Neither.
  for (const row of [null, undefined]) assertEquals(smsOptOutFacts(row, null), { optedOut: false, at: null, reason: null });
});

Deno.test("the consent refusal is worded by reason, and every one says the customer's START lifts it", () => {
  assertEquals(smsOptOutRefusal("stop"), "This customer replied STOP. Only they can undo that, by replying START to that number.");
  assert(smsOptOutRefusal("team").startsWith("Your team recorded that this customer doesn't want texts."));
  assert(smsOptOutRefusal("other").startsWith("This customer opted out of texts."));
  for (const r of ["stop", "team", "other", null] as const) assert(smsOptOutRefusal(r).includes("replying START"), String(r));
  assert(!smsOptOutRefusal("team").includes("STOP") && !smsOptOutRefusal("other").includes("STOP"), "only a STOP says STOP");
});
