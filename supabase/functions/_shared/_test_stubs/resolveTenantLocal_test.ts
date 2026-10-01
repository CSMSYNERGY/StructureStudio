// resolveTenant's FAST PATH (2026-10-01): the access token verified here against the project's
// signing key, then ONE resolve_caller query for "is the session alive + which business".
// resolveTenant_test.ts covers everything else and sends "Bearer x", which can never take this
// path — so these tests sign real ES256 tokens with a throwaway key.
//
// What must hold, and what each test proves:
//   • a live session is let in WITHOUT asking GoTrue and WITHOUT a second client_users read;
//   • a signed-out session is refused even though GoTrue (the stub) would have said yes —
//     i.e. the fast path cannot be weaker than the slow one on sign-out;
//   • expired / forged tokens are refused on the spot;
//   • anything the fast path cannot decide falls back to getUser, never to "allowed".

// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "jsr:@std/assert@1";
import * as jose from "jsr:@panva/jose@6";
import { resolveTenant } from "../resolveTenant.ts";
import { useKeysForTest } from "../localJwt.ts";
import { verifyCaller } from "../verifyCaller.ts";
import { stubAuth } from "./supabase_stub.ts";

Deno.env.set("SUPABASE_URL", "https://stub.supabase.co");
Deno.env.set("SUPABASE_ANON_KEY", "stub-anon");

const ISS = "https://stub.supabase.co/auth/v1";
const KID = "test-key-1";
const UID = "11111111-2222-4333-8444-555555555555";
const SID = "66666666-7777-4888-9999-aaaaaaaaaaaa";

const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
const jwk = { ...(await jose.exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };
useKeysForTest(jose.createLocalJWKSet({ keys: [jwk] }), ISS);

// A second key the project never published — for the forged-token case.
const rogue = await jose.generateKeyPair("ES256");

async function token(opts: {
  sub?: string; sid?: string | null; iss?: string; exp?: number; key?: CryptoKey; email?: string;
} = {}) {
  const claims: Record<string, unknown> = { email: opts.email ?? "owner@acme.test", role: "authenticated" };
  if (opts.sid !== null) claims.session_id = opts.sid ?? SID;
  return await new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setSubject(opts.sub ?? UID)
    .setIssuer(opts.iss ?? ISS)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(opts.key ?? privateKey);
}

type RpcRow = { session_live: boolean; client_id: string | null; role: string | null; title: string | null; access: unknown };

/** Service-role fake: resolve_caller answers from `rpcRows`; any table read is COUNTED, so a test
 *  can prove the fast path did not fetch client_users a second time. */
function makeAdmin(rpcRows: RpcRow[] | { error: string }, fallbackUsers: any[] = []) {
  const calls = { rpc: [] as any[], from: [] as string[] };
  const admin = {
    rpc(fn: string, args: any) {
      calls.rpc.push({ fn, args });
      if ("error" in rpcRows) return Promise.resolve({ data: null, error: { message: rpcRows.error } });
      return Promise.resolve({ data: rpcRows, error: null });
    },
    from(table: string) {
      calls.from.push(table);
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        limit: () => Promise.resolve({ data: table === "client_users" ? fallbackUsers : [], error: null }),
        insert: () => Promise.resolve({ error: null }),
      };
      return chain;
    },
  };
  return { admin, calls };
}

