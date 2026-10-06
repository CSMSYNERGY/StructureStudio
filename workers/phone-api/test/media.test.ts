// GET /media/:messageId/:index (inbound MMS, release 2) and the photo refusal on /sms/send.
import { describe, expect, it } from "vitest";
import { storedMediaSid } from "../src/routes/media";
import {
  Auth, CLIENT, CONTACT_1, CUSTOMER, FakeNet, USER_A, appRequest, call, callerCtx, filter, jsonRes, makeEnv,
} from "./helpers";

const MSG = "00000000-0000-4000-8000-00000000e777";
const MM = "MM" + "0".repeat(31) + "1";
const ME0 = "ME" + "0".repeat(31) + "a";
const ME1 = "ME" + "0".repeat(31) + "b";
const FILE_URL = "https://media.example.test/signed/abc?X-Amz-Signature=x";
const API_MEDIA = new RegExp(`^https://api\\.twilio\\.com/2010-04-01/Accounts/AC0+/Messages/${MM}/Media/(ME[0-9a-f]+)$`);

interface Opts {
  ctx?: Record<string, unknown>;
  message?: Record<string, unknown> | null;
  mediaColumn?: boolean;
  visible?: string[];
  list?: { sid: string; content_type: string }[];
  twilioStatus?: number;
  location?: string;
  fileType?: string;
}

