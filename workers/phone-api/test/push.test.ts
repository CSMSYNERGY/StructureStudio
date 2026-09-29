// /push/text: who gets a text alert, and how it is sent (FCM HTTP v1, APNs).
import { describe, expect, it, vi } from "vitest";

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

import { BASE, CLIENT, CONTACT_1, CUSTOMER, FakeNet, USER_A, USER_B, USER_C, call, filter, jsonRes, makeEnv } from "./helpers";
import type { Env } from "../src/env";
import { apnsTopic } from "../src/routes/push";

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
    APNS_KEY_P8: await pem("ec"), APNS_KEY_ID: "KEY0000000", APNS_TEAM_ID: "TEAM000000", APNS_BUNDLE_ID: "com.example.sssphone.dev",
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
    expect(apple.headers.get("apns-topic")).toBe("com.example.sssphone.dev");
    expect(apple.headers.get("apns-push-type")).toBe("alert");
    expect(apple.headers.get("authorization")).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(apple.json.aps.alert).toEqual({ title: "Jordan Demo", body: "Is the shed ready?" });
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

  it("skips a platform whose credentials are unset, logging it once (info), never failing the webhook", async () => {
    const { net, env } = await setup({ contact: { name: "J", owner_user_id: null }, env: { FCM_SERVICE_ACCOUNT_JSON: undefined, APNS_KEY_P8: undefined } });
    const { res } = await call(env, hook(env, inbound()));
    expect(res.status).toBe(204);
    expect(net.to(/messages:send|push\.apple/)).toEqual([]);
    const logs = net.writes("app_errors").map((s) => s.json);
    expect(logs.map((l) => l.code).sort()).toEqual(["push_apns_not_configured_dev", "push_fcm_not_configured"]);
    expect(logs.every((l) => l.severity === "info" && l.source === "edge:phone-api")).toBe(true);
    expect(filter(net.reads("client_users")[0], "client_id")).toBe(CLIENT);
  });
});

describe("APNs topic per build type", () => {
  const IPHONES = [
    { id: "iDev", user_id: USER_A, platform: "ios", build_type: "dev", push_token: "dd01", push_kind: "apns" },
    { id: "iProd", user_id: USER_A, platform: "ios", build_type: "prod", push_token: "pp01", push_kind: "apns" },
  ];

  it("apnsTopic: APNS_BUNDLE_ID_DEV for dev (falling back to APNS_BUNDLE_ID), APNS_BUNDLE_ID for prod, never the other way", () => {
    const both = makeEnv({ APNS_BUNDLE_ID: "com.example.sssphone", APNS_BUNDLE_ID_DEV: "com.example.sssphone.dev" });
    expect(apnsTopic(both, "dev")).toBe("com.example.sssphone.dev");
    expect(apnsTopic(both, "prod")).toBe("com.example.sssphone");
    const one = makeEnv({ APNS_BUNDLE_ID: "com.example.sssphone.dev" });
    expect(apnsTopic(one, "dev")).toBe("com.example.sssphone.dev");
    expect(apnsTopic(one, "prod")).toBe("com.example.sssphone.dev");
    const devOnly = makeEnv({ APNS_BUNDLE_ID_DEV: "com.example.sssphone.dev" });
    expect(apnsTopic(devOnly, "prod")).toBeNull();
  });

  it("each iPhone gets its own build's host and topic, chosen by the device row's build_type", async () => {
    const { net, env } = await setup({
      contact: { name: "Jordan Demo", owner_user_id: USER_A },
      env: { APNS_BUNDLE_ID: "com.example.sssphone", APNS_BUNDLE_ID_DEV: "com.example.sssphone.dev" },
    });
    net.rest("GET", "phone_devices", () => IPHONES);
    await call(env, hook(env, inbound()));
    const sent = net.to(/push\.apple\.com/).map((s) => ({ host: s.url.origin, token: s.url.pathname.split("/").pop(), topic: s.headers.get("apns-topic") }));
    expect(sent.sort((a, b) => a.token!.localeCompare(b.token!))).toEqual([
      { host: "https://api.sandbox.push.apple.com", token: "dd01", topic: "com.example.sssphone.dev" },
      { host: "https://api.push.apple.com", token: "pp01", topic: "com.example.sssphone" },
    ]);
  });

  it("a build type with no topic is skipped (logged per build type); the other still sends", async () => {
    const { net, env } = await setup({
      contact: { name: "Jordan Demo", owner_user_id: USER_A },
      env: { APNS_BUNDLE_ID: undefined, APNS_BUNDLE_ID_DEV: "com.example.sssphone.dev" },
    });
    net.rest("GET", "phone_devices", () => IPHONES);
    const { res } = await call(env, hook(env, inbound()));
    expect(res.status).toBe(204);
    expect(apnsTokens(net)).toEqual(["dd01"]);
    expect(net.writes("app_errors").map((s) => s.json.code)).toEqual(["push_apns_not_configured_prod"]);
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
