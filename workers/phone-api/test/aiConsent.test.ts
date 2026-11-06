// Each team member's yes or no to third-party AI on their calls (migration 307, src/aiConsent.ts):
// POST /settings/me/ai-transcripts saves it, /token `ai_consent` reads it back (and is left out
// when it can't be read), and who counts as "on the call". The minute tick that obeys it is
// test/transcribe.test.ts. Every value is made up.
import { describe, expect, it } from "vitest";
import { AI_CONSENT_MIN_VERSION, allowsAi, consentOut, teamsOf } from "../src/aiConsent";
import { Auth, CLIENT, FakeNet, USER_A, USER_B, USER_C, allowed, appRequest, call, callerCtx, jsonRes, makeEnv } from "./helpers";

const CALL_1 = "00000000-0000-4000-8000-0000000ca001";
const CALL_2 = "00000000-0000-4000-8000-0000000ca002";

async function setup(ctx: Record<string, unknown> | null = callerCtx()) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => ctx);
  net.rest("POST", "app_errors", () => []);
  return { net, auth, token: await auth.token(USER_A), env: makeEnv() };
}

describe("the answer", () => {
  it("reads back as the apps see it: allowed or declined with its version and time, else never answered", () => {
    expect(consentOut(allowed(USER_A))).toEqual({ choice: "allowed", version: 1, at: "2026-10-13T12:00:00Z" });
    expect(consentOut({ ai_transcripts: "declined", ai_transcripts_version: 1, ai_transcripts_at: "2026-10-13T12:05:00Z" }))
      .toEqual({ choice: "declined", version: 1, at: "2026-10-13T12:05:00Z" });
    for (const none of [null, undefined, {}, { ai_transcripts: null }, { ai_transcripts: "maybe", ai_transcripts_version: 1 }]) {
      expect(consentOut(none as never)).toEqual({ choice: null, version: null, at: null });
    }
  });

  it("only a yes to a notice version that still counts lets calls go", () => {
    expect(AI_CONSENT_MIN_VERSION).toBe(1);
    expect(allowsAi(allowed(USER_A))).toBe(true);
    expect(allowsAi(allowed(USER_A, 2))).toBe(true);
    expect(allowsAi(allowed(USER_A, 0))).toBe(false);
    expect(allowsAi({ ai_transcripts: "allowed", ai_transcripts_version: null })).toBe(false);
    expect(allowsAi({ ai_transcripts: "declined", ai_transcripts_version: 1 })).toBe(false);
    expect(allowsAi(null)).toBe(false);
  });
});

describe("who is on a call", () => {
  it("whoever placed, answered or handed it on, and every teammate the Worker's transfers name; never an app's mark", () => {
    const teams = teamsOf(
      [
        { id: CALL_1, placed_by: null, answered_by: USER_C, transferred_from: USER_B },
        { id: CALL_2, placed_by: USER_A.toUpperCase(), answered_by: null, transferred_from: null },
      ],
      [
        { call_id: CALL_1, type: "transfer", data: { from: USER_A, to: USER_B } },
        { call_id: CALL_1, type: "warm_transfer", data: { from: USER_B, to: USER_C } },
        { call_id: CALL_2, type: "warm_transfer", data: { source: "app", from: USER_A, to: USER_B } },
        { call_id: CALL_2, type: "transfer", data: { from: "not-a-user", to: null } },
        { call_id: "00000000-0000-4000-8000-0000000ca003", type: "transfer", data: { from: USER_C } },
      ],
    );
    expect([...teams.get(CALL_1)!].sort()).toEqual([USER_A, USER_B, USER_C].sort());
    // Ids compare in lower case, as the database writes them.
    expect([...teams.get(CALL_2)!]).toEqual([USER_A]);
    expect(teams.size).toBe(2);
  });
});