async function setup(o: Opts = {}) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => o.ctx ?? callerCtx());
  net.rpc("crm_visible_contact_ids", (s) => o.visible ?? s.json.p_ids);
  const message = o.message === undefined
    ? { id: MSG, contact_id: CONTACT_1, direction: "in", provider_sid: MM, num_media: 2, media: [{ sid: ME0, content_type: "image/jpeg" }, { sid: ME1, content_type: "image/png" }] }
    : o.message;
  net.rest("GET", "sms_messages", (s) => {
    const cols = (s.url.searchParams.get("select") ?? "").split(",").map((c) => c.trim());
    if (cols.includes("media") && o.mediaColumn === false) {
      return new Response(JSON.stringify({ code: "42703", message: "column sms_messages.media does not exist" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (!message) return [];
    if (!cols.includes("media")) {
      const { media: _m, ...rest } = message;
      return [rest];
    }
    return [message];
  });
  net.on("GET", (u) => u.pathname.endsWith(`/Messages/${MM}/Media.json`), () => jsonRes({ media_list: o.list ?? [] }));
  net.on("GET", (u) => API_MEDIA.test(u.href), () =>
    (o.twilioStatus ? jsonRes({ code: 20404 }, o.twilioStatus) : new Response(null, { status: 307, headers: { location: o.location ?? FILE_URL } })));
  net.on("GET", (u) => u.origin === "https://media.example.test", () =>
    new Response("JPEGBYTES", { status: 200, headers: { "content-type": o.fileType ?? "image/jpeg", "content-length": "9" } }));
  return { net, token: await auth.token(USER_A) };
}

const get = (token: string | null, path = `/media/${MSG}/0`) => call(makeEnv(), appRequest("GET", path, token));
const twilioHits = (net: FakeNet) => net.to(/api\.twilio\.com/);

describe("GET /media/:messageId/:index", () => {
  it("streams the photo: our key goes to api.twilio.com only; the signed file URL is fetched WITHOUT it", async () => {
    const { net, token } = await setup();
    const { res, text } = await get(token);
    expect(res.status).toBe(200);
    expect(text).toBe("JPEGBYTES");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const api = net.to(API_MEDIA)[0];
    expect(api.url.pathname.endsWith(`/Media/${ME0}`)).toBe(true);
    expect(api.headers.get("authorization")).toBe(`Basic ${btoa(`SK${"0".repeat(32)}:test-api-secret`)}`);
    const file = net.to(/media\.example\.test/)[0];
    expect(file.headers.get("authorization")).toBeNull();
    // The message is read on the caller's tenant.
    expect(filter(net.reads("sms_messages")[0], "client_id")).toBe(CLIENT);
  });

  it("the index picks the stored media in order", async () => {
    const { net, token } = await setup();
    await get(token, `/media/${MSG}/1`);
    expect(net.to(API_MEDIA)[0].url.pathname.endsWith(`/Media/${ME1}`)).toBe(true);
  });

  it("with no sms_messages.media column yet, falls back to Twilio's list of the message's media", async () => {
    const { net, token } = await setup({ mediaColumn: false, list: [{ sid: ME1, content_type: "image/png" }] });
    const { res } = await get(token);
    expect(res.status).toBe(200);
    expect(net.reads("sms_messages")).toHaveLength(2); // with media → 42703 → without
    expect(net.to(/Media\.json/)).toHaveLength(1);
    expect(net.to(API_MEDIA)[0].url.pathname.endsWith(`/Media/${ME1}`)).toBe(true);
  });

  it("a stored URL is never fetched as-is: only its ME sid is used, on api.twilio.com", async () => {
    const { net, token } = await setup({
      message: { id: MSG, contact_id: CONTACT_1, direction: "in", provider_sid: MM, num_media: 1, media: [`https://evil.example.test/Accounts/AC1/Messages/${MM}/Media/${ME1}`] },
    });
    await get(token);
    expect(net.seen.some((s) => s.url.hostname === "evil.example.test")).toBe(false);
    expect(net.to(API_MEDIA)[0].url.pathname.endsWith(`/Media/${ME1}`)).toBe(true);
  });

  it("anything that isn't a picture, video or audio is a download, never rendered", async () => {
    const { token } = await setup({ message: { id: MSG, contact_id: CONTACT_1, direction: "in", provider_sid: MM, num_media: 1, media: [{ sid: ME0, content_type: "text/html" }] } });
    const { res } = await get(token);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it.each([
    ["a customer an own-scoped user can't see", { ctx: callerCtx({ contacts_level: "own", own_contacts_only: true }), visible: [] }],
    ["an unknown number for someone limited to their own customers", { ctx: callerCtx({ contacts_level: "own", own_contacts_only: true }), message: { id: MSG, contact_id: null, direction: "in", provider_sid: MM, num_media: 1, media: [] } }],
    ["contacts access none", { ctx: callerCtx({ contacts_level: "none" }) }],
    ["an index past the photos", { message: { id: MSG, contact_id: CONTACT_1, direction: "in", provider_sid: MM, num_media: 1, media: null } }],
    ["an outbound text", { message: { id: MSG, contact_id: CONTACT_1, direction: "out", provider_sid: MM, num_media: 1, media: null } }],
    ["another tenant's (or no such) message", { message: null }],
  ] as const)("404s %s, without touching Twilio", async (_l, o) => {
    const path = _l === "an index past the photos" ? `/media/${MSG}/1` : `/media/${MSG}/0`;
    const { net, token } = await setup(o as Opts);
    const { res, json } = await get(token, path);
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("not_found");
    expect(twilioHits(net)).toEqual([]);
  });

  it("is Bearer only (SPEC section 3): a login in ?access_token= is refused, like no login at all", async () => {
    const { net, token } = await setup();
    const q = await get(null, `/media/${MSG}/0?access_token=${token}`);
    expect(q.res.status).toBe(401);
    expect(q.json.error.code).toBe("unauthorized");
    expect((await get(null)).res.status).toBe(401);
    expect(twilioHits(net)).toEqual([]);
  });

  it("media Twilio no longer has is not found; a redirect to plain http is refused", async () => {
    const gone = await setup({ twilioStatus: 404 });
    const a = await get(gone.token);
    expect(a.json.error).toEqual({ code: "not_found", message: "That photo is no longer available." });
    const http = await setup({ location: "http://media.example.test/x" });
    const b = await get(http.token);
    expect(b.json.error.code).toBe("twilio_error");
  });

  it("storedMediaSid reads {sid}, {url} and bare URLs, and nothing else", () => {
    expect(storedMediaSid([{ sid: ME0, content_type: "image/jpeg" }], 0)).toEqual({ sid: ME0, contentType: "image/jpeg" });
    expect(storedMediaSid([{ url: `https://x/Media/${ME1}` }], 0)).toEqual({ sid: ME1, contentType: null });
    expect(storedMediaSid([`https://x/Media/${ME1}.json`], 0)).toEqual({ sid: ME1, contentType: null });
    expect(storedMediaSid([{ sid: "ME123" }], 0)).toBeNull();
    expect(storedMediaSid(null, 0)).toBeNull();
    expect(storedMediaSid([{ sid: ME0 }], 3)).toBeNull();
  });
});

describe("POST /sms/send with photos", () => {
  it("refuses media_urls out loud (sending photos isn't built), and sends nothing", async () => {
    const net = new FakeNet().install();
    const auth = await new Auth().init();
    auth.serve(net);
    net.rpc("phone_caller_context", () => callerCtx());
    const { res, json } = await call(makeEnv(), appRequest("POST", "/sms/send", await auth.token(USER_A), {
      to_e164: CUSTOMER, contact_id: CONTACT_1, body: "Here's the plan", client_temp_id: "t1", media_urls: ["https://example.test/a.jpg"],
    }));
    expect(res.status).toBe(400);
    expect(json.error).toEqual({ code: "bad_request", message: "Sending photos isn't available yet. Send the text on its own." });
    expect(net.to(/api\.twilio\.com/)).toEqual([]);
    expect(net.writes("sms_messages")).toEqual([]);
  });
});