function req(bearer: string, body: unknown = { action: "status" }) {
  return new Request("https://stub/fn", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const READS = new Set(["status"]);
const LIVE_OWNER: RpcRow[] = [{ session_live: true, client_id: "acme", role: "owner", title: null, access: null }];
const DEAD_OWNER: RpcRow[] = [{ session_live: false, client_id: "acme", role: "owner", title: null, access: null }];

/** GoTrue (the stub) says SIGNED IN — so a refusal can only have come from the fast path. */
function goTrueSaysYes() { stubAuth.user = { id: UID, email: "owner@acme.test" }; stubAuth.error = null; }
/** GoTrue says NO — so a success can only have come from the fast path. */
function goTrueSaysNo() { stubAuth.user = null; stubAuth.error = null; }

Deno.test("live session: in, without GoTrue and without a second client_users read", async () => {
  goTrueSaysNo();
  const { admin, calls } = makeAdmin(LIVE_OWNER);
  const r = await resolveTenant(req(await token()), admin, { readActions: READS });
  assertEquals(r.ok, true);
  assertEquals((r as any).ctx.clientId, "acme");
  assertEquals((r as any).ctx.role, "owner");
  assertEquals((r as any).ctx.userId, UID);
  assertEquals((r as any).ctx.userEmail, "owner@acme.test");
  assertEquals((r as any).ctx.authPath, "local");
  assertEquals(calls.rpc, [{ fn: "resolve_caller", args: { p_user_id: UID, p_session_id: SID } }]);
  assertEquals(calls.from.includes("client_users"), false);
});

Deno.test("SIGNED-OUT session: 401 even though GoTrue would have said yes", async () => {
  goTrueSaysYes();
  const { admin } = makeAdmin(DEAD_OWNER);
  const r = await resolveTenant(req(await token()), admin, { readActions: READS });
  assertEquals(r.ok, false);
  assertEquals((r as any).status, 401);
  assertEquals((r as any).body.reason, "session_ended");
});

Deno.test("signed-out session still 401s before a malformed body 400s (precedence)", async () => {
  goTrueSaysYes();
  const { admin } = makeAdmin(DEAD_OWNER);
  const r = await resolveTenant(req(await token(), "{not json"), admin, { readActions: READS });
  assertEquals((r as any).status, 401);
});

Deno.test("expired token: 401 on the spot, no query, no GoTrue", async () => {
  goTrueSaysYes();
  const { admin, calls } = makeAdmin(LIVE_OWNER);
  const r = await resolveTenant(req(await token({ exp: Math.floor(Date.now() / 1000) - 60 })), admin, { readActions: READS });
  assertEquals((r as any).status, 401);
  assertEquals((r as any).body.reason, "token_expired");
  assertEquals(calls.rpc.length, 0);
});

Deno.test("forged token (signed by a key the project never published): 401", async () => {
  goTrueSaysYes();
  const { admin, calls } = makeAdmin(LIVE_OWNER);
  const r = await resolveTenant(req(await token({ key: rogue.privateKey })), admin, { readActions: READS });
  assertEquals((r as any).status, 401);
  assertEquals((r as any).body.reason, "token_invalid");
  assertEquals(calls.rpc.length, 0);
});

Deno.test("resolve_caller fails (migration not applied, a blip): falls back to GoTrue, not open", async () => {
  // Falls back AND GoTrue says no → refused. Proves the fallback is a check, not a pass.
  goTrueSaysNo();
  const no = makeAdmin({ error: "function public.resolve_caller does not exist" });
  const r1 = await resolveTenant(req(await token()), no.admin, { readActions: READS });
  assertEquals((r1 as any).status, 401);
  // Falls back AND GoTrue says yes → in, via the old client_users read, marked "network".
  goTrueSaysYes();
  const yes = makeAdmin({ error: "timeout" }, [{ client_id: "acme", role: "owner" }]);
  const r2 = await resolveTenant(req(await token()), yes.admin, { readActions: READS });
  assertEquals(r2.ok, true);
  assertEquals((r2 as any).ctx.authPath, "network");
  assertEquals(yes.calls.from.includes("client_users"), true);
});

Deno.test("wrong issuer: not refused outright (it is probably OUR config) — GoTrue decides", async () => {
  goTrueSaysNo();
  const { admin, calls } = makeAdmin(LIVE_OWNER);
  const r = await resolveTenant(req(await token({ iss: "https://elsewhere.example/auth/v1" })), admin, { readActions: READS });
  assertEquals((r as any).status, 401); // GoTrue said no
  assertEquals(calls.rpc.length, 0);    // and the fast path never vouched for it
});

Deno.test("no session_id claim: nothing to check sign-out against, so GoTrue decides", async () => {
  goTrueSaysNo();
  const { admin, calls } = makeAdmin(LIVE_OWNER);
  const r = await resolveTenant(req(await token({ sid: null })), admin, { readActions: READS });
  assertEquals((r as any).status, 401);
  assertEquals(calls.rpc.length, 0);
});

Deno.test("bare anon key (HS256, no kid) still reaches GoTrue and is still classified anon_key", async () => {
  goTrueSaysNo();
  const anon = await new jose.SignJWT({ role: "anon" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("supabase")
    .sign(new TextEncoder().encode("not-the-real-secret-but-long-enough-32b"));
  const { admin, calls } = makeAdmin(LIVE_OWNER);
  const r = await resolveTenant(req(anon), admin, { readActions: READS });
  assertEquals((r as any).status, 401);
  assertEquals((r as any).body.reason, "anon_key");
  assertEquals(calls.rpc.length, 0);
});

Deno.test("live session but no business linked: 403, same as the slow path", async () => {
  goTrueSaysNo();
  const { admin } = makeAdmin([{ session_live: true, client_id: null, role: null, title: null, access: null }]);
  const r = await resolveTenant(req(await token()), admin, { readActions: READS });
  assertEquals((r as any).status, 403);
});

// ── verifyCaller, which the four functions outside resolveTenant now call directly ─────────
// (portal-commissions, portal-feedback, portal-projects, operator-portal). portal-feedback names
// the submitter from user_metadata and stores `user.email ?? null`, so both must come through
// the fast path exactly as getUser() delivered them.

Deno.test("verifyCaller fast path: id, email and user_metadata from the token; mapping in hand", async () => {
  goTrueSaysNo();
  const t = await new jose.SignJWT({
    email: "pat@acme.test", role: "authenticated", session_id: SID,
    user_metadata: { full_name: "Pat Builder" },
  })
    .setProtectedHeader({ alg: "ES256", kid: KID }).setSubject(UID).setIssuer(ISS)
    .setAudience("authenticated").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const { admin } = makeAdmin(LIVE_OWNER);
  const v = await verifyCaller(req(t), admin);
  assertEquals(v.ok, true);
  const c = (v as any).caller;
  assertEquals(c.user, { id: UID, email: "pat@acme.test", user_metadata: { full_name: "Pat Builder" } });
  assertEquals(c.mapping, [{ client_id: "acme", role: "owner", title: null, access: null }]);
  assertEquals(c.authPath, "local");
});

Deno.test("verifyCaller: a token with no email gives email undefined (callers write `email ?? null`)", async () => {
  goTrueSaysNo();
  const t = await new jose.SignJWT({ role: "authenticated", session_id: SID })
    .setProtectedHeader({ alg: "ES256", kid: KID }).setSubject(UID).setIssuer(ISS)
    .setAudience("authenticated").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const { admin } = makeAdmin(LIVE_OWNER);
  const v = await verifyCaller(req(t), admin);
  assertEquals((v as any).caller.user.email, undefined);
  assertEquals((v as any).caller.user.user_metadata, {});
});

Deno.test("verifyCaller fallback: mapping is NULL, so the caller knows to read client_users itself", async () => {
  goTrueSaysYes();
  const v = await verifyCaller(req("x"), makeAdmin(LIVE_OWNER).admin);
  assertEquals(v.ok, true);
  assertEquals((v as any).caller.mapping, null);
  assertEquals((v as any).caller.authPath, "network");
});
