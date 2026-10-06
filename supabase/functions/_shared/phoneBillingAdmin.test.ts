// Unit tests for _shared/phoneBillingAdmin.ts — the operator half of phone & text usage
// billing (admin-catalog's phone_billing_* actions and the Admin → Billing card).
//
// What is pinned here is what an operator cannot see from the console:
//   * a price save that would quietly store the wrong number (a string, a cent value where
//     micros were meant, a fourth markup decimal the column rounds away, a misspelt key that
//     saves nothing) is REFUSED, and who-is-charged can never ride along on a price save;
//   * "charging is on" is read the way migration 259's gate reads it — in particular a pilot
//     list left behind after a disarm counts as ON, because the gate charges pilots on
//     membership alone;
//   * the report's "would have charged" uses the worker's rule (round half up, capped at
//     ceiling × units), and its account total does not count Twilio's nested categories twice.
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
import {
  chargingMode, describeSettingsChange, microsToDollars, monthRange, normalizePilotIds,
  normalizeSettings, parseSettingsPatch, phoneBillingDbError, previewChargeMicros,
  summarizePhoneUsage, twilioAccountTotals,
} from "./phoneBillingAdmin.ts";
import type { UsageChargeRow } from "./phoneBillingAdmin.ts";

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
const assertThrows = (fn: () => unknown, match: RegExp, msg?: string) => {
  try { fn(); } catch (e) {
    const m = (e as Error).message;
    if (!match.test(m)) throw new Error(`${msg ?? "wrong error"}: "${m}" does not match ${match}`);
    return;
  }
  throw new Error(msg ?? `expected a throw matching ${match}`);
};

const ENVELOPE = new Set(["action", "adminPassword"]);
const SEED = normalizeSettings({
  markup: null, floor_cents: 500, carrier_fee_out_micros: 4500, carrier_fee_in_micros: 3500,
  fallback_out_min_micros: 14000, fallback_in_min_micros: 8500, fallback_client_min_micros: 4000,
  fallback_sms_seg_micros: 8300, fallback_after_hours: 6, ceiling_min_micros: null, ceiling_seg_micros: null,
  bill_unanswered_calls: false, pilot_client_ids: [], armed_at: null,
});
const ALL_ACTIVE = ["voice_minute", "voice_minute_in", "sms_segment", "sms_in"].map((kind) => ({ kind, active: true }));
const NONE_ACTIVE = ALL_ACTIVE.map((m) => ({ ...m, active: false }));

// ── parseSettingsPatch ──────────────────────────────────────────────────────────────────

Deno.test("a valid price save becomes exactly the columns that were sent", () => {
  const patch = parseSettingsPatch({
    action: "phone_billing_set", adminPassword: "x",
    markup: 2.5, floor_cents: 600, ceiling_min_micros: 20000, ceiling_seg_micros: null, bill_unanswered_calls: true,
  }, ENVELOPE);
  assertEquals(patch, { markup: 2.5, floor_cents: 600, ceiling_min_micros: 20000, ceiling_seg_micros: null, bill_unanswered_calls: true });
});

Deno.test("the markup is 1 to 10 with at most three decimals, or blank", () => {
  assertEquals(parseSettingsPatch({ markup: 1 }, ENVELOPE), { markup: 1 });
  assertEquals(parseSettingsPatch({ markup: 10 }, ENVELOPE), { markup: 10 });
  assertEquals(parseSettingsPatch({ markup: 1.875 }, ENVELOPE), { markup: 1.875 });
  assertEquals(parseSettingsPatch({ markup: null }, ENVELOPE), { markup: null });
  assertThrows(() => parseSettingsPatch({ markup: 0.99 }, ENVELOPE), /from 1 to 10/);
  assertThrows(() => parseSettingsPatch({ markup: 10.001 }, ENVELOPE), /from 1 to 10/);
  // numeric(6,3) would store 2.001 and charge on it while the screen said 2.0005.
  assertThrows(() => parseSettingsPatch({ markup: 2.0005 }, ENVELOPE), /three decimal/);
  // A string is refused, not coerced: "2,5" would otherwise become NaN.
  assertThrows(() => parseSettingsPatch({ markup: "2.5" }, ENVELOPE), /from 1 to 10/);
  assertThrows(() => parseSettingsPatch({ markup: Number.NaN }, ENVELOPE), /from 1 to 10/);
});

