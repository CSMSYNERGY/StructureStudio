// /sms/send: the CRM's checks (who may text which customer) and the refusal mapping.
// sendTenantSms is replaced here so each check is tested on its own; smsSend.test.ts runs the
// real one end to end.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTenantSms = vi.fn();
// Which number it goes out from (migration 266): smsSend.test.ts runs the real chooser.
const replyFromNumber = vi.fn();
vi.mock("../../../supabase/functions/_shared/smsSend.ts", () => ({
  sendTenantSms: (...a: unknown[]) => sendTenantSms(...a),
  replyFromNumber: (...a: unknown[]) => replyFromNumber(...a),
}));

import { mapSmsRefusal } from "../src/routes/sms";
import {
  Auth, CLIENT, CONTACT_1, CUSTOMER, FakeNet, USER_A, appRequest, call, callerCtx, filter, makeEnv,
} from "./helpers";

const MSG_ID = "00000000-0000-4000-8000-00000000e001";

async function setup(opts: {
  ctx?: Record<string, unknown>;
  contact?: unknown[];
  visible?: string[];
  savedForNumber?: unknown[];
  inbound?: unknown[];
} = {}) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => opts.ctx ?? callerCtx());
  net.rpc("crm_visible_contact_ids", () => opts.visible ?? []);
  net.rest("GET", "crm_contacts", (s) => (filter(s, "phone_digits") ? opts.savedForNumber ?? [] : opts.contact ?? [{ id: CONTACT_1, phone: "(555) 555-0142", phone_digits: "5555550142" }]));
  net.rest("GET", "sms_messages", () => opts.inbound ?? []);
  net.rest("PATCH", "sms_messages", () => []);
  net.rest("POST", "app_errors", () => []);
  sendTenantSms.mockReset();
  sendTenantSms.mockResolvedValue({ sent: true, id: MSG_ID });
  replyFromNumber.mockReset();
  replyFromNumber.mockResolvedValue(null);
  return { net, token: await auth.token(USER_A), env: makeEnv() };
}

