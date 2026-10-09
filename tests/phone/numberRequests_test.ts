// Workstream 2, phase 8, portal-settings: "Bring your number" (phone_port_request) and landing a moved
// number (phone_adopt_number). The card itself is driven on the compiled portal by
// tests/harness/bringYourNumber.mjs.
//
// What is pinned:
//   * parsePortRequest: the six fields only; any key naming a PIN, password, account number or bill
//     refuses the whole request; five digits in a free-text box are refused even spaced or dashed,
//     and any digit after PIN / acct / account (review 2026-10-09), while dates and times in the
//     timing note are not; numbers are normalised to E.164, toll-free refused, at most ten,
//     duplicates folded;
//   * portRequestConflict: five open requests a builder, a number already on THEIR account, a number
//     THEY already asked for; never another builder's (review 2026-10-09);
//   * adoptNumber, every branch against stubs: already this builder's, another builder's (refused),
//     found in the builder's own account (recorded with the sub's SID), on the parent while the
//     builder is on a sub (refused, never recorded), named at Twilio for another builder (refused),
//     on the parent with no open request of the builder's naming it (refused), nowhere (404),
//     Twilio down (502);
//   * lookupOnlyEnv: the adoption looks the account up as "manual" does and never makes one;
//   * portal-settings, read from the SHIPPED source: GATES lines for both actions; the request reads
//     only the builder's own rows; the adoption is the caller-ID operator gate plus canBill, the
//     switch-off sub check, then the account (lookup only), then adoptNumber, BEFORE any webhook is
//     changed; open requests naming the number are marked done.
// Behaviour through the real handler: supabase/functions/_shared/_test_stubs/numberRequestsHandler_test.ts.
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  adoptNumber, looksSecret, lookupOnlyEnv, MAX_OPEN_REQUESTS, MAX_REQUEST_NUMBERS, parseAdoptNumber, parsePortRequest,
  PORT_SECRET_SENTENCE, portNumberE164, portRequestConflict, portRequestRow, portRequestView,
} from "../../supabase/functions/portal-settings/numberRequests.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SRC = await read("../../supabase/functions/portal-settings/index.ts");
const MIG = await read("../../supabase/migrations/298_phone_number_requests.sql");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`numberRequests_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const GOOD = {
  numbers: ["(816) 555-0123", "816-555-0124", "+18165550123"], currentCarrier: "  Verizon  ", isLcPhone: "no",
  contactName: "Pat Example", contactEmail: "Pat@Builder.Example.Test", cutoverWindow: "weekday evenings after the 20th",
};

Deno.test("parsePortRequest: six fields, normalised; duplicates folded; GoHighLevel yes/no/not sure", () => {
  const r = parsePortRequest(GOOD);
  assert(r.ok);
  assertEquals(r.value, {
    numbers: ["+18165550123", "+18165550124"], currentCarrier: "Verizon", isLcPhone: false,
    contactName: "Pat Example", contactEmail: "pat@builder.example.test", cutoverWindow: "weekday evenings after the 20th",
  });
  assertEquals((parsePortRequest({ ...GOOD, isLcPhone: true }) as { value: { isLcPhone: unknown } }).value.isLcPhone, true);
  assertEquals((parsePortRequest({ ...GOOD, isLcPhone: "" }) as { value: { isLcPhone: unknown } }).value.isLcPhone, null);
  assertEquals((parsePortRequest({ ...GOOD, numbers: "8165550123; 816 555 0125" }) as { value: { numbers: string[] } }).value.numbers, ["+18165550123", "+18165550125"]);
  assertEquals((parsePortRequest({ ...GOOD, cutoverWindow: "" }) as { value: { cutoverWindow: unknown } }).value.cutoverWindow, null);
});

Deno.test("parsePortRequest: a PIN, password, account number or bill is never taken, by key or by a run of digits", () => {
  for (const key of ["pin", "PIN", "accountNumber", "account_number", "password", "bill", "loa", "ssn"]) {
    const r = parsePortRequest({ ...GOOD, [key]: "1234" });
    assert(!r.ok && r.error === PORT_SECRET_SENTENCE, `${key} was not refused`);
  }
  for (const [field, v] of [["currentCarrier", "AT&T acct 1234567"], ["contactName", "Pat 55512"], ["cutoverWindow", "PIN 482913"]] as const) {
    const r = parsePortRequest({ ...GOOD, [field]: v });
    assert(!r.ok && r.error === PORT_SECRET_SENTENCE, `${field}: ${v} was not refused`);
  }
  assert(parsePortRequest({ ...GOOD, cutoverWindow: "after 10/20 at 5pm" }).ok, "a date and a time are not a secret");
});

Deno.test("looksSecret: short, spaced and dashed PINs and account numbers are caught; dates, times and names are not (review 2026-10-09)", () => {
  // The review's four, each of which a bare \d{5,} let through, plus the same family.
  for (const v of ["PIN 4829", "PIN 48 29 13", "acct 287-123-456", "Verizon 1234-5678-9012", "pin: 12", "Acct #9", "account no. 4", "passcode 0000", "1234.5678", "48 29 13 77"]) {
    assert(looksSecret(v), `not caught: ${v}`);
    assert(looksSecret(v, { dates: true }), `not caught in the timing note: ${v}`);
    const r = parsePortRequest({ ...GOOD, cutoverWindow: v });
    assert(!r.ok && r.error === PORT_SECRET_SENTENCE, `the request was not refused for: ${v}`);
  }
  for (const v of ["Pinnacle Telecom", "AT&T 2025 plan, 3 lines", "Spin Wireless", "Pat Example"]) assert(!looksSecret(v), `wrongly caught: ${v}`);
  for (const v of ["after 10/20/2026, 9am-5pm", "2026-10-27 at 17:00", "weekday evenings after the 20th", "Oct 20 2026 or 10-21-26, 9:30 pm", "between 10/20 and 10/25"]) {
    assert(!looksSecret(v, { dates: true }), `a date or time was taken for a secret: ${v}`);
    assert(parsePortRequest({ ...GOOD, cutoverWindow: v }).ok, `the request was refused for: ${v}`);
  }
  assert(looksSecret("10/20/2026"), "outside the timing note a date is digits like any other");
});

Deno.test("parsePortRequest: refusals in words", () => {
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...GOOD, numbers: [] }, /Enter the number/],
    [{ ...GOOD, numbers: ["555-0123"] }, /isn't a US phone number/],
    [{ ...GOOD, numbers: ["(800) 555-0123"] }, /Toll-free/],
    [{ ...GOOD, numbers: Array.from({ length: MAX_REQUEST_NUMBERS + 1 }, (_, i) => `816555${String(1000 + i)}`) }, /at most 10/],
    [{ ...GOOD, currentCarrier: "" }, /which company/],
    [{ ...GOOD, contactName: "P" }, /approve the move/],
    [{ ...GOOD, contactEmail: "pat" }, /email address/],
    [{ ...GOOD, cutoverWindow: "x".repeat(201) }, /under 200/],
  ];
  for (const [raw, re] of bad) {
    const r = parsePortRequest(raw);
    assert(!r.ok && re.test(r.error), JSON.stringify(r));
  }
  assertEquals(portNumberE164("1 (816) 555-0123"), "+18165550123");
  assertEquals(portNumberE164("(116) 555-0123"), null);
  assertEquals(parseAdoptNumber("(888) 555-0123"), null);
  assertEquals(parseAdoptNumber("+1 816 555 0123"), "+18165550123");
});

Deno.test("the stored row and the builder's view carry only the request", () => {
  const r = parsePortRequest(GOOD);
  assert(r.ok);
  const row = portRequestRow("demo-builder", "00000000-0000-4000-8000-000000000002", r.value);
  assertEquals(Object.keys(row).sort(), ["client_id", "contact_email", "contact_name", "current_carrier", "cutover_window", "is_lc_phone", "numbers", "requested_by", "status"]);
  assertEquals(row.status, "new");
  const v = portRequestView({ id: "r1", ...row, created_at: "2026-10-09T12:00:00Z" });
  assertEquals([v.status, v.numbers.length, v.isLcPhone], ["new", 2, false]);
});

Deno.test("portRequestConflict: too many open, already on THEIR account, already in one of THEIR requests", () => {
  const r = parsePortRequest(GOOD);
  assert(r.ok);
  assert(/already have 5 requests open/.test(portRequestConflict(r.value, { openForTenant: MAX_OPEN_REQUESTS, ownOpenNumbers: [], ownLiveNumbers: [] }) ?? ""));
  assert(/\+18165550124 is already on your account/.test(portRequestConflict(r.value, { openForTenant: 0, ownOpenNumbers: [], ownLiveNumbers: ["+18165550124"] }) ?? ""));
  assert(/already in one of your open requests/.test(portRequestConflict(r.value, { openForTenant: 0, ownOpenNumbers: ["+18165550123"], ownLiveNumbers: [] }) ?? ""));
  assertEquals(portRequestConflict(r.value, { openForTenant: 4, ownOpenNumbers: ["+19135550100"], ownLiveNumbers: [] }), null);
  // Nothing in the sentences names or hints at another business (review 2026-10-09).
  for (const s of [portRequestConflict(r.value, { openForTenant: 0, ownOpenNumbers: [], ownLiveNumbers: ["+18165550124"] }) ?? ""]) {
    assert(!/Structure Studio\./.test(s) && !/has already been asked/.test(s), s);
  }
});

// ── adoptNumber ──────────────────────────────────────────────────────────────────────────────
const PN = "PN" + "7".repeat(32);
const SUB = "AC" + "7".repeat(32);
function deps(o: {
  live?: { id: string; client_id: string } | null; liveFails?: boolean;
  tenant?: string | null | "down"; parent?: string | null; onSub?: boolean; recordFails?: boolean;
  /** The number's Twilio FriendlyName; and whether a name is another builder's client id. */
  name?: string | null; otherTenants?: string[];
  /** An open request of this builder's names the number (default: yes). */
  requested?: boolean;
}) {
  const log: string[] = [];
  return {
    log,
    d: {
      tenantId: "demo-builder",
      liveRow: () => { log.push("live"); return Promise.resolve(o.liveFails ? { ok: false as const, error: { code: "XX" } } : { ok: true as const, row: o.live ?? null }); },
      findInTenant: () => {
        log.push("tenant");
        return Promise.resolve(o.tenant === "down" ? { ok: false as const, status: 503, code: 20500 } : { ok: true as const, sid: o.tenant ?? null, friendlyName: o.name ?? "(816) 555-0123" });
      },
      isOtherTenant: (name: string) => { log.push(`other? ${name}`); return Promise.resolve({ ok: true as const, other: (o.otherTenants ?? []).includes(name) }); },
      openRequestNames: () => { log.push("requested?"); return Promise.resolve({ ok: true as const, open: o.requested !== false }); },
      findInParent: o.onSub ? () => { log.push("parent"); return Promise.resolve({ ok: true as const, sid: o.parent ?? null }); } : null,
      record: (sid: string) => {
        log.push(`record ${sid.slice(0, 2)}`);
        return Promise.resolve(o.recordFails ? { ok: false as const, error: { code: "23505" } } : { ok: true as const, row: { id: "n9", phone_number: "+18165550123", twilio_sid: sid } });
      },
    },
  };
}
const E = "+18165550123";

Deno.test("adoptNumber: found in the builder's own account, recorded; already theirs, nothing to do", async () => {
  const a = deps({ tenant: PN, onSub: true });
  const out = await adoptNumber({ e164: E, subAccountSid: SUB }, a.d);
  assert(out.ok && !out.already && out.sid === PN, JSON.stringify(out));
  assertEquals(a.log, ["live", "tenant", "record PN"], "the parent is never asked when the number is where it should be");
  const b = deps({ live: { id: "n1", client_id: "demo-builder" } });
  assertEquals(await adoptNumber({ e164: E, subAccountSid: null }, b.d), { ok: true, already: true, rowId: "n1" });
  assertEquals(b.log, ["live"]);
});

Deno.test("adoptNumber: another builder's number, or one in a different account, is refused and never recorded", async () => {
  const other = deps({ live: { id: "n2", client_id: "someone-else" } });
  const o = await adoptNumber({ e164: E, subAccountSid: null }, other.d);
  assert(!o.ok && o.kind === "refused" && o.status === 409 && o.code === "number_elsewhere");
  const onParent = deps({ tenant: null, parent: PN, onSub: true });
  const p = await adoptNumber({ e164: E, subAccountSid: SUB }, onParent.d);
  assert(!p.ok && p.kind === "refused" && p.code === "number_on_parent", JSON.stringify(p));
  assert(!onParent.log.some((l) => l.startsWith("record")));
  const nowhere = deps({ tenant: null, parent: null, onSub: true });
  const n = await adoptNumber({ e164: E, subAccountSid: SUB }, nowhere.d);
  assert(!n.ok && n.kind === "refused" && n.status === 404 && n.code === "number_not_in_account");
  const parentTenant = deps({ tenant: null });
  const q = await adoptNumber({ e164: E, subAccountSid: null }, parentTenant.d);
  void q;
  assert(!q.ok && q.kind === "refused" && q.status === 404);
  assertEquals(parentTenant.log, ["live", "tenant"], "a builder on the parent asks nothing more");
  const down = deps({ tenant: "down" });
  const d = await adoptNumber({ e164: E, subAccountSid: null }, down.d);
  assert(!d.ok && d.kind === "twilio" && d.status === 502);
  const dbDown = deps({ liveFails: true });
  assert(!(await adoptNumber({ e164: E, subAccountSid: null }, dbDown.d)).ok);
});

Deno.test("adoptNumber: a number named at Twilio for ANOTHER builder is refused (review 2026-10-09)", async () => {
  const a = deps({ tenant: PN, onSub: true, name: "someone-else", otherTenants: ["someone-else"] });
  const out = await adoptNumber({ e164: E, subAccountSid: SUB }, a.d);
  assert(!out.ok && out.kind === "refused" && out.status === 409 && out.code === "number_named_for_other", JSON.stringify(out));
  assert(!a.log.some((l) => l.startsWith("record")));
  // Its own name, Twilio's default "(816) 555-0123", or a slug that is nobody's: adopted.
  for (const name of ["demo-builder", "(816) 555-0123", "main-line"]) {
    const b = deps({ tenant: PN, onSub: true, name, otherTenants: ["someone-else"] });
    assert((await adoptNumber({ e164: E, subAccountSid: SUB }, b.d)).ok, name);
  }
});

Deno.test("adoptNumber on the PARENT: only for an open request of this builder's naming it; a sub-account needs none (review 2026-10-09)", async () => {
  const none = deps({ tenant: PN, requested: false });
  const out = await adoptNumber({ e164: E, subAccountSid: null }, none.d);
  assert(!out.ok && out.kind === "refused" && out.status === 409 && out.code === "no_open_request", JSON.stringify(out));
  assertEquals(none.log, ["live", "tenant", "requested?"], "nothing recorded");
  const asked = deps({ tenant: PN, requested: true });
  assert((await adoptNumber({ e164: E, subAccountSid: null }, asked.d)).ok);
  assertEquals(asked.log, ["live", "tenant", "requested?", "record PN"]);
  const sub = deps({ tenant: PN, onSub: true, requested: false });
  assert((await adoptNumber({ e164: E, subAccountSid: SUB }, sub.d)).ok, "the builder's own sub-account: any number in it is theirs");
  assert(!sub.log.includes("requested?"));
});

Deno.test("lookupOnlyEnv: TWILIO_SUBACCOUNTS on reads as manual, so an adoption never makes an account (review 2026-10-09)", () => {
  const env = (v: string | undefined) => lookupOnlyEnv((k) => (k === "TWILIO_SUBACCOUNTS" ? v : `value-of-${k}`));
  assertEquals(env("on")("TWILIO_SUBACCOUNTS"), "manual");
  assertEquals(env("manual")("TWILIO_SUBACCOUNTS"), "manual");
  assertEquals(env(undefined)("TWILIO_SUBACCOUNTS"), undefined);
  assertEquals(env("on")("TWILIO_ACCOUNT_SID"), "value-of-TWILIO_ACCOUNT_SID");
});

Deno.test("portal-settings: the gates, the adoption's order, and requests marked done", () => {
  assert(/  phone_port_request: \{ area: "phone", level: "edit" \},/.test(SRC));
  assert(/  phone_adopt_number: \{ area: "phone", level: "edit" \},/.test(SRC));
  const port = slice(SRC, 'if (action === "phone_port_request") {', 'if (action === "phone_adopt_number") {', "phone_port_request");
  assert(/const parsed = parsePortRequest\(payload\?\.request\);/.test(port), "only the request object is read");
  assert(port.indexOf("parsePortRequest(") < port.indexOf(".insert("), "nothing is written before it is parsed");
  assert(/select\("numbers"\)\.eq\("client_id", clientId\)\s*\.in\("status", \["new", "in_progress"\]\)\.overlaps\("numbers", v\.numbers\)/.test(port),
    "only this builder's own open requests are read (review 2026-10-09)");
  assert(/select\("phone_number"\)\.eq\("client_id", clientId\)\s*\.in\("phone_number", v\.numbers\)/.test(port), "only this builder's own live numbers are read");
  assert(!/\.from\("phone_number_requests"\)\.select\("numbers"\)\.in\(/.test(port), "no read across builders");
  const adopt = slice(SRC, 'if (action === "phone_adopt_number") {', "\n  // ── The Calls report", "phone_adopt_number");
  const order = ["phoneOperatorGate()", "operator.canBill", "parseAdoptNumber(", "subAccountWhileOff(", "ensureTwilioAccount(admin, clientId, { get: lookupOnlyEnv(", "tenantTwilio()", "adoptNumber(", "applyNumberVoice("];
  let at = -1;
  for (const step of order) {
    const i = adopt.indexOf(step);
    assert(i > at, `${step} out of order`);
    at = i;
  }
  assert(/callingOnlyNumberRow\(clientId, \{ sid, phoneNumber: e164 \}, subAccountSid\)/.test(adopt), "recorded as a calling-only number, with the sub's SID");
  assert(/findInParent: parent \? \(n\) => findNumberSid\(\{ creds: parent, e164: n \}\) : null/.test(adopt), "the parent asked only for a builder on a sub");
  assert(/\.contains\("numbers", \[e164\]\)/.test(adopt) && /status: "done"/.test(adopt), "open requests naming it are marked done");
  assert(!/wallet_hold|takeNumberHold/.test(adopt), "no wallet hold: nothing is bought");
});

Deno.test("migration 298 has every column the code writes and reads", () => {
  for (const col of ["client_id", "numbers", "current_carrier", "is_lc_phone", "contact_name", "contact_email", "cutover_window", "status", "requested_by", "handled_by", "handled_at", "created_at", "updated_at"]) {
    assert(new RegExp(`\\n  ${col}\\s`).test(MIG), `298 has no ${col}`);
  }
  assert(/status in \('new', 'in_progress', 'done', 'cancelled'\)/.test(MIG));
});
