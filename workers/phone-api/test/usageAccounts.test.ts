// Workstream 2, phase 7: Twilio's daily usage per account (cron/usageCharge.ts snapshotTwilioUsage).
//
// What is pinned:
//   * switch off (and switch on with no active sub-account): the parent's request is exactly the one
//     it always was (yesterday, Twilio's default, so sub-accounts stay folded in and nothing is lost:
//     review 2026-10-09), its rows with no account_sid (NULL = the parent) on migration 299's key
//     (day, account_sid, category); not one extra read while off;
//   * before 299 (42P10, no such key) or before 292's column (42703 / PGRST204) the same rows go in
//     on today's (day, category) key, and that is logged once at info: the Worker deploys safely
//     before or after 299 (and 292);
//   * switch on (or manual) with active subs: the parent asks for its OWN usage (IncludeSubaccounts=
//     false) over the same window as the subs; each active sub in its OWN account (its key pair on
//     its own path), its rows carrying its account SID, over USAGE_LOOKBACK_DAYS days; a sub that
//     collides with the old primary key (23505, migration 300 not applied yet) is skipped and logged
//     at ERROR (its usage is in nobody's row), and the parent and the other subs are still written;
//   * with more subs than USAGE_SUBS_PER_RUN they take turns by day, each asking for every day since
//     its last turn (or the look-back, whichever is longer), and each row keeps its own day.
// Every SID, key and token below is made up.
import { describe, expect, it } from "vitest";
import { adminClient } from "../src/db";
import { installDenoShim } from "../src/env";
import { snapshotTwilioUsage, USAGE_ACCOUNT_KEY, USAGE_LOOKBACK_DAYS, USAGE_SUBS_PER_RUN } from "../src/cron/usageCharge";
import { FakeNet, filter, jsonRes, makeEnv } from "./helpers";

const PARENT = "AC" + "0".repeat(32);
const SUB = "AC" + "5".repeat(32);
const SUB_KEY = "SK" + "5".repeat(32);
const SUB_SECRET = "subkeysecret" + "x".repeat(20);
const OTHER = "AC" + "6".repeat(32);
const AT = new Date("2026-10-10T09:00:00Z");
const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;

const subRow = (client_id: string, account_sid: string) => ({
  client_id, kind: "sub", account_sid, status: "active", api_key_sid: SUB_KEY, api_secret: SUB_SECRET,
  auth_token: "subauthtoken" + "y".repeat(20), twiml_app_sid: null, push_apns_dev_sid: null, push_apns_prod_sid: null, push_fcm_sid: null,
});
const usage = (records: Array<Record<string, unknown>>) => jsonRes({ usage_records: records, next_page_uri: null });
const rec = (category: string, price: string, start_date = "2026-10-09") => ({ category, count: "2", usage: "5", price, price_unit: "usd", start_date });

function world(env = makeEnv({ PHONE_USAGE_COST_CAPTURE: "on" })) {
  const net = new FakeNet().install();
  net.on("GET", (u) => u.pathname === `/2010-04-01/Accounts/${PARENT}/Usage/Records/Daily.json`, () => usage([rec("calls-outbound", "0.43400"), rec("phonenumbers", "1.15")]));
  net.rest("POST", "app_errors", () => []);
  // The shared logger (_shared/logError.ts) reads the env through the Deno shim, as in scheduled().
  installDenoShim(env);
  return { net, env };
}

