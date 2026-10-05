// /push/text: who gets a text alert, and how it is sent (FCM HTTP v1, APNs). /push/email: the
// same people, for a customer's email (migration 267's trigger), from the row and never the payload.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The `phone` access area arrives in access.ts with the portal change. Until then this file
// supplies it from the stored map, so the ownership rules here are tested on their own.
vi.mock("../../../supabase/functions/_shared/access.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../supabase/functions/_shared/access.ts")>();
  return {
    ...real,
    effectiveAccess: (role: string, title: unknown, access: Record<string, unknown> | null) => {
      const eff = real.effectiveAccess(role, title, access) as Record<string, string>;
      if (role === "owner") return { ...eff, phone: "edit" };
      return { ...eff, phone: (access?.phone as string) ?? "none", contacts: (access?.contacts as string) ?? eff.contacts };
    },
  };
});

import { BASE, CLIENT, CONTACT_1, CONTACT_2, CUSTOMER, FakeNet, USER_A, USER_B, USER_C, call, filter, jsonRes, makeEnv } from "./helpers";
import type { Env } from "../src/env";
import { b64urlDecode, b64urlDecodeJson } from "../src/b64";
import { apnsMissing, apnsTopic, resetPushTokens } from "../src/routes/push";

// The Google access token and the APNs provider token are module state (one per isolate).
beforeEach(() => resetPushTokens());

const USER_D = "00000000-0000-4000-8000-0000000000d4";