describe("POST /settings/me/ai-transcripts", () => {
  it("saves the answer with its notice version and the time (upsert on user_id) and returns it", async () => {
    const { net, token, env } = await setup();
    net.rest("POST", "phone_user_settings", (s) => [{
      ai_transcripts: s.json.ai_transcripts, ai_transcripts_version: s.json.ai_transcripts_version, ai_transcripts_at: s.json.ai_transcripts_at,
    }]);
    const before = Date.now();
    const { res, json } = await call(env, appRequest("POST", "/settings/me/ai-transcripts", token, { choice: "allowed", version: 1 }));
    expect(res.status).toBe(200);
    const w = net.writes("phone_user_settings")[0];
    expect(w.json).toMatchObject({ user_id: USER_A, client_id: CLIENT, ai_transcripts: "allowed", ai_transcripts_version: 1 });
    expect(Date.parse(w.json.ai_transcripts_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(w.json.updated_at).toBe(w.json.ai_transcripts_at);
    // Nothing else of the person's settings is in the write.
    expect(Object.keys(w.json).sort()).toEqual(["ai_transcripts", "ai_transcripts_at", "ai_transcripts_version", "client_id", "updated_at", "user_id"]);
    expect(w.url.searchParams.get("on_conflict")).toBe("user_id");
    expect(w.headers.get("prefer")).toContain("resolution=merge-duplicates");
    expect(json).toEqual({ ok: true, ai_consent: { choice: "allowed", version: 1, at: w.json.ai_transcripts_at } });
  });

  it("a no is saved the same way", async () => {
    const { net, token, env } = await setup();
    net.rest("POST", "phone_user_settings", (s) => [{ ai_transcripts: s.json.ai_transcripts, ai_transcripts_version: s.json.ai_transcripts_version, ai_transcripts_at: s.json.ai_transcripts_at }]);
    const { json } = await call(env, appRequest("POST", "/settings/me/ai-transcripts", token, { choice: "declined", version: 1 }));
    expect(json.ai_consent).toMatchObject({ choice: "declined", version: 1 });
    expect(net.writes("phone_user_settings")[0].json.ai_transcripts).toBe("declined");
  });

  it.each([
    [{}, "Choose Allow or Don't allow."],
    [{ choice: "maybe", version: 1 }, "Choose Allow or Don't allow."],
    [{ choice: null, version: 1 }, "Choose Allow or Don't allow."],
    [{ choice: "allowed" }, "That notice version isn't one we know."],
    [{ choice: "allowed", version: 0 }, "That notice version isn't one we know."],
    [{ choice: "allowed", version: 1.5 }, "That notice version isn't one we know."],
    [{ choice: "allowed", version: "1" }, "That notice version isn't one we know."],
    [{ choice: "allowed", version: 40000 }, "That notice version isn't one we know."],
  ])("refuses %j and writes nothing", async (body, message) => {
    const { net, token, env } = await setup();
    const { res, json } = await call(env, appRequest("POST", "/settings/me/ai-transcripts", token, body));
    expect(res.status).toBe(400);
    expect(json.error).toEqual({ code: "bad_request", message });
    expect(net.writes("phone_user_settings")).toEqual([]);
  });

  it("needs a login with phone access (the business's phone may be off)", async () => {
    let s = await setup();
    expect((await call(s.env, appRequest("POST", "/settings/me/ai-transcripts", null, { choice: "allowed", version: 1 }))).res.status).toBe(401);
    s = await setup(callerCtx({ phone_level: "none" }));
    expect((await call(s.env, appRequest("POST", "/settings/me/ai-transcripts", s.token, { choice: "allowed", version: 1 }))).json.error.code).toBe("no_phone_access");
    s = await setup(callerCtx({ phone_status: "off" }));
    s.net.rest("POST", "phone_user_settings", () => [allowed(USER_A)]);
    expect((await call(s.env, appRequest("POST", "/settings/me/ai-transcripts", s.token, { choice: "allowed", version: 1 }))).res.status).toBe(200);
  });

  it("a database without migration 307 fails the save (the apps say it wasn't saved), and nothing is claimed", async () => {
    const { net, token, env } = await setup();
    net.rest("POST", "phone_user_settings", () => jsonRes({ code: "PGRST204", message: "Could not find the 'ai_transcripts' column of 'phone_user_settings' in the schema cache" }, 400));
    const { res, json } = await call(env, appRequest("POST", "/settings/me/ai-transcripts", token, { choice: "allowed", version: 1 }));
    expect(res.status).toBe(500);
    expect(json.ai_consent).toBeUndefined();
  });
});

describe("/token ai_consent", () => {
  async function tokenSetup(consent: (s: unknown) => unknown) {
    const net = new FakeNet().install();
    const auth = await new Auth().init();
    auth.serve(net);
    net.rpc("phone_caller_context", () => callerCtx());
    net.rest("POST", "app_errors", () => []);
    // Two reads of the person's row: the settings (fixed columns) and the answer (migration 307's).
    net.rest("GET", "phone_user_settings", (s) => (String(s.url.searchParams.get("select")).includes("ai_transcripts") ? consent(s) : []));
    return { net, auth };
  }
  const req = async (auth: Auth) => appRequest("POST", "/token", await auth.token(USER_A), { platform: "ios", build_type: "prod", app_version: "1" });

  it("carries the person's answer, read by their own id with the three columns only", async () => {
    const { net, auth } = await tokenSetup(() => [allowed(USER_A)]);
    const { json } = await call(makeEnv(), await req(auth));
    expect(json.ai_consent).toEqual({ choice: "allowed", version: 1, at: "2026-10-13T12:00:00Z" });
    const read = net.reads("phone_user_settings").find((r) => String(r.url.searchParams.get("select")).includes("ai_transcripts"))!;
    expect(read.url.searchParams.get("select")).toBe("ai_transcripts,ai_transcripts_version,ai_transcripts_at");
    expect(read.url.searchParams.get("user_id")).toBe(`eq.${USER_A}`);
  });

  it("no row, or no answer yet: choice null (the apps ask)", async () => {
    let s = await tokenSetup(() => []);
    expect((await call(makeEnv(), await req(s.auth))).json.ai_consent).toEqual({ choice: null, version: null, at: null });
    s = await tokenSetup(() => [{ ai_transcripts: null, ai_transcripts_version: null, ai_transcripts_at: null }]);
    expect((await call(makeEnv(), await req(s.auth))).json.ai_consent).toEqual({ choice: null, version: null, at: null });
  });

  it("can't be read (migration 307 not applied): /token still works, ai_consent is left out, and it's logged as a warning", async () => {
    const { net, auth } = await tokenSetup(() => jsonRes({ code: "42703", message: "column phone_user_settings.ai_transcripts does not exist" }, 400));
    const { res, json } = await call(makeEnv(), await req(auth));
    expect(res.status).toBe(200);
    expect(json.token).toEqual(expect.any(String));
    expect("ai_consent" in json).toBe(false);
    const fault = net.writes("app_errors").find((w) => w.json.code === "ai_consent_unreadable");
    expect(fault?.json).toMatchObject({ severity: "warn" });
    expect(fault?.json.message).toContain("42703");
  });

  it("another person's row is never read", async () => {
    const { net, auth } = await tokenSetup(() => [allowed(USER_B)]);
    await call(makeEnv(), await req(auth));
    for (const r of net.reads("phone_user_settings")) expect(r.url.searchParams.get("user_id")).toBe(`eq.${USER_A}`);
  });
});