const send = (token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  appRequest("POST", "/sms/send", token, { to_e164: CUSTOMER, contact_id: CONTACT_1, body: "Hi there", client_temp_id: "tmp-1", ...body }, headers);

describe("/sms/send checks", () => {
  beforeEach(() => sendTenantSms.mockReset());

  it("sends to a contact with contacts edit: the number comes from the contact row, bypassQuietHours is explicit", async () => {
    const { net, token, env } = await setup();
    const { res, json } = await call(env, send(token, {}, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }));
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, message: { id: MSG_ID, client_temp_id: "tmp-1", status: "sent" } });
    expect(sendTenantSms).toHaveBeenCalledTimes(1);
    const [, clientId, msg] = sendTenantSms.mock.calls[0];
    expect(clientId).toBe(CLIENT);
    expect(msg).toMatchObject({
      toPhone: "(555) 555-0142", body: "Hi there", contactId: CONTACT_1, shortCode: null, sentBy: USER_A, bypassQuietHours: true,
    });
    expect(msg.statusCallback).toBe("https://demo-project.supabase.example.test/functions/v1/sms-status?key=test-sms-secret");
    // Then the returned row is tagged.
    const tag = net.writes("sms_messages", "PATCH")[0];
    expect(tag.json).toEqual({ client_temp_id: "tmp-1", sent_via: "extension" });
    expect(filter(tag, "id")).toBe(MSG_ID);
    expect(filter(tag, "client_id")).toBe(CLIENT);
  });

  it("asks which number on the contact's thread for the sender, and sends from what it answers (migration 266)", async () => {
    const { token, env } = await setup();
    replyFromNumber.mockResolvedValue("+15555550101");
    const { res } = await call(env, send(token, {}));
    expect(res.status).toBe(200);
    const [, clientId, o] = replyFromNumber.mock.calls[0];
    expect([clientId, o]).toEqual([CLIENT, { contactId: CONTACT_1, userId: USER_A }]);
    expect(sendTenantSms.mock.calls[0][2]).toMatchObject({ fromNumber: "+15555550101" });
    // Asked only once every check has passed: a refused text never reads the thread.
    const refused = await setup({ ctx: callerCtx({ contacts_level: "view" }) });
    await call(refused.env, send(refused.token, {}));
    expect(replyFromNumber).not.toHaveBeenCalled();
  });

  it("tags texts from the phone app as mobile", async () => {
    const { net, token, env } = await setup();
    await call(env, send(token, {}));
    expect(net.writes("sms_messages", "PATCH")[0].json.sent_via).toBe("mobile");
  });

  it("refuses contacts view (no edit) for a saved contact", async () => {
    const { token, env } = await setup({ ctx: callerCtx({ contacts_level: "view" }) });
    const { res, json } = await call(env, send(token, {}));
    expect(res.status).toBe(403);
    expect(json.error.code).toBe("not_your_customer");
    expect(sendTenantSms).not.toHaveBeenCalled();
  });

  it("contacts:'own' may text a customer they own or follow (CONTACT_ROW_SCOPE)", async () => {
    const { net, token, env } = await setup({ ctx: callerCtx({ contacts_level: "own", own_contacts_only: true }), visible: [CONTACT_1] });
    const { res } = await call(env, send(token, {}));
    expect(res.status).toBe(200);
    expect(net.rpcCalls("crm_visible_contact_ids")[0].json).toEqual({ p_client_id: CLIENT, p_user_id: USER_A, p_ids: [CONTACT_1] });
  });

  it("contacts:'own' may NOT text someone else's customer", async () => {
    const { token, env } = await setup({ ctx: callerCtx({ contacts_level: "own", own_contacts_only: true }), visible: [] });
    const { res, json } = await call(env, send(token, {}));
    expect(res.status).toBe(403);
    expect(json.error).toEqual({ code: "not_your_customer", message: "You can only text your own customers." });
    expect(sendTenantSms).not.toHaveBeenCalled();
  });

  it("a scope check that errors refuses (fails closed)", async () => {
    const { net, token, env } = await setup({ ctx: callerCtx({ contacts_level: "own", own_contacts_only: true }) });
    net.rpc("crm_visible_contact_ids", () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
    const { res } = await call(env, send(token, {}));
    expect(res.status).toBe(500);
    expect(sendTenantSms).not.toHaveBeenCalled();
  });

  it("refuses when the number sent doesn't match the contact's own (never texts the body's number)", async () => {
    const { token, env } = await setup();
    const { res, json } = await call(env, send(token, { to_e164: "+15555550199" }));
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("bad_request");
    expect(sendTenantSms).not.toHaveBeenCalled();
  });

  it("refuses a contact on another tenant as not found (the lookup is tenant-scoped)", async () => {
    const { net, token, env } = await setup({ contact: [] });
    const { res } = await call(env, send(token, {}));
    expect(res.status).toBe(404);
    expect(filter(net.reads("crm_contacts")[0], "client_id")).toBe(CLIENT);
  });

  describe("unknown numbers (no contact)", () => {
    it("contacts view may reply to a number that texted first", async () => {
      const { net, token, env } = await setup({ ctx: callerCtx({ contacts_level: "view" }), inbound: [{ id: "x" }] });
      const { res } = await call(env, send(token, { contact_id: null }));
      expect(res.status).toBe(200);
      expect(sendTenantSms.mock.calls[0][2]).toMatchObject({ toPhone: CUSTOMER, contactId: null, bypassQuietHours: true });
      const q = net.reads("sms_messages")[0];
      expect(filter(q, "direction")).toBe("in");
      expect(filter(q, "from_number")).toBe(CUSTOMER);
      expect(q.url.searchParams.get("contact_id")).toBe("is.null");
    });

    it("refuses a number that never texted in", async () => {
      const { token, env } = await setup({ ctx: callerCtx({ contacts_level: "edit" }), inbound: [] });
      const { json } = await call(env, send(token, { contact_id: null }));
      expect(json.error.code).toBe("not_your_customer");
      expect(sendTenantSms).not.toHaveBeenCalled();
    });

    it("refuses someone limited to their own customers: save the contact first", async () => {
      const { token, env } = await setup({ ctx: callerCtx({ contacts_level: "own", own_contacts_only: true }), inbound: [{ id: "x" }] });
      const { json } = await call(env, send(token, { contact_id: null }));
      expect(json.error.code).toBe("not_your_customer");
      expect(json.error.message).toContain("Save this number as a contact first");
    });

    it("refuses when the number has since been saved as a contact", async () => {
      const { token, env } = await setup({ savedForNumber: [{ id: CONTACT_1 }], inbound: [{ id: "x" }] });
      const { json } = await call(env, send(token, { contact_id: null }));
      expect(json.error.code).toBe("bad_request");
    });
  });

  it.each([
    [{ body: "   " }, "The message is empty."],
    [{ to_e164: "12345" }, "That isn't a US or Canadian mobile number."],
    [{ contact_id: "not-a-uuid" }, "That contact id isn't valid."],
    [{ client_temp_id: "bad id with spaces" }, "The message id isn't valid."],
  ])("validates the request %#", async (body, message) => {
    const { token, env } = await setup();
    const { json } = await call(env, send(token, body));
    expect(json.error).toEqual({ code: "bad_request", message });
  });

  it("refuses a business without a number", async () => {
    const { token, env } = await setup({ ctx: callerCtx({ number: null }) });
    const { json } = await call(env, send(token, {}));
    expect(json.error.code).toBe("no_number");
  });

  it("maps a send-rule refusal to the SPEC code, keeping smsSend's own sentence", async () => {
    const { token, env } = await setup();
    sendTenantSms.mockResolvedValue({ sent: false, reason: "no_consent", error: "We don't have this customer's permission to text them yet." });
    const { res, json } = await call(env, send(token, {}));
    expect(res.status).toBe(409);
    expect(json.error).toEqual({ code: "no_consent", message: "We don't have this customer's permission to text them yet." });
  });
});

describe("refusal mapping", () => {
  it.each([
    ["no_consent", "no_consent", 409],
    ["opted_out", "opted_out", 409],
    ["not_active", "number_not_registered", 409],
    ["bad_number", "bad_request", 400],
    ["damaged_number", "bad_request", 400],
    ["quiet_hours", "internal", 500],
    ["failed", "twilio_error", 502],
    [undefined, "twilio_error", 502],
  ] as const)("%s → %s", (reason, code, status) => {
    const r = mapSmsRefusal({ sent: false, reason: reason as never, error: "Authored sentence." });
    expect(r).toEqual({ code, status, message: "Authored sentence." });
  });

  it("has plain-English defaults when smsSend gave no sentence", () => {
    expect(mapSmsRefusal({ sent: false, reason: "opted_out" }).message).toBe("This customer asked not to be texted (STOP).");
    expect(mapSmsRefusal({ sent: false, reason: "not_active" }).message).toBe("Your texting number isn't registered yet.");
    expect(mapSmsRefusal({ sent: false, reason: "no_consent" }).message).toBe("This customer hasn't agreed to texts yet.");
  });
});