Deno.test("money fields are whole micros (or cents) inside their rails", () => {
  assertThrows(() => parseSettingsPatch({ carrier_fee_out_micros: 45.5 }, ENVELOPE), /between \$0\.00 and \$0\.05/);
  assertThrows(() => parseSettingsPatch({ carrier_fee_out_micros: -1 }, ENVELOPE), /carrier fee on a text sent/);
  assertThrows(() => parseSettingsPatch({ floor_cents: 50_001 }, ENVELOPE), /between \$0\.00 and \$500\.00/);
  assertThrows(() => parseSettingsPatch({ fallback_after_hours: 0 }, ENVELOPE), /hours from 1 to 72/);
  // A cap of 0 would make every call free; blank is how "no cap" is said.
  assertThrows(() => parseSettingsPatch({ ceiling_min_micros: 0 }, ENVELOPE), /most per call minute/);
  assertThrows(() => parseSettingsPatch({ floor_cents: null }, ENVELOPE), /can't be blank/);
  assertThrows(() => parseSettingsPatch({ bill_unanswered_calls: "yes" }, ENVELOPE), /on or off/);
});

Deno.test("an unknown key refuses the whole save instead of saving the rest", () => {
  assertThrows(() => parseSettingsPatch({ markup: 2, flor_cents: 600 }, ENVELOPE), /Unknown setting "flor_cents"/);
  assertThrows(() => parseSettingsPatch({ action: "phone_billing_set" }, ENVELOPE), /Nothing to save/);
});

Deno.test("who is charged can never ride along on a price save", () => {
  assertThrows(() => parseSettingsPatch({ markup: 2, pilot_client_ids: ["tenant-a"] }, ENVELOPE), /Start charging/);
  assertThrows(() => parseSettingsPatch({ armed_at: "2026-10-02T00:00:00Z" }, ENVELOPE), /Start charging/);
});

Deno.test("the audit line names only what changed", () => {
  const after = { ...SEED, markup: 2, floor_cents: 700 };
  assertEquals(describeSettingsChange(SEED, after), ["markup (none) -> 2", "floor_cents 500 -> 700"]);
});

// ── pilot list ──────────────────────────────────────────────────────────────────────────

Deno.test("pilot ids are trimmed, lower-cased, deduped and shape-checked", () => {
  assertEquals(normalizePilotIds([" Tenant-A ", "tenant-a", "tenant-b", ""]), ["tenant-a", "tenant-b"]);
  assertThrows(() => normalizePilotIds(["tenant a"]), /isn't a builder id/);
  assertThrows(() => normalizePilotIds("tenant-a"), /list of builder ids/);
  assertThrows(() => normalizePilotIds([1]), /list of builder ids/);
  assertThrows(() => normalizePilotIds(Array.from({ length: 51 }, (_, i) => `t-${i}`)), /at most 50/);
});

// ── chargingMode ────────────────────────────────────────────────────────────────────────

Deno.test("off, pilot and all read the way the gate does", () => {
  const armed = { ...SEED, markup: 2, armed_at: "2026-10-02T10:00:00Z" };
  assertEquals(chargingMode(SEED, NONE_ACTIVE).mode, "off");
  assertEquals(chargingMode(armed, NONE_ACTIVE).mode, "off", "armed_at kept after a clean disarm is off");
  assertEquals(chargingMode({ ...armed, pilot_client_ids: ["tenant-a"] }, NONE_ACTIVE).mode, "pilot");
  assertEquals(chargingMode(armed, ALL_ACTIVE).mode, "all");
});

Deno.test("anything our buttons cannot produce is partial, never off", () => {
  const armed = { ...SEED, markup: 2, armed_at: "2026-10-02T10:00:00Z" };
  const some = NONE_ACTIVE.map((m) => (m.kind === "sms_segment" ? { ...m, active: true } : m));
  const v = chargingMode(armed, some);
  assertEquals(v.mode, "partial");
  assertEquals(v.activeMeters, ["sms_segment"]);
  // Meters switched on with no markup: nothing is charged today, but saving a markup would
  // start charging without anyone pressing Start. That must not read as "off".
  assertEquals(chargingMode({ ...SEED, armed_at: "2026-10-02T10:00:00Z" }, ALL_ACTIVE).mode, "partial");
  assertEquals(chargingMode({ ...SEED, markup: 2, pilot_client_ids: ["tenant-a"] }, NONE_ACTIVE).mode, "partial");
});

// ── previewChargeMicros ─────────────────────────────────────────────────────────────────

Deno.test("would-have-charged is cost × markup, rounded half up, capped at ceiling × units", () => {
  const s = { markup: 2, ceiling_min_micros: null, ceiling_seg_micros: null };
  assertEquals(previewChargeMicros(14000, 1, "minute", s), 28000);
  // 4150 × 1.5 = 6225; 4151 × 1.5 = 6226.5 → 6227 (half up, in integer thousandths).
  assertEquals(previewChargeMicros(4151, 1, "segment", { ...s, markup: 1.5 }), 6227);
  // 0.1 + 0.2 territory: 3 × 1.1 must be 3.3 exactly, not 3.3000000000000003 rounded down.
  assertEquals(previewChargeMicros(3, 1, "minute", { ...s, markup: 1.1 }), 3);
  assertEquals(previewChargeMicros(5, 1, "minute", { ...s, markup: 1.1 }), 6);
  // A 3-minute call that cost 42,000 at 2× would be 84,000; a 20,000/min cap holds it at 60,000.
  assertEquals(previewChargeMicros(42000, 3, "minute", { ...s, ceiling_min_micros: 20000 }), 60000);
  // The minute cap never touches a text, and vice versa.
  assertEquals(previewChargeMicros(12800, 1, "segment", { ...s, ceiling_min_micros: 1 }), 25600);
  assertEquals(previewChargeMicros(12800, 2, "segment", { ...s, ceiling_seg_micros: 10000 }), 20000);
  assertEquals(previewChargeMicros(14000, 1, "minute", { ...s, markup: null }), null);
});

// ── monthRange ──────────────────────────────────────────────────────────────────────────

Deno.test("a month is a UTC month, and Twilio's snapshots can only exist up to yesterday", () => {
  const now = new Date("2026-10-02T15:00:00Z");
  const oct = monthRange("2026-10", now);
  assertEquals([oct.from, oct.to, oct.days, oct.daysExpected], ["2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", 31, 1]);
  assertEquals(monthRange("2026-09", now).daysExpected, 30);
  assertEquals(monthRange("2026-11", now).daysExpected, 0);
  assertEquals(monthRange("2028-02", now).days, 29);
  assertThrows(() => monthRange("2026-13", now), /YYYY-MM/);
  assertThrows(() => monthRange("26-10", now), /YYYY-MM/);
  assertThrows(() => monthRange(undefined, now), /YYYY-MM/);
});

// ── twilioAccountTotals ─────────────────────────────────────────────────────────────────

Deno.test("Twilio's nested categories are counted once", () => {
  const rows = [
    { day: "2026-09-01", category: "calls", count: 10, usage: 30, price_micros: 400000 },
    { day: "2026-09-01", category: "calls-inbound", count: 4, usage: 12, price_micros: 100000 },
    { day: "2026-09-01", category: "calls-outbound", count: 6, usage: 18, price_micros: 300000 },
    { day: "2026-09-01", category: "sms-outbound", count: 20, usage: 25, price_micros: 207500 },
    { day: "2026-09-02", category: "sms-inbound", count: 5, usage: 5, price_micros: "41500" },
    { day: "2026-09-02", category: "sms-messages-carrierfees", count: 25, usage: 25, price_micros: 100000 },
    { day: "2026-09-02", category: "recordings", count: 1, usage: 1, price_micros: 2500 },
  ];
  const t = twilioAccountTotals(rows);
  // calls (400000) + sms-outbound + sms-inbound + carrier fees + recordings; the two call
  // children are inside `calls` and must not be added again.
  assertEquals(t.totalMicros, 400000 + 207500 + 41500 + 100000 + 2500);
  assertEquals(t.daysCovered, 2);
  assertEquals(t.categories.filter((c) => !c.inTotal).map((c) => c.category), ["calls-inbound", "calls-outbound"]);
  // Without the parent stored, the children ARE the total.
  assertEquals(twilioAccountTotals(rows.filter((r) => r.category !== "calls")).totalMicros, 100000 + 300000 + 207500 + 41500 + 100000 + 2500);
  assertEquals(twilioAccountTotals([]).totalMicros, null);
});

// ── summarizePhoneUsage ─────────────────────────────────────────────────────────────────

const RANGE = monthRange("2026-09", new Date("2026-10-02T15:00:00Z"));
const row = (o: Partial<UsageChargeRow>): UsageChargeRow => ({
  client_id: "tenant-a", source: "call", direction: "out", state: "shadow", occurred_at: "2026-09-01T12:00:00+00:00",
  cost_micros: 14000, cost_source: "twilio", units: 1, unit: "minute", charge_micros: null, ...o,
});

Deno.test("a month adds up per builder: cost split, charged, would-charge, absorbed, margin", () => {
  const rows: UsageChargeRow[] = [
    row({ state: "charged", cost_micros: 28000, units: 2, charge_micros: 56000 }),
    row({ state: "shadow", cost_micros: 14000, units: 1 }),
    row({ state: "not_billable", direction: "in", cost_micros: 2000, units: 0 }),
    row({ source: "sms", unit: "segment", state: "shadow", cost_micros: 12800, cost_source: "estimate", units: 2 }),
    row({ source: "sms", unit: "segment", direction: "in", state: "pending", cost_micros: null, units: 1 }),
    row({ client_id: "tenant-b", state: "exempt", cost_micros: 30000, cost_source: "mixed", units: 2, occurred_at: "2026-09-03T01:00:00Z" }),
  ];
  const rep = summarizePhoneUsage({
    range: RANGE, rows, twilio: [{ day: "2026-09-01", category: "calls", price_micros: 60000 }],
    settings: { markup: 2, ceiling_min_micros: null, ceiling_seg_micros: null },
    names: new Map([["tenant-a", "Tenant A"]]),
  });
  const a = rep.tenants.find((t) => t.clientId === "tenant-a")!;
  assertEquals([a.companyName, a.calls, a.callsOut, a.callsIn, a.texts, a.textsIn, a.minutes, a.segments], ["Tenant A", 3, 2, 1, 2, 1, 3, 3]);
  assertEquals([a.costMicros, a.costTwilioMicros, a.costEstimateMicros], [56800, 44000, 12800]);
  assertEquals(a.chargedMicros, 56000);
  assertEquals(a.wouldChargeMicros, 28000 + 25600);
  assertEquals(a.absorbedMicros, 2000);
  assertEquals(a.marginMicros, 56000 - 56800);
  assertEquals(a.projectedMarginMicros, 56000 + 53600 - 56800);
  assertEquals(a.counts, { charged: 1, shadow: 2, exempt: 0, notBillable: 1, pending: 1, failed: 0 });
  const b = rep.tenants.find((t) => t.clientId === "tenant-b")!;
  assertEquals([b.companyName, b.costMixedMicros, b.absorbedMicros, b.marginMicros], ["tenant-b", 30000, 30000, -30000]);
  assertEquals(rep.tenants.map((t) => t.clientId), ["tenant-a", "tenant-b"], "sorted by cost, highest first");
  assertEquals([rep.totals.costMicros, rep.totals.chargedMicros, rep.totals.absorbedMicros], [86800, 56000, 32000]);
  // Twilio covers only Sep 1, so the gap compares it with Sep 1's cost only — tenant-b's
  // Sep 3 call is outside the covered days and would otherwise read as a negative gap.
  assertEquals([rep.account.twilioMicros, rep.account.ourCostCoveredMicros, rep.account.gapMicros], [60000, 56800, 3200]);
  assertEquals([rep.account.daysCovered, rep.account.daysExpected, rep.rowCount], [1, 30, 6]);
});

Deno.test("with no markup, would-have-charged is unknown rather than $0", () => {
  const rep = summarizePhoneUsage({
    range: RANGE, rows: [row({}), row({ client_id: "tenant-b", state: "exempt" })], twilio: [],
    settings: { markup: null, ceiling_min_micros: null, ceiling_seg_micros: null }, names: new Map(),
  });
  const a = rep.tenants.find((t) => t.clientId === "tenant-a")!;
  const b = rep.tenants.find((t) => t.clientId === "tenant-b")!;
  assertEquals([a.wouldChargeMicros, a.projectedMarginMicros], [null, null]);
  assertEquals([b.wouldChargeMicros, b.projectedMarginMicros], [0, -14000], "no shadow rows: nothing would be charged");
  assertEquals(rep.totals.wouldChargeMicros, null);
  assertEquals([rep.account.twilioMicros, rep.account.gapMicros], [null, null]);
});

Deno.test("a recorded call: its recording and transcript add no call minutes, and the transcript stays out of the Twilio gap", () => {
  // One 10-minute call with its recording and its transcript (migration 263): three rows, one call.
  const rows: UsageChargeRow[] = [
    row({ cost_micros: 140000, units: 10 }),
    row({ source: "recording", cost_micros: 25000, units: 10 }),
    row({ source: "transcription", cost_micros: 60000, cost_source: "estimate", units: 10 }),
  ];
  const rep = summarizePhoneUsage({
    range: RANGE, rows,
    twilio: [{ day: "2026-09-01", category: "calls", price_micros: 140000 }, { day: "2026-09-01", category: "recordings", price_micros: 25000 }],
    // A per-minute ceiling holds the call only, as in the worker: the other two lines have none.
    settings: { markup: 2, ceiling_min_micros: 3000, ceiling_seg_micros: null },
    names: new Map(),
  });
  const a = rep.tenants[0];
  assertEquals([a.calls, a.minutes, rep.totals.minutes], [1, 10, 10], "ten call minutes, not thirty");
  assertEquals([a.costMicros, a.costTwilioMicros, a.costEstimateMicros], [225000, 165000, 60000], "our cost is still every line");
  assertEquals(a.wouldChargeMicros, 30000 + 50000 + 120000);
  // Twilio billed the call and the recording; the transcript (Workers AI, Claude) is not on its bill.
  assertEquals([rep.account.twilioMicros, rep.account.ourCostCoveredMicros, rep.account.gapMicros], [165000, 165000, 0]);
});

// ── small helpers ───────────────────────────────────────────────────────────────────────

Deno.test("micros print with the decimals they need", () => {
  assertEquals([microsToDollars(50000), microsToDollars(4500), microsToDollars(1), microsToDollars(1_000_000)],
    ["$0.05", "$0.0045", "$0.000001", "$1.00"]);
});

Deno.test("a missing 259 object reads as not set up, anything else passes through", () => {
  assertEquals(phoneBillingDbError({ code: "42P01", message: "relation does not exist" }).message, "Phone billing isn't set up in the database yet (migration 259 hasn't been applied).");
  assertEquals(phoneBillingDbError({ code: "PGRST205", message: "x" }).message.startsWith("Phone billing isn't set up"), true);
  assertEquals(phoneBillingDbError({ code: "23514", message: "check constraint" }).message, "check constraint");
});
