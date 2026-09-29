import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySupabaseJwt } from "../src/jwt";
import { b64urlEncodeString } from "../src/b64";
import { Auth, FakeNet, SUPABASE_URL, USER_A, makeEnv } from "./helpers";

async function setup() {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  return { net, auth, env: makeEnv() };
}

const jwksFetches = (net: FakeNet) => net.to(/jwks\.json$/).length;

describe("ES256 login tokens", () => {
  it("accepts a token signed by the project's key and returns its claims", async () => {
    const { auth, env } = await setup();
    const claims = await verifySupabaseJwt(env, await auth.token(USER_A));
    expect(claims.sub).toBe(USER_A);
  });

  it("caches the key set per isolate", async () => {
    const { net, auth, env } = await setup();
    await verifySupabaseJwt(env, await auth.token(USER_A));
    await verifySupabaseJwt(env, await auth.token(USER_A));
    expect(jwksFetches(net)).toBe(1);
  });

  it("refetches the key set when a token names an unknown kid (a rotation)", async () => {
    const { net, auth, env } = await setup();
    await verifySupabaseJwt(env, await auth.token(USER_A));
    const rotated = await new Auth().init(); // a new kid
    // The project now publishes both keys.
    net.on("GET", (u) => u.href === `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, () => ({
      keys: [...auth.jwks().keys, ...rotated.jwks().keys],
    }));
    await expect(verifySupabaseJwt(env, await rotated.token(USER_A))).resolves.toMatchObject({ sub: USER_A });
    expect(jwksFetches(net)).toBe(2);
  });

  it("does not refetch on every forged kid (one refetch, then at most once per 30 s)", async () => {
    const { net, auth, env } = await setup();
    await verifySupabaseJwt(env, await auth.token(USER_A));
    for (let i = 0; i < 3; i++) {
      await expect(verifySupabaseJwt(env, await auth.token(USER_A, {}, { kid: `forged-${i}` }))).rejects.toMatchObject({ code: "unauthorized" });
    }
    expect(jwksFetches(net)).toBe(2);
    // The real key still works from the cache.
    await expect(verifySupabaseJwt(env, await auth.token(USER_A))).resolves.toMatchObject({ sub: USER_A });
    expect(jwksFetches(net)).toBe(2);
  });

  it.each([
    ["expired", { exp: Math.floor(Date.now() / 1000) - 120 }],
    ["for another audience", { aud: "anon" }],
    ["from another issuer", { iss: "https://other.example.test/auth/v1" }],
    ["for an anonymous session", { is_anonymous: true }],
    ["with a service role", { role: "service_role" }],
    ["with no user id", { sub: "" }],
  ])("refuses a token that is %s", async (_label, over) => {
    const { auth, env } = await setup();
    await expect(verifySupabaseJwt(env, await auth.token(USER_A, over))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("refuses a token signed by a different key under the same kid", async () => {
    const { auth, env } = await setup();
    const impostor = await new Auth().init();
    impostor.kid = auth.kid; // same kid, different key
    await verifySupabaseJwt(env, await auth.token(USER_A)); // cache the real key
    await expect(verifySupabaseJwt(env, await impostor.token(USER_A))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("refuses alg none", async () => {
    const { env } = await setup();
    const now = Math.floor(Date.now() / 1000);
    const t = `${b64urlEncodeString(JSON.stringify({ alg: "none" }))}.${b64urlEncodeString(JSON.stringify({ sub: USER_A, aud: "authenticated", iss: `${SUPABASE_URL}/auth/v1`, exp: now + 60 }))}.`;
    await expect(verifySupabaseJwt(env, t)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("accepts HS256 only when the legacy secret is configured", async () => {
    const { env } = await setup();
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64urlEncodeString(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64urlEncodeString(JSON.stringify({ sub: USER_A, aud: "authenticated", role: "authenticated", iss: `${SUPABASE_URL}/auth/v1`, exp: now + 60 }))}`;
    const sig = createHmac("sha256", "legacy-secret").update(input).digest("base64url");
    const t = `${input}.${sig}`;
    await expect(verifySupabaseJwt(env, t)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifySupabaseJwt(makeEnv({ SUPABASE_JWT_SECRET: "legacy-secret" }), t)).resolves.toMatchObject({ sub: USER_A });
    await expect(verifySupabaseJwt(makeEnv({ SUPABASE_JWT_SECRET: "wrong" }), t)).rejects.toMatchObject({ code: "unauthorized" });
  });
});
