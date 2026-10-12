// GET /threads/:key `sms` (2026-10-13): whether the thread's number can be texted, as the send
// path (_shared/smsSend.ts) sees it. Asked for 2026-10-12: "Can we see if a customer has opted
// out?" The phone repo's docs/SPEC.md section 3 "Opt-out state" is the contract.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  Auth, BUSINESS_NUMBER, CLIENT, CONTACT_1, CUSTOMER, FakeNet, USER_A,
  appRequest, call, callerCtx, jsonRes, makeEnv, pgTable,
} from "./helpers";
import { optOutReasonOf } from "../src/routes/reads";

type Row = Record<string, unknown>;
const T = (min: number) => new Date(Date.UTC(2026, 9, 12, 15, 0) - min * 60_000).toISOString();
const OTHER_TENANT = "other-tenant";
const UNKNOWN = "+15555550150";
const DIGITS = "5555550142"; // CUSTOMER's ten digits

interface World { contact?: Row | null; sms?: Row[]; optOuts?: Row[]; consent?: Row[] }

let shared: Auth | null = null;

async function setup(ctx: Row, w: World = {}) {
  const net = new FakeNet().install();
  const auth = (shared ??= await new Auth().init());
  auth.serve(net);
  net.rpc("phone_caller_context", () => ctx);
  net.rpc("crm_visible_contact_ids", (s) => s.json.p_ids);
  const contact = w.contact === null ? [] : [{
    id: CONTACT_1, client_id: CLIENT, owner_user_id: USER_A, email: null, phone: "(555) 555-0142", sms_opt_out_at: null, ...w.contact,
  }];
  net.rest("GET", "crm_contacts", pgTable(contact));
  net.rest("GET", "sms_messages", pgTable(w.sms ?? []));
  net.rest("GET", "phone_calls", () => []);
  net.rest("GET", "designs", () => []);
  net.rest("GET", "email_sends", () => []);
  net.rest("GET", "email_inbound", () => []);
  net.rest("GET", "client_settings", () => []);
  net.rest("GET", "billing_plans", () => []);
  net.rest("GET", "billing_subscriptions", () => []);
  net.rest("GET", "sms_opt_outs", pgTable(w.optOuts ?? []));
  net.rest("GET", "sms_consent_log", pgTable(w.consent ?? []));
  net.rest("POST", "app_errors", () => []);
  return { net, token: await auth.token(USER_A), env: makeEnv() };
}

const read = (token: string, key: string = CONTACT_1) => appRequest("GET", `/threads/${encodeURIComponent(key)}`, token);
const optOut = (over: Row = {}): Row => ({ client_id: CLIENT, phone_digits: DIGITS, reason: "sms_stop", effective_at: T(60), ...over });
const grant = (over: Row = {}): Row => ({ client_id: CLIENT, phone_digits: DIGITS, action: "granted", source: "web_form", ...over });
const text = (id: string, over: Row): Row => ({
  id, client_id: CLIENT, contact_id: CONTACT_1, direction: "in", body: `text ${id}`, status: "received", created_at: T(1),
  from_number: CUSTOMER, to_number: BUSINESS_NUMBER, sent_by: null, client_temp_id: null, num_media: 0, ...over,
});