async function pem(kind: "rsa" | "ec"): Promise<string> {
  const pair = (kind === "rsa"
    ? await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
    : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
}

const TEAM = [
  { user_id: USER_A, role: "owner", title: "owner", access: {} },
  { user_id: USER_B, role: "user", title: "office_staff", access: { phone: "view", contacts: "view" } },
  { user_id: USER_C, role: "user", title: "sales_rep", access: { phone: "own", contacts: "own" } },
  { user_id: USER_D, role: "user", title: "crew_member", access: { phone: "none", contacts: "view" } },
];

async function setup(opts: { contact?: unknown; followers?: string[]; phoneStatus?: string; env?: Partial<Env>; fcmStatus?: number } = {}) {
  const net = new FakeNet().install();
  const env = makeEnv({
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "push@demo.iam.example.test", private_key: await pem("rsa"), project_id: "demo-project", token_uri: "https://oauth2.example.test/token" }),
    APNS_KEY_P8: await pem("ec"), APNS_KEY_ID: "KEY0000000", APNS_TEAM_ID: "TEAM000000", APNS_BUNDLE_ID: "com.example.mysynergyphone.dev",
    ...opts.env,
  });
  net.rest("GET", "client_settings", () => [{ phone_status: opts.phoneStatus ?? "on" }]);
  net.rest("GET", "crm_contacts", () => (opts.contact ? [opts.contact] : []));
  net.rest("GET", "client_users", () => TEAM);
  net.rpc("crm_visible_contact_ids", (s) => ((opts.followers ?? []).includes(s.json.p_user_id) ? s.json.p_ids : []));
  net.rest("GET", "phone_devices", (s) => {
    const users = (s.url.searchParams.get("user_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",");
    const all = [
      { id: "dA", user_id: USER_A, platform: "android", build_type: "prod", push_token: "fcm-a", push_kind: "fcm" },
      { id: "dB", user_id: USER_B, platform: "ios", build_type: "dev", push_token: "aa11", push_kind: "apns" },
      { id: "dC", user_id: USER_C, platform: "android", build_type: "prod", push_token: "fcm-c", push_kind: "fcm" },
      { id: "dD", user_id: USER_D, platform: "android", build_type: "prod", push_token: "fcm-d", push_kind: "fcm" },
    ];
    return all.filter((d) => users.includes(d.user_id));
  });
  net.rest("DELETE", "phone_devices", () => []);
  net.rest("POST", "app_errors", () => []);
  net.on("POST", (u) => u.href === "https://oauth2.example.test/token", () => jsonRes({ access_token: "ya29.test", expires_in: 3600 }));
  net.on("POST", /fcm\.googleapis\.com\/v1\/projects\/demo-project\/messages:send$/, () =>
    opts.fcmStatus ? jsonRes({ error: { status: "NOT_FOUND" } }, opts.fcmStatus) : jsonRes({ name: "projects/demo-project/messages/1" }));
  net.on("POST", /push\.apple\.com\/3\/device\//, () => new Response(null, { status: 200 }));
  return { net, env };
}

function hook(env: Env, record: Record<string, unknown>, secret = "test-push-secret") {
  return new Request(`${BASE}/push/text`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-push-secret": secret },
    body: JSON.stringify({ type: "INSERT", table: "sms_messages", schema: "public", record, old_record: null }),
  });
}

const inbound = (over: Record<string, unknown> = {}) => ({ id: "00000000-0000-4000-8000-00000000f001", client_id: CLIENT, contact_id: CONTACT_1, direction: "in", from_number: CUSTOMER, body: "Is the shed ready?", num_media: 0, ...over });
const fcmTokens = (net: FakeNet) => net.to(/messages:send$/).map((s) => s.json.message.token);
const apnsTokens = (net: FakeNet) => net.to(/push\.apple\.com/).map((s) => s.url.pathname.split("/").pop());

describe("/push/text", () => {
  it("refuses a wrong secret", async () => {
    const { net, env } = await setup();
    const { res } = await call(env, hook(env, inbound(), "nope"));
    expect(res.status).toBe(401);
    expect(net.to(/messages:send|push\.apple/)).toEqual([]);
  });

  it("an owned customer's text alerts only the owner, as an FCM notification message", async () => {
    const { net, env } = await setup({ contact: { name: "Jordan Demo", owner_user_id: USER_A } });
    const { res } = await call(env, hook(env, inbound()));
    expect(res.status).toBe(204);
    expect(fcmTokens(net)).toEqual(["fcm-a"]);
    expect(apnsTokens(net)).toEqual([]);
    const msg = net.to(/messages:send$/)[0];
    expect(msg.headers.get("authorization")).toBe("Bearer ya29.test");
    expect(msg.json.message).toMatchObject({
      token: "fcm-a",
      notification: { title: "Jordan Demo", body: "Is the shed ready?" },
      data: { type: "sms", thread_key: CONTACT_1 },
      android: { priority: "high", notification: { channel_id: "texts" } },
    });
    // The service-account JWT went to the token endpoint once.
    const grant = new URLSearchParams(net.to(/oauth2\.example\.test\/token$/)[0].body);
    expect(grant.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(grant.get("assertion")!.split(".")).toHaveLength(3);
  });

  it("an unowned customer alerts everyone with phone access who can see them (own-scoped only if following)", async () => {
    const { net, env } = await setup({ contact: { name: "Jordan Demo", owner_user_id: null }, followers: [USER_C] });
    await call(env, hook(env, inbound()));
    expect(fcmTokens(net).sort()).toEqual(["fcm-a", "fcm-c"]);
    expect(apnsTokens(net)).toEqual(["aa11"]);
    // The dev build's token goes to Apple's sandbox, with our bundle id as the topic.
    const apple = net.to(/push\.apple\.com/)[0];
    expect(apple.url.origin).toBe("https://api.sandbox.push.apple.com");
    expect(apple.headers.get("apns-topic")).toBe("com.example.mysynergyphone.dev");
    expect(apple.headers.get("apns-push-type")).toBe("alert");
    expect(apple.headers.get("authorization")).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(apple.json.aps.alert).toEqual({ title: "Jordan Demo", body: "Is the shed ready?" });
    // A text is still a text to the app (/push/email sends "email").
    expect(apple.json).toMatchObject({ type: "sms", thread_key: CONTACT_1 });
    expect(net.to(/messages:send$/).every((s) => s.json.message.data.type === "sms")).toBe(true);
    // Nobody without phone access.
    expect(fcmTokens(net)).not.toContain("fcm-d");
  });

  it("an unknown number alerts phone users with contacts view or edit, titled with the number", async () => {
    const { net, env } = await setup();
    await call(env, hook(env, inbound({ contact_id: null })));
    expect(fcmTokens(net)).toEqual(["fcm-a"]);
    expect(apnsTokens(net)).toEqual(["aa11"]);
    expect(net.to(/messages:send$/)[0].json.message.notification.title).toBe("(555) 555-0142");
    expect(net.rpcCalls("crm_visible_contact_ids")).toEqual([]);
  });

  it("ignores outbound rows and tenants with the phone off", async () => {
    const out = await setup({ contact: { name: "J", owner_user_id: USER_A } });
    await call(out.env, hook(out.env, inbound({ direction: "out" })));
    expect(out.net.seen.filter((s) => s.url.hostname.includes("fcm") || s.url.pathname.includes("client_settings"))).toEqual([]);
    const off = await setup({ contact: { name: "J", owner_user_id: USER_A }, phoneStatus: "off" });
    await call(off.env, hook(off.env, inbound()));
    expect(fcmTokens(off.net)).toEqual([]);
  });

  it("forgets a token FCM says is gone", async () => {
    const { net, env } = await setup({ contact: { name: "J", owner_user_id: USER_A }, fcmStatus: 404 });
    await call(env, hook(env, inbound()));
    expect(net.writes("phone_devices", "DELETE")[0].url.searchParams.get("id")).toBe("in.(dA)");
  });

  it("skips a platform whose credentials are unset, logging it once, never failing the webhook", async () => {
    const { net, env } = await setup({ contact: { name: "J", owner_user_id: null }, env: { FCM_SERVICE_ACCOUNT_JSON: undefined, APNS_KEY_P8: undefined } });
    const { res } = await call(env, hook(env, inbound()));
    expect(res.status).toBe(204);
    expect(net.to(/messages:send|push\.apple/)).toEqual([]);
    const logs = net.writes("app_errors").map((s) => s.json);
    expect(logs.map((l) => l.code).sort()).toEqual(["push_apns_not_configured", "push_fcm_not_configured"]);
    expect(logs.every((l) => l.source === "edge:phone-api")).toBe(true);
    // iPhones skipped is a warning that names the secret to set; Android's stays info.
    const apns = logs.find((l) => l.code === "push_apns_not_configured");
    expect(apns.severity).toBe("warn");
    expect(apns.message).toMatch(/^APNS_KEY_P8 is not set/);
    expect(logs.find((l) => l.code === "push_fcm_not_configured").severity).toBe("info");
    expect(filter(net.reads("client_users")[0], "client_id")).toBe(CLIENT);
  });
});

// ── /push/email ─────────────────────────────────────────────────────────────────────

const EMAIL_ID = "00000000-0000-4000-8000-00000000e001";
const VERIFIED = "spam=PASS virus=PASS spf=pass dkim=pass dmarc=pass";

interface EmailFixture {
  id: string;
  client_id: string;
  contact_id: string | null;
  short_code: string | null;
  from_name: string | null;
  from_email: string;
  subject: string | null;
  spam_verdict: string | null;
  body_text: string | null;
}
interface ContactFixture { id: string; client_id: string; name: string | null; owner_user_id: string | null }
interface DesignFixture { short_code: string; client_id: string; contact_id: string | null }

const received = (over: Partial<EmailFixture> = {}): EmailFixture => ({
  id: EMAIL_ID, client_id: CLIENT, contact_id: CONTACT_1, short_code: null,
  from_name: "Jordan Demo", from_email: "jordan@example.test", subject: "Re: Your 12x24 quote",
  spam_verdict: VERIFIED, body_text: "Can we move delivery to Friday?", ...over,
});
const JORDAN: ContactFixture = { id: CONTACT_1, client_id: CLIENT, name: "Jordan Demo", owner_user_id: USER_A };

async function emailSetup(opts: {
  rows?: EmailFixture[]; contacts?: ContactFixture[]; designs?: DesignFixture[];
  followers?: string[]; phoneStatus?: string; fcmStatus?: number;
} = {}) {
  const s = await setup({ followers: opts.followers, phoneStatus: opts.phoneStatus, fcmStatus: opts.fcmStatus });
  const rows = opts.rows ?? [received()];
  const contacts = opts.contacts ?? [JORDAN];
  const designs = opts.designs ?? [];
  // Every read honours the filters the Worker sends, so a row, contact or design of another
  // business is really never found (and a missing filter really finds it).
  s.net.rest("GET", "email_inbound", (q) => rows.filter((r) => filter(q, "id") === r.id && filter(q, "client_id") === r.client_id));
  s.net.rest("GET", "crm_contacts", (q) => contacts.filter((c) => filter(q, "id") === c.id && filter(q, "client_id") === c.client_id));
  s.net.rest("GET", "designs", (q) => designs.filter((d) => filter(q, "short_code") === d.short_code && filter(q, "client_id") === d.client_id));
  return s;
}

/** What 267's trigger posts: ids only. */
function emailHook(record: Record<string, unknown>, opts: { secret?: string; table?: string; type?: string } = {}) {
  return new Request(`${BASE}/push/email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-push-secret": opts.secret ?? "test-push-secret" },
    body: JSON.stringify({ type: opts.type ?? "INSERT", table: opts.table ?? "email_inbound", schema: "public", record }),
  });
}
const idsOf = (r: EmailFixture) => ({ id: r.id, client_id: r.client_id });
const pushes = (net: FakeNet) => net.to(/messages:send$|push\.apple\.com/);

describe("/push/email", () => {
  it("refuses a wrong secret, reading nothing", async () => {
    const { net, env } = await emailSetup();
    const { res } = await call(env, emailHook(idsOf(received()), { secret: "nope" }));
    expect(res.status).toBe(401);
    expect(net.reads("email_inbound")).toEqual([]);
    expect(pushes(net)).toEqual([]);
  });

  it("a reply from an owned customer alerts only the owner: type 'email', the contact's thread, 'Email: <subject>'", async () => {
    const { net, env } = await emailSetup();
    const { res } = await call(env, emailHook(idsOf(received())));
    expect(res.status).toBe(204);
    expect(fcmTokens(net)).toEqual(["fcm-a"]);
    expect(apnsTokens(net)).toEqual([]);
    expect(net.to(/messages:send$/)[0].json.message).toMatchObject({
      token: "fcm-a",
      notification: { title: "Jordan Demo", body: "Email: Re: Your 12x24 quote" },
      data: { type: "email", thread_key: CONTACT_1, message_id: EMAIL_ID },
      // The texts channel, and one alert per conversation: an email replaces that contact's text alert.
      android: { priority: "high", collapse_key: CONTACT_1, notification: { tag: CONTACT_1, channel_id: "texts" } },
    });
    // The row is found again by id AND business, and its body is never read, let alone sent.
    const read = net.reads("email_inbound")[0];
    expect([filter(read, "id"), filter(read, "client_id")]).toEqual([EMAIL_ID, CLIENT]);
    expect(read.url.searchParams.get("select")).not.toMatch(/body/);
    expect(JSON.stringify(pushes(net).map((s) => s.json))).not.toContain("Friday");
  });

  it("an unowned customer's email reaches everyone with phone access who can see them, on both platforms", async () => {
    const { net, env } = await emailSetup({ contacts: [{ ...JORDAN, owner_user_id: null }], followers: [USER_C] });
    await call(env, emailHook(idsOf(received())));
    expect(fcmTokens(net).sort()).toEqual(["fcm-a", "fcm-c"]);
    expect(apnsTokens(net)).toEqual(["aa11"]);
    expect(fcmTokens(net)).not.toContain("fcm-d");
    const apple = net.to(/push\.apple\.com/)[0];
    expect(apple.json).toMatchObject({
      aps: { alert: { title: "Jordan Demo", body: "Email: Re: Your 12x24 quote" }, "thread-id": CONTACT_1 },
      type: "email", thread_key: CONTACT_1, message_id: EMAIL_ID,
    });
    expect(apple.headers.get("apns-collapse-id")).toBe(CONTACT_1);
  });

  it("a reply filed only by its quote's code alerts that design's contact's people", async () => {
    const { net, env } = await emailSetup({
      rows: [received({ contact_id: null, short_code: "SS-DEMOQUOTE" })],
      contacts: [{ id: CONTACT_2, client_id: CLIENT, name: "Casey Demo", owner_user_id: USER_A }],
      designs: [{ short_code: "SS-DEMOQUOTE", client_id: CLIENT, contact_id: CONTACT_2 }],
    });
    await call(env, emailHook(idsOf(received())));
    expect(fcmTokens(net)).toEqual(["fcm-a"]);
    expect(net.to(/messages:send$/)[0].json.message).toMatchObject({
      notification: { title: "Casey Demo" }, data: { type: "email", thread_key: CONTACT_2 },
    });
    const design = net.reads("designs")[0];
    expect([filter(design, "client_id"), filter(design, "short_code")]).toEqual([CLIENT, "SS-DEMOQUOTE"]);
  });

  it("no contact of this business, no alert", async () => {
    const cases: Array<{ label: string; rows: EmailFixture[]; designs?: DesignFixture[]; contacts?: ContactFixture[] }> = [
      { label: "neither a contact nor a code", rows: [received({ contact_id: null })] },
      { label: "a design with no contact", rows: [received({ contact_id: null, short_code: "SS-DEMOQUOTE" })],
        designs: [{ short_code: "SS-DEMOQUOTE", client_id: CLIENT, contact_id: null }] },
      { label: "another business's design", rows: [received({ contact_id: null, short_code: "SS-DEMOQUOTE" })],
        designs: [{ short_code: "SS-DEMOQUOTE", client_id: "other-tenant", contact_id: CONTACT_2 }] },
      { label: "a contact id that is another business's contact", rows: [received()],
        contacts: [{ ...JORDAN, client_id: "other-tenant", owner_user_id: null }] },
    ];
    for (const c of cases) {
      const { net, env } = await emailSetup({ rows: c.rows, designs: c.designs, contacts: c.contacts ?? [JORDAN] });
      const { res } = await call(env, emailHook(idsOf(received())));
      expect(res.status, c.label).toBe(204);
      expect(pushes(net), c.label).toEqual([]);
      expect(net.reads("phone_devices"), c.label).toEqual([]);
    }
  });

  it("sends nothing while the business's phone is off", async () => {
    const { net, env } = await emailSetup({ phoneStatus: "off" });
    await call(env, emailHook(idsOf(received())));
    expect(pushes(net)).toEqual([]);
    expect(net.reads("client_users")).toEqual([]);
  });

  it("a payload naming another business for the row finds nothing and sends nothing", async () => {
    const { net, env } = await emailSetup();
    const { res } = await call(env, emailHook({ id: EMAIL_ID, client_id: "other-tenant" }));
    expect(res.status).toBe(204);
    expect(filter(net.reads("email_inbound")[0], "client_id")).toBe("other-tenant");
    expect(pushes(net)).toEqual([]);
  });

  it("trusts nothing in the payload but the id: a forged subject, sender and contact never reach the alert", async () => {
    const { net, env } = await emailSetup();
    await call(env, emailHook({ ...idsOf(received()), subject: "FORGED", from_name: "Mallory", contact_id: CONTACT_2, spam_verdict: VERIFIED }));
    expect(net.to(/messages:send$/)[0].json.message).toMatchObject({
      notification: { title: "Jordan Demo", body: "Email: Re: Your 12x24 quote" },
      data: { thread_key: CONTACT_1 },
    });
    expect(JSON.stringify(pushes(net).map((s) => s.json))).not.toMatch(/FORGED|Mallory/);
  });

  it("a sender the provider couldn't verify rings nobody; no verdict at all still alerts", async () => {
    for (const verdict of ["spam=PASS virus=PASS spf=fail dkim=pass dmarc=fail", "spam=FAIL virus=PASS spf=pass dkim=pass dmarc=pass"]) {
      const { net, env } = await emailSetup({ rows: [received({ spam_verdict: verdict })] });
      await call(env, emailHook(idsOf(received())));
      expect(pushes(net), verdict).toEqual([]);
      expect(net.reads("client_settings"), verdict).toEqual([]);
    }
    const unknown = await emailSetup({ rows: [received({ spam_verdict: null })] });
    await call(unknown.env, emailHook(idsOf(received())));
    expect(fcmTokens(unknown.net)).toEqual(["fcm-a"]);
  });

  it("reads nothing for anything but a new email_inbound row with a real id and business", async () => {
    const bad: Array<[string, Request]> = [
      ["a text's table", emailHook(idsOf(received()), { table: "sms_messages" })],
      ["an update", emailHook(idsOf(received()), { type: "UPDATE" })],
      ["an id that isn't a uuid", emailHook({ id: "1 or 1=1", client_id: CLIENT })],
      ["no business", emailHook({ id: EMAIL_ID })],
      ["mail no business could be found for", emailHook({ id: EMAIL_ID, client_id: "__unattributed__" })],
    ];
    for (const [label, req] of bad) {
      const { net, env } = await emailSetup();
      const { res } = await call(env, req);
      expect(res.status, label).toBe(204);
      expect(net.seen.filter((s) => s.url.pathname.startsWith("/rest/v1/")), label).toEqual([]);
    }
  });

  it("the words: no subject, a long one cut to 140, and a contact with no name titled \"New email\", never by the sender", async () => {
    const send = async (row: Partial<EmailFixture>, contact: Partial<ContactFixture> = {}) => {
      const { net, env } = await emailSetup({ rows: [received(row)], contacts: [{ ...JORDAN, ...contact }] });
      await call(env, emailHook(idsOf(received())));
      return net.to(/messages:send$/)[0].json.message.notification as { title: string; body: string };
    };
    expect((await send({ subject: null })).body).toBe("Email: (no subject)");
    expect((await send({ subject: "  \n " })).body).toBe("Email: (no subject)");
    expect((await send({ subject: "Re: delivery\r\n\tFriday" })).body).toBe("Email: Re: delivery Friday");
    const long = await send({ subject: "x".repeat(300) });
    expect(long.body).toHaveLength(140);
    expect(long.body).toMatch(/^Email: x+\.\.\.$/);
    // The cut lands inside an emoji: the half is dropped, never sent on its own.
    const emoji = await send({ subject: `${"x".repeat(129)}\u{1F600}${"y".repeat(20)}` });
    expect(emoji.body).toBe(`Email: ${"x".repeat(129)}...`);
    // The sender's name and address never go through Google or Apple (the privacy page's promise).
    expect((await send({}, { name: null })).title).toBe("New email");
    expect((await send({ from_name: "Sam Sender" }, { name: "  " })).title).toBe("New email");
    expect((await send({ from_name: null }, { name: null })).title).toBe("New email");
  });

  it("forgets a token FCM says is gone", async () => {
    const { net, env } = await emailSetup({ fcmStatus: 404 });
    await call(env, emailHook(idsOf(received())));
    expect(net.writes("phone_devices", "DELETE")[0].url.searchParams.get("id")).toBe("in.(dA)");
  });
});

describe("APNs topic per build type", () => {
  const IPHONES = [
    { id: "iDev", user_id: USER_A, platform: "ios", build_type: "dev", push_token: "dd01", push_kind: "apns" },
    { id: "iProd", user_id: USER_A, platform: "ios", build_type: "prod", push_token: "pp01", push_kind: "apns" },
  ];

  it("apnsTopic: prod is APNS_BUNDLE_ID; dev is APNS_BUNDLE_ID_DEV, else APNS_BUNDLE_ID + \".dev\"; never the other way", () => {
    // The App Store setup: one secret, the store id. Development builds are the store id + .dev.
    const store = makeEnv({ APNS_BUNDLE_ID: "com.example.mysynergyphone" });
    expect(apnsTopic(store, "prod")).toBe("com.example.mysynergyphone");
    expect(apnsTopic(store, "dev")).toBe("com.example.mysynergyphone.dev");
    // An explicit dev topic wins.
    const both = makeEnv({ APNS_BUNDLE_ID: "com.example.mysynergyphone", APNS_BUNDLE_ID_DEV: "com.example.other.dev" });
    expect(apnsTopic(both, "dev")).toBe("com.example.other.dev");
    expect(apnsTopic(both, "prod")).toBe("com.example.mysynergyphone");
    // The old one-id setup (every build on the .dev id) still sends both to it, never ".dev.dev".
    const one = makeEnv({ APNS_BUNDLE_ID: "com.example.mysynergyphone.dev" });
    expect(apnsTopic(one, "dev")).toBe("com.example.mysynergyphone.dev");
    expect(apnsTopic(one, "prod")).toBe("com.example.mysynergyphone.dev");
    // A prod device never borrows the dev topic.
    const devOnly = makeEnv({ APNS_BUNDLE_ID_DEV: "com.example.mysynergyphone.dev" });
    expect(apnsTopic(devOnly, "prod")).toBeNull();
    expect(apnsTopic(devOnly, "dev")).toBe("com.example.mysynergyphone.dev");
    expect(apnsTopic(makeEnv(), "dev")).toBeNull();
    // A pasted newline is not part of a bundle id.
    expect(apnsTopic(makeEnv({ APNS_BUNDLE_ID: " com.example.mysynergyphone\n" }), "dev")).toBe("com.example.mysynergyphone.dev");
  });

  it("apnsMissing names exactly the secrets a build type still needs", () => {
    expect(apnsMissing(makeEnv(), "prod")).toEqual(["APNS_KEY_P8", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID"]);
    const keyed = makeEnv({ APNS_KEY_P8: "x", APNS_KEY_ID: "KEY0000000", APNS_TEAM_ID: "TEAM000000", APNS_BUNDLE_ID_DEV: "com.example.mysynergyphone.dev" });
    expect(apnsMissing(keyed, "dev")).toEqual([]);
    expect(apnsMissing(keyed, "prod")).toEqual(["APNS_BUNDLE_ID"]);
    expect(apnsMissing({ ...keyed, APNS_TEAM_ID: "  " }, "dev")).toEqual(["APNS_TEAM_ID"]);
  });

  it("each iPhone gets its own build's host and topic, chosen by the device row's build_type", async () => {
    const { net, env } = await setup({
      contact: { name: "Jordan Demo", owner_user_id: USER_A },
      env: { APNS_BUNDLE_ID: "com.example.mysynergyphone", APNS_BUNDLE_ID_DEV: "com.example.mysynergyphone.dev" },
    });
    net.rest("GET", "phone_devices", () => IPHONES);
    await call(env, hook(env, inbound()));
    const sent = net.to(/push\.apple\.com/).map((s) => ({ host: s.url.origin, token: s.url.pathname.split("/").pop(), topic: s.headers.get("apns-topic") }));
    expect(sent.sort((a, b) => a.token!.localeCompare(b.token!))).toEqual([
      { host: "https://api.sandbox.push.apple.com", token: "dd01", topic: "com.example.mysynergyphone.dev" },
      { host: "https://api.push.apple.com", token: "pp01", topic: "com.example.mysynergyphone" },
    ]);
  });

  it("with only APNS_BUNDLE_ID set, a development build gets the .dev topic on the sandbox, the store build its own id", async () => {
    const { net, env } = await setup({ contact: { name: "Jordan Demo", owner_user_id: USER_A }, env: { APNS_BUNDLE_ID: "com.example.mysynergyphone" } });
    net.rest("GET", "phone_devices", () => IPHONES);
    await call(env, hook(env, inbound()));
    const sent = net.to(/push\.apple\.com/).map((s) => [s.url.origin, s.headers.get("apns-topic")]).sort();
    expect(sent).toEqual([
      ["https://api.push.apple.com", "com.example.mysynergyphone"],
      ["https://api.sandbox.push.apple.com", "com.example.mysynergyphone.dev"],
    ]);
    expect(net.writes("app_errors")).toEqual([]);
  });

  it("a build type with no topic is skipped (one warning naming the secret); the other still sends", async () => {
    const { net, env } = await setup({
      contact: { name: "Jordan Demo", owner_user_id: USER_A },
      env: { APNS_BUNDLE_ID: undefined, APNS_BUNDLE_ID_DEV: "com.example.mysynergyphone.dev" },
    });
    net.rest("GET", "phone_devices", () => IPHONES);
    const { res } = await call(env, hook(env, inbound()));
    expect(res.status).toBe(204);
    expect(apnsTokens(net)).toEqual(["dd01"]);
    const logs = net.writes("app_errors").map((s) => s.json);
    expect(logs.map((l) => [l.code, l.severity])).toEqual([["push_apns_not_configured", "warn"]]);
    expect(logs[0].message).toMatch(/^APNS_BUNDLE_ID is not set/);
  });

  it("DeviceTokenNotForTopic is OUR misconfiguration: logged, and the device is NOT forgotten", async () => {
    const { net, env } = await setup({ contact: { name: "Jordan Demo", owner_user_id: USER_A }, env: { APNS_BUNDLE_ID: "com.example.wrong" } });
    net.rest("GET", "phone_devices", () => [IPHONES[1]]);
    net.on("POST", /push\.apple\.com\/3\/device\//, () => jsonRes({ reason: "DeviceTokenNotForTopic" }, 400));
    await call(env, hook(env, inbound()));
    expect(net.writes("phone_devices", "DELETE")).toEqual([]);
    const log = net.writes("app_errors").map((s) => s.json).find((l) => l.code === "push_apns_wrong_topic");
    expect(log?.message).toContain("APNS_BUNDLE_ID");
  });
});

// ── iPhone alerts: what Apple gets, and what each of its answers does ───────────────────

describe("APNs sends", () => {
  const STORE = "com.example.mysynergyphone";

  /** A P-256 key as Apple's .p8 file holds it, and its public half to check signatures with. */
  async function p8(): Promise<{ pem: string; publicKey: CryptoKey }> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
    let bin = "";
    for (const b of der) bin += String.fromCharCode(b);
    return { pem: `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
  }

  const iphone = (id: string, token: string, build_type: "dev" | "prod" = "prod") =>
    ({ id, user_id: USER_A, platform: "ios", build_type, push_token: token, push_kind: "apns" });
  const bearer = (s: { headers: Headers }) => (s.headers.get("authorization") ?? "").replace(/^bearer /, "");
  const owned = { contact: { name: "Jordan Demo", owner_user_id: USER_A } };

  it("carries the app's data under `body` too (expo-notifications on iOS reads nothing else), with the alert itself in aps", async () => {
    const { net, env } = await setup({ ...owned, env: { APNS_BUNDLE_ID: STORE } });
    net.rest("GET", "phone_devices", () => [iphone("i1", "pp01")]);
    await call(env, hook(env, inbound()));
    const apple = net.to(/push\.apple\.com/)[0];
    expect(apple.url.href).toBe("https://api.push.apple.com/3/device/pp01");
    expect(apple.json).toEqual({
      aps: { alert: { title: "Jordan Demo", body: "Is the shed ready?" }, sound: "default", "thread-id": CONTACT_1 },
      body: { type: "sms", thread_key: CONTACT_1, message_id: inbound().id },
      type: "sms", thread_key: CONTACT_1, message_id: inbound().id,
    });
    expect([apple.headers.get("apns-push-type"), apple.headers.get("apns-priority"), apple.headers.get("apns-topic")]).toEqual(["alert", "10", STORE]);
  });

  it("410 and Unregistered/ExpiredToken forget the device; BadDeviceToken forgets it and warns; anything else keeps it", async () => {
    const { net, env } = await setup({ ...owned, env: { APNS_BUNDLE_ID: STORE } });
    net.rest("GET", "phone_devices", () => [
      iphone("iGone", "aa01"), iphone("iExpired", "aa02"), iphone("iBad", "aa03", "dev"), iphone("iBusy", "aa04"), iphone("iOk", "aa05"),
    ]);
    const answers: Record<string, Response> = {
      aa01: jsonRes({ reason: "Unregistered", timestamp: 1_900_000_000_000 }, 410),
      aa02: jsonRes({ reason: "ExpiredToken" }, 410),
      aa03: jsonRes({ reason: "BadDeviceToken" }, 400),
      aa04: jsonRes({ reason: "TooManyRequests" }, 429),
      aa05: new Response(null, { status: 200 }),
    };
    net.on("POST", /push\.apple\.com\/3\/device\//, (s) => answers[s.url.pathname.split("/").pop()!]);
    const { res } = await call(env, hook(env, inbound()));
    expect(res.status).toBe(204);
    expect(net.writes("phone_devices", "DELETE").map((s) => s.url.searchParams.get("id"))).toEqual(["in.(iGone,iExpired,iBad)"]);
    const logs = net.writes("app_errors").map((s) => s.json);
    expect(logs.map((l) => [l.code, l.severity]).sort()).toEqual([["push_apns_bad_device_token", "warn"], ["push_apns_failed", "error"]]);
    expect(logs.find((l) => l.code === "push_apns_bad_device_token").message).toContain("https://api.sandbox.push.apple.com");
  });

  it("signs ONE provider token per isolate: ES256 with the key's id and team (trimmed), shared by a fan-out and the next webhook, renewed after 50 minutes", async () => {
    const key = await p8();
    const t0 = Date.UTC(2026, 9, 5, 12, 0, 0);
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const { net, env } = await setup({ ...owned, env: { APNS_KEY_P8: key.pem, APNS_KEY_ID: "KEY0000000\n", APNS_TEAM_ID: " TEAM000000", APNS_BUNDLE_ID: STORE } });
      net.rest("GET", "phone_devices", () => [iphone("i1", "pp01"), iphone("i2", "pp02"), iphone("i3", "dd01", "dev")]);
      await call(env, hook(env, inbound()));
      const first = net.to(/push\.apple\.com/).map(bearer);
      expect(first).toHaveLength(3);
      expect(new Set(first).size).toBe(1);

      const [h, p, sig] = first[0].split(".");
      expect(b64urlDecodeJson(h)).toEqual({ alg: "ES256", kid: "KEY0000000" });
      expect(b64urlDecodeJson(p)).toEqual({ iss: "TEAM000000", iat: t0 / 1000 });
      // r||s, 64 bytes, and it verifies against the key's public half: what Apple checks.
      const raw = b64urlDecode(sig);
      expect(raw).toHaveLength(64);
      expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key.publicKey, raw, new TextEncoder().encode(`${h}.${p}`))).toBe(true);

      clock.mockReturnValue(t0 + 49 * 60_000);
      await call(env, hook(env, inbound()));
      expect(new Set(net.to(/push\.apple\.com/).map(bearer)).size).toBe(1);

      clock.mockReturnValue(t0 + 51 * 60_000);
      await call(env, hook(env, inbound()));
      const renewed = net.to(/push\.apple\.com/).slice(-3).map(bearer);
      expect(new Set(renewed).size).toBe(1);
      expect(renewed[0]).not.toBe(first[0]);
      expect(b64urlDecodeJson<{ iat: number }>(renewed[0].split(".")[1]).iat).toBe(t0 / 1000 + 51 * 60);
    } finally {
      clock.mockRestore();
    }
  });

  // InvalidProviderToken is not re-signed: re-signing a wrong key id or team id fixes nothing.
  it.each([["ExpiredProviderToken", true], ["InvalidProviderToken", false]] as const)("%s: the next send signs a new token: %s", async (reason, renewed) => {
    const { net, env } = await setup({ ...owned, env: { APNS_BUNDLE_ID: STORE } });
    net.rest("GET", "phone_devices", () => [iphone("i1", "pp01")]);
    net.on("POST", /push\.apple\.com\/3\/device\//, () => jsonRes({ reason }, 403));
    await call(env, hook(env, inbound()));
    await call(env, hook(env, inbound()));
    const [a, b] = net.to(/push\.apple\.com/).map(bearer);
    expect(a !== b).toBe(renewed);
    // The device is fine; the credentials are not.
    expect(net.writes("phone_devices", "DELETE")).toEqual([]);
    const log = net.writes("app_errors").map((s) => s.json).find((l) => l.code === "push_apns_auth_failed");
    expect(log?.message).toContain(reason);
  });

  it("a key that can't sign skips iPhones with one log, Android still gets its alert, and a corrected key works at once", async () => {
    const broken = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    const { net, env } = await setup({ contact: { name: "Jordan Demo", owner_user_id: null }, env: { APNS_KEY_P8: broken, APNS_BUNDLE_ID: STORE } });
    const { res } = await call(env, hook(env, inbound()));
    expect(res.status).toBe(204);
    expect(apnsTokens(net)).toEqual([]);
    expect(fcmTokens(net)).toEqual(["fcm-a"]);
    expect(net.writes("app_errors").map((s) => s.json.code)).toEqual(["push_apns_bad_key"]);

    const fixed = { ...env, APNS_KEY_P8: (await p8()).pem };
    await call(fixed, hook(fixed, inbound()));
    expect(apnsTokens(net)).toEqual(["aa11"]);
  });

  it("Apple out of reach (fetch throws, e.g. no HTTP/2) is logged by name; the other phones still get theirs", async () => {
    const { net, env } = await setup({ contact: { name: "Jordan Demo", owner_user_id: null }, env: { APNS_BUNDLE_ID: STORE } });
    net.on("POST", /push\.apple\.com\/3\/device\//, () => {
      throw new TypeError("Network connection lost.");
    });
    const { res } = await call(env, hook(env, inbound()));
    expect(res.status).toBe(204);
    expect(fcmTokens(net)).toEqual(["fcm-a"]);
    const log = net.writes("app_errors").map((s) => s.json).find((l) => l.code === "push_apns_unreachable");
    expect(log?.message).toContain("https://api.sandbox.push.apple.com");
    expect(log?.message).toContain("Network connection lost.");
    expect(net.writes("phone_devices", "DELETE")).toEqual([]);
  });

  it("a sender that throws is logged, never dropped silently, and never costs another phone its alert", async () => {
    const { net, env } = await setup({ contact: { name: "Jordan Demo", owner_user_id: null }, env: { APNS_BUNDLE_ID: STORE } });
    // Google's token exchange fails: sendFcm throws for every Android device.
    net.on("POST", (u) => u.href === "https://oauth2.example.test/token", () => jsonRes({ error: "invalid_grant" }, 400));
    const { res } = await call(env, hook(env, inbound()));
    expect(res.status).toBe(204);
    expect(fcmTokens(net)).toEqual([]);
    expect(apnsTokens(net)).toEqual(["aa11"]);
    const logs = net.writes("app_errors").map((s) => s.json);
    expect(logs.map((l) => l.code)).toEqual(["push_fcm_threw"]);
    expect(logs[0].message).toContain("Google token exchange failed (HTTP 400)");
  });
});