describe("twilio_usage_daily per account", () => {
  it("switch off: the parent's request as it always was (sub-accounts folded in), no account_sid, on 299's key, nothing else read", async () => {
    const { net, env } = world();
    net.rest("POST", "twilio_usage_daily", () => []);
    const out = await snapshotTwilioUsage(env, adminClient(env), AT);
    expect(out).toEqual({ ran: true, day: "2026-10-09", rows: 1, key: "account", parentAlone: false, from: "2026-10-09", subs: 0, subRows: 0, subsFailed: 0 });
    const q = net.to(/Usage\/Records/)[0].url.searchParams;
    expect([q.get("StartDate"), q.get("EndDate"), q.has("IncludeSubaccounts")]).toEqual(["2026-10-09", "2026-10-09", false]);
    const up = net.writes("twilio_usage_daily", "POST");
    expect(up).toHaveLength(1);
    expect(up[0].url.searchParams.get("on_conflict")).toBe(USAGE_ACCOUNT_KEY);
    expect(up[0].json).toEqual([{ day: "2026-10-09", category: "calls-outbound", count: 2, usage: 5, price_micros: 434000, fetched_at: AT.toISOString() }]);
    expect(net.reads("twilio_accounts")).toHaveLength(0);
    expect(net.rpcCalls("twilio_account_creds")).toHaveLength(0);
  });

  for (const [code, why] of [["42P10", "migration 299 (no such key)"], ["42703", "migration 292 (no account_sid column)"], ["PGRST204", "292, as PostgREST says it"]] as const) {
    it(`before ${why}, ${code}: the same rows on (day, category), logged at info, nothing lost`, async () => {
      const { net, env } = world();
      net.rest("POST", "twilio_usage_daily", (s) => s.url.searchParams.get("on_conflict") === USAGE_ACCOUNT_KEY
        ? jsonRes({ code, message: "the key or the column is not there yet" }, 400)
        : []);
      const out = await snapshotTwilioUsage(env, adminClient(env), AT);
      expect(out.ran && out.key).toBe("legacy");
      const up = net.writes("twilio_usage_daily", "POST").map((s) => [s.url.searchParams.get("on_conflict"), s.json]);
      expect(up[1]).toEqual(["day,category", up[0][1]]);
      expect(JSON.stringify(up[1][1])).not.toContain("account_sid");
      const logged = net.writes("app_errors", "POST").map((s) => s.json);
      expect(logged.map((r) => [r.code, r.severity])).toEqual([["twilio_usage_key_pending", "info"]]);
    });
  }

  it("switch on with no active sub-account yet: exactly the switch-off request, nothing lost", async () => {
    const { net, env: base } = world();
    const env = { ...base, TWILIO_SUBACCOUNTS: "manual" };
    net.rest("GET", "twilio_accounts", () => []);
    net.rest("POST", "twilio_usage_daily", () => []);
    const out = await snapshotTwilioUsage(env, adminClient(env), AT);
    expect(out.ran && [out.parentAlone, out.from, out.subs]).toEqual([false, "2026-10-09", 0]);
    const q = net.to(/Usage\/Records/)[0].url.searchParams;
    expect([q.get("StartDate"), q.has("IncludeSubaccounts")]).toEqual(["2026-10-09", false]);
  });

  it("switch on, the sub-account list unreadable: the parent with sub-accounts folded in, so the total stays whole", async () => {
    const { net, env: base } = world();
    const env = { ...base, TWILIO_SUBACCOUNTS: "on" };
    net.rest("GET", "twilio_accounts", () => jsonRes({ code: "57014", message: "statement timeout" }, 500));
    net.rest("POST", "twilio_usage_daily", () => []);
    const out = await snapshotTwilioUsage(env, adminClient(env), AT);
    expect(out.ran && out.parentAlone).toBe(false);
    expect(net.to(/Usage\/Records/)[0].url.searchParams.has("IncludeSubaccounts")).toBe(false);
    expect(net.writes("app_errors", "POST").map((s) => s.json.code)).toContain("twilio_usage_subs_failed");
  });

  it("switch on: each active sub in its own account, its rows with its SID; a sub on the old key is skipped, the rest written", async () => {
    const { net, env: base } = world();
    const env = { ...base, TWILIO_SUBACCOUNTS: "manual" };
    net.rest("GET", "twilio_accounts", (s) => {
      expect([filter(s, "kind"), filter(s, "status")]).toEqual(["sub", "active"]);
      return [{ client_id: "sub-builder" }, { client_id: "other-builder" }];
    });
    net.rpc("twilio_account_creds", (s) => [s.json.p_client_id === "sub-builder" ? subRow("sub-builder", SUB) : subRow("other-builder", OTHER)]);
    net.on("GET", (u) => u.pathname === `/2010-04-01/Accounts/${SUB}/Usage/Records/Daily.json`, () => usage([rec("calls-inbound", "0.08500")]));
    net.on("GET", (u) => u.pathname === `/2010-04-01/Accounts/${OTHER}/Usage/Records/Daily.json`, () => usage([rec("calls-outbound", "0.01400")]));
    net.rest("POST", "twilio_usage_daily", (s) => (s.json?.[0]?.account_sid === OTHER
      ? jsonRes({ code: "23505", message: "duplicate key value violates unique constraint \"twilio_usage_daily_pkey\"" }, 409)
      : []));
    const out = await snapshotTwilioUsage(env, adminClient(env), AT);
    expect(out).toEqual({ ran: true, day: "2026-10-09", rows: 1, key: "account", parentAlone: true, from: "2026-10-07", subs: 2, subRows: 1, subsFailed: 1 });
    // The parent: its OWN usage, over the same window as the subs.
    const parentQ = net.to(new RegExp(`Accounts/${PARENT}/Usage`))[0].url.searchParams;
    expect([parentQ.get("StartDate"), parentQ.get("EndDate"), parentQ.get("IncludeSubaccounts")]).toEqual(["2026-10-07", "2026-10-09", "false"]);
    const subCall = net.to(new RegExp(`Accounts/${SUB}/Usage`))[0];
    expect(subCall.headers.get("authorization")).toBe(basic(SUB_KEY, SUB_SECRET));
    expect([subCall.url.searchParams.get("StartDate"), subCall.url.searchParams.get("IncludeSubaccounts")]).toEqual(["2026-10-07", "false"]);
    expect(USAGE_LOOKBACK_DAYS).toBe(3);
    const writes = net.writes("twilio_usage_daily", "POST").map((s) => s.json);
    expect(writes[0][0].account_sid).toBeUndefined();
    // client_id order: other-builder (refused on the old key) first, then sub-builder (written).
    expect(writes[1][0].account_sid).toBe(OTHER);
    expect(writes[2]).toEqual([{ day: "2026-10-09", account_sid: SUB, category: "calls-inbound", count: 2, usage: 5, price_micros: 85000, fetched_at: AT.toISOString() }]);
    const logged = net.writes("app_errors", "POST").map((s) => s.json);
    // ERROR, not info (review 2026-10-09): with the parent asking for its own alone, that sub's
    // usage is in nobody's row until 300 is applied.
    expect(logged.map((r) => [r.code, r.severity, r.client_id])).toEqual([["twilio_usage_sub_key_pending", "error", "other-builder"]]);
  });

  it(`more than ${USAGE_SUBS_PER_RUN} subs: they take turns by day, each asking every day since its last turn`, async () => {
    const { net, env: base } = world();
    const env = { ...base, TWILIO_SUBACCOUNTS: "on" };
    const ids = Array.from({ length: USAGE_SUBS_PER_RUN + 1 }, (_, i) => `b-${String(i).padStart(3, "0")}`);
    net.rest("GET", "twilio_accounts", () => ids.map((client_id) => ({ client_id })));
    const sidOf = (id: string) => "AC" + id.replace(/\D/g, "").padStart(32, "7");
    net.rpc("twilio_account_creds", (s) => [subRow(s.json.p_client_id, sidOf(s.json.p_client_id))]);
    net.on("GET", (u) => u.pathname.includes("/Usage/Records/Daily.json") && !u.pathname.includes(PARENT),
      () => usage([rec("calls-inbound", "0.01", "2026-10-08"), rec("calls-inbound", "0.02", "2026-10-09")]));
    net.rest("POST", "twilio_usage_daily", () => []);
    const out = await snapshotTwilioUsage(env, adminClient(env), AT);
    // 51 subs → 2 turns; 2026-10-09 is day 20735 since the epoch → turn 1: the last one only. The
    // window is the look-back (3 days), longer than the 2 turns.
    expect(out.ran && [out.subs, out.subRows]).toEqual([1, 2]);
    const q = net.to(/Usage\/Records/).filter((s) => !s.url.pathname.includes(PARENT))[0].url.searchParams;
    expect([q.get("StartDate"), q.get("EndDate")]).toEqual(["2026-10-07", "2026-10-09"]);
    const subWrite = net.writes("twilio_usage_daily", "POST")[1].json;
    expect(subWrite.map((r: { day: string }) => r.day)).toEqual(["2026-10-08", "2026-10-09"]);
  });
});