describe("GET /threads/:key sms (opt-out state)", () => {
  it("a customer who replied STOP: opted out, revoked, when, and why; keyed on the number's 10 digits in THIS business", async () => {
    const { net, token, env } = await setup(callerCtx(), {
      sms: [text("m1", {})],
      // Another business's opt-out for the same person, and another number's: neither is this one.
      optOuts: [optOut(), optOut({ client_id: OTHER_TENANT, reason: "operator" }), optOut({ phone_digits: "5555550199", reason: "import" })],
      consent: [grant()],
    });
    const { res, json } = await call(env, read(token));
    expect(res.status).toBe(200);
    expect(json.sms).toEqual({ e164: CUSTOMER, opted_out: true, opted_out_at: T(60), consent: "revoked", opted_out_reason: "stop" });
    const [oo] = net.reads("sms_opt_outs");
    expect(oo.url.searchParams.get("client_id")).toBe(`eq.${CLIENT}`);
    expect(oo.url.searchParams.get("phone_digits")).toBe(`eq.${DIGITS}`);
    // The texts the apps get still carry no number.
    expect(json.messages[0]).not.toHaveProperty("from_number");
    expect(json.messages[0]).not.toHaveProperty("to_number");
  });

  it("why: the team recorded it (operator) is team; an import or anything else is other", async () => {
    for (const [reason, want] of [["operator", "team"], ["import", "other"], ["web_form", "other"]] as const) {
      const { token, env } = await setup(callerCtx(), { sms: [text("m1", {})], optOuts: [optOut({ reason })] });
      const { json } = await call(env, read(token));
      expect(json.sms.opted_out_reason, reason).toBe(want);
      expect(json.sms.consent).toBe("revoked");
    }
    expect(optOutReasonOf(null)).toBe("other");
  });

  it("the contact's older flag alone (crm_contacts.sms_opt_out_at) is opted out too, reason other, at that time", async () => {
    const { token, env } = await setup(callerCtx(), { contact: { sms_opt_out_at: T(90) }, sms: [text("m1", {})], consent: [grant()] });
    const { json } = await call(env, read(token));
    expect(json.sms).toEqual({ e164: CUSTOMER, opted_out: true, opted_out_at: T(90), consent: "revoked", opted_out_reason: "other" });
  });

  it("not opted out: granted when the number has any grant on record, else none (a text would be refused no_consent)", async () => {
    const granted = await setup(callerCtx(), { sms: [text("m1", {})], consent: [grant({ action: "revoked" }), grant()] });
    expect((await call(granted.env, read(granted.token))).json.sms).toEqual({ e164: CUSTOMER, opted_out: false, opted_out_at: null, consent: "granted", opted_out_reason: null });
    const none = await setup(callerCtx(), { sms: [text("m1", {})], consent: [grant({ client_id: OTHER_TENANT }), grant({ action: "revoked" })] });
    expect((await call(none.env, read(none.token))).json.sms).toEqual({ e164: CUSTOMER, opted_out: false, opted_out_at: null, consent: "none", opted_out_reason: null });
  });

  it("the number is the newest text's customer number, else the contact's phone on record; none at all is sms: null, with nothing read", async () => {
    // The newest text was to a second number: that is the one the composer texts.
    const newest = await setup(callerCtx(), {
      sms: [
        text("m1", { created_at: T(5) }),
        text("m2", { direction: "out", from_number: BUSINESS_NUMBER, to_number: "+15555550143", created_at: T(1) }),
      ],
      optOuts: [optOut()],
    });
    const a = (await call(newest.env, read(newest.token))).json;
    expect(a.sms).toMatchObject({ e164: "+15555550143", opted_out: false });
    expect(newest.net.reads("sms_opt_outs")[0].url.searchParams.get("phone_digits")).toBe("eq.5555550143");
    // No texts yet: the phone on record.
    const onRecord = await setup(callerCtx(), { optOuts: [optOut()] });
    expect((await call(onRecord.env, read(onRecord.token))).json.sms).toMatchObject({ e164: CUSTOMER, opted_out: true });
    // A contact who only emails: nothing to text, and nothing asked.
    const emailOnly = await setup(callerCtx(), { contact: { phone: null } });
    const { json } = await call(emailOnly.env, read(emailOnly.token));
    expect(json.sms).toBeNull();
    expect(emailOnly.net.reads("sms_opt_outs")).toEqual([]);
    expect(emailOnly.net.reads("sms_consent_log")).toEqual([]);
  });

  it("an unknown number's thread (n:+1...) is about that number", async () => {
    const { token, env } = await setup(callerCtx({ contacts_level: "view" }), {
      contact: null,
      optOuts: [optOut({ phone_digits: "5555550150", reason: "sms_stop", effective_at: T(3) })],
    });
    const { json } = await call(env, read(token, `n:${UNKNOWN}`));
    expect(json.sms).toEqual({ e164: UNKNOWN, opted_out: true, opted_out_at: T(3), consent: "revoked", opted_out_reason: "stop" });
  });

  it("a read that fails leaves sms out (the send path still refuses), the thread still opens, and the log names no number", async () => {
    const { net, token, env } = await setup(callerCtx(), { sms: [text("m1", {})] });
    net.rest("GET", "sms_opt_outs", () => jsonRes({ code: "57014", message: `canceling statement: phone_digits = '${DIGITS}'` }, 500));
    const { res, json } = await call(env, read(token));
    expect(res.status).toBe(200);
    expect(json.messages).toHaveLength(1);
    expect(json).not.toHaveProperty("sms");
    const rows = net.writes("app_errors").map((w) => w.json);
    expect(rows.map((r) => r.code)).toEqual(["sms_state_read_failed"]);
    expect(JSON.stringify(rows)).not.toContain(DIGITS);
    expect(JSON.stringify(rows)).toContain("57014");
  });
});

// The client half reads `sms` through phone-core's smsStateOf, which drops what it doesn't
// recognise: what the Worker sends must come through it unchanged. Run with PHONE_CORE_DIR
// pointing at a checkout's packages/phone-core, as test/identity.test.ts does.
const coreDir = process.env.PHONE_CORE_DIR;
describe.skipIf(!coreDir || !existsSync(join(coreDir, "src", "smsState.ts")))("parity with @sss/phone-core smsStateOf", () => {
  it("every state the Worker answers reads back unchanged, and has a banner exactly when opted out", async () => {
    const core = await import(/* @vite-ignore */ pathToFileURL(join(coreDir!, "src", "smsState.ts")).href);
    const worlds: World[] = [
      { sms: [text("m1", {})], optOuts: [optOut()] },
      { sms: [text("m1", {})], optOuts: [optOut({ reason: "operator" })] },
      { contact: { sms_opt_out_at: T(9) }, sms: [text("m1", {})] },
      { sms: [text("m1", {})], consent: [grant()] },
      { sms: [text("m1", {})] },
    ];
    for (const w of worlds) {
      const { token, env } = await setup(callerCtx(), w);
      const { json } = await call(env, read(token));
      expect(core.smsStateOf({ sms: json.sms })).toEqual(json.sms);
      expect(core.smsOptOutText(core.smsStateOf({ sms: json.sms })) !== null).toBe(json.sms.opted_out);
    }
  });
});
