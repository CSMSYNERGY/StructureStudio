// Workstream 2, phase 7: Twilio's daily usage per account (cron/usageCharge.ts snapshotTwilioUsage).
//
// What is pinned:
//   * the parent alone (IncludeSubaccounts=false), its rows with no account_sid (NULL = the parent),
//     on migration 298's key (day, account_sid, category);
//   * before 298 (42P10, no such key) the same rows go in on today's (day, category) key, and that
//     is logged once at info: the Worker deploys safely before or after 298;
//   * switch off: not one extra read (no twilio_accounts, no twilio_account_creds);
//   * switch on (or manual): each active sub in its OWN account (its key pair on its own path), its
//     rows carrying its account SID; a sub that collides with the old primary key (23505, migration
//     299 not applied yet) is skipped and logged, and the parent and the other subs are still written;
//   * with more subs than USAGE_SUBS_PER_RUN they take turns by day, each asking for every day since
//     its last turn, and each row keeps its own day.
// Every SID, key and token below is made up.
import { describe, expect, it } from "vitest";
import { adminClient } from "../src/db";
import { installDenoShim } from "../src/env";
import { snapshotTwilioUsage, USAGE_ACCOUNT_KEY, USAGE_SUBS_PER_RUN } from "../src/cron/usageCharge";
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
  it("switch off: the parent alone, IncludeSubaccounts=false, no account_sid, on 298's key, nothing else read", async () => {
    const { net, env } = world();
    net.rest("POST", "twilio_usage_daily", () => []);
    const out = await snapshotTwilioUsage(env, adminClient(env), AT);
    expect(out).toEqual({ ran: true, day: "2026-10-09", rows: 1, key: "account", subs: 0, subRows: 0, subsFailed: 0 });
    const q = net.to(/Usage\/Records/)[0].url.searchParams;
    expect([q.get("StartDate"), q.get("EndDate"), q.get("IncludeSubaccounts")]).toEqual(["2026-10-09", "2026-10-09", "false"]);
    const up = net.writes("twilio_usage_daily", "POST");
    expect(up).toHaveLength(1);
    expect(up[0].url.searchParams.get("on_conflict")).toBe(USAGE_ACCOUNT_KEY);
    expect(up[0].json).toEqual([{ day: "2026-10-09", category: "calls-outbound", count: 2, usage: 5, price_micros: 434000, fetched_at: AT.toISOString() }]);
    expect(net.reads("twilio_accounts")).toHaveLength(0);
    expect(net.rpcCalls("twilio_account_creds")).toHaveLength(0);
  });

  it("before migration 298 (42P10): the same rows on (day, category), logged once at info", async () => {
    const { net, env } = world();
    net.rest("POST", "twilio_usage_daily", (s) => s.url.searchParams.get("on_conflict") === USAGE_ACCOUNT_KEY
      ? jsonRes({ code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" }, 400)
      : []);
    const out = await snapshotTwilioUsage(env, adminClient(env), AT);
    expect(out.ran && out.key).toBe("legacy");
    const up = net.writes("twilio_usage_daily", "POST").map((s) => [s.url.searchParams.get("on_conflict"), s.json]);
    expect(up[1]).toEqual(["day,category", up[0][1]]);
    const logged = net.writes("app_errors", "POST").map((s) => s.json);
    expect(logged.map((r) => [r.code, r.severity])).toEqual([["twilio_usage_key_pending", "info"]]);
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
    expect(out).toEqual({ ran: true, day: "2026-10-09", rows: 1, key: "account", subs: 2, subRows: 1, subsFailed: 1 });
    const subCall = net.to(new RegExp(`Accounts/${SUB}/Usage`))[0];
    expect(subCall.headers.get("authorization")).toBe(basic(SUB_KEY, SUB_SECRET));
    expect(subCall.url.searchParams.get("IncludeSubaccounts")).toBe("false");
    const writes = net.writes("twilio_usage_daily", "POST").map((s) => s.json);
    expect(writes[0][0].account_sid).toBeUndefined();
    // client_id order: other-builder (refused on the old key) first, then sub-builder (written).
    expect(writes[1][0].account_sid).toBe(OTHER);
    expect(writes[2]).toEqual([{ day: "2026-10-09", account_sid: SUB, category: "calls-inbound", count: 2, usage: 5, price_micros: 85000, fetched_at: AT.toISOString() }]);
    const logged = net.writes("app_errors", "POST").map((s) => s.json);
    expect(logged.map((r) => [r.code, r.severity, r.client_id])).toEqual([["twilio_usage_sub_key_pending", "info", "other-builder"]]);
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
    // 51 subs → 2 turns; 2026-10-09 is day 20735 since the epoch → turn 1: the last one only.
    expect(out.ran && [out.subs, out.subRows]).toEqual([1, 2]);
    const q = net.to(/Usage\/Records/).filter((s) => !s.url.pathname.includes(PARENT))[0].url.searchParams;
    expect([q.get("StartDate"), q.get("EndDate")]).toEqual(["2026-10-08", "2026-10-09"]);
    const subWrite = net.writes("twilio_usage_daily", "POST")[1].json;
    expect(subWrite.map((r: { day: string }) => r.day)).toEqual(["2026-10-08", "2026-10-09"]);
  });
});
