// WHO IS CALLING — the one place every JWT-authenticated portal function asks it.
//
// resolveTenant uses it, and so do the functions that resolve their caller differently
// (portal-commissions, portal-feedback, portal-projects, operator-portal). They each used to
// paste the same five lines around auth.getUser(), which is how one of them kept paying a
// GoTrue round trip after the others stopped (2026-10-01).
//
// FAST PATH: verify the token here (_shared/localJwt.ts) and ask the database, in ONE query
// (resolve_caller, migration 257), whether its session is still alive and which business the
// caller belongs to. getUser() was a round trip to GoTrue on every call and the slowest, least
// predictable part of the preamble — 2.6–3.5 s on a bad call against 0.12–0.16 s on a good one.
//   verified + session live  → this user, plus their client_users row already in hand.
//   verified + session gone  → 401, the same answer getUser() gives a signed-out token.
//   invalid                  → 401 (expired, forged, malformed).
//   unchecked, or the query failed (migration 257 missing, a blip) → getUser(), exactly as
//   before. Slower, never weaker: nothing here turns "could not check" into "allowed".

// Same specifier every function in this project uses — mixing jsr: and esm.sh would
// bundle two copies of supabase-js into each function.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkAccessToken } from "./localJwt.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

/** The caller's client_users row, as both the fast path and the plain read return it. */
export type MappingRow = { client_id: string; role: string | null; title: string | null; access: unknown };

export type Caller = {
  /** Only the three fields any portal function reads; all three are in the access token.
   *  `email` is undefined when the account has none, exactly as on getUser()'s User — callers
   *  write `user.email ?? null`, and an empty string there would change what they store. */
  user: { id: string; email?: string; user_metadata: Record<string, unknown> };
  /**
   * The caller's own client_users row (same columns and unordered `limit 1` as the reads it
   * replaces) when the fast path already fetched it: [] means "no business linked". NULL means
   * it was NOT read — the getUser fallback — and the caller must query it as it always did.
   */
  mapping: MappingRow[] | null;
  /** "local" = the fast path held; "network" = GoTrue answered. For Server-Timing. */
  authPath: "local" | "network";
};

export type CallerResult =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401; body: { error: string; reason: string } };

// WHICH check refused, in the same fixed-enum `reason` the GoTrue path already returns ("missing" |
// "anon_key" | "rejected"). The portal only LOGS it (app_errors context.reason) and never branches
// on it. Added 2026-10-02 after a sign-out on beta that the log could not attribute: "rejected"
// was shared by an expired token, a forged one, an ENDED session and GoTrue saying no.
//   token_expired — exp has passed (the same answer getUser gives);
//   token_invalid — bad signature or a malformed token;
//   session_ended — validly signed, but the session row is gone or past not_after, or the user is
//                   deleted or banned: signed out somewhere, which GoTrue also refuses
//                   (session_not_found).
// Naming the reason back to the caller that holds the token leaks nothing.
const refused = (reason: "token_expired" | "token_invalid" | "session_ended"): CallerResult =>
  ({ ok: false, status: 401, body: { error: "Not signed in.", reason } });

export async function verifyCaller(req: Request, admin: Admin): Promise<CallerResult> {
  const authHeader = req.headers.get("Authorization") || "";

  const local = await checkAccessToken(authHeader.replace(/^Bearer\s+/i, "").trim());
  if (local.kind === "invalid") return refused(local.why);
  if (local.kind === "verified") {
    const { data: rows, error: rpcErr } = await admin.rpc("resolve_caller", {
      p_user_id: local.sub,
      p_session_id: local.sessionId,
    });
    const row = !rpcErr && Array.isArray(rows) ? rows[0] : null;
    if (row) {
      if (!row.session_live) return refused("session_ended");
      return {
        ok: true,
        caller: {
          user: { id: local.sub, email: local.email || undefined, user_metadata: local.userMetadata },
          mapping: row.client_id
            ? [{ client_id: row.client_id, role: row.role, title: row.title, access: row.access }]
            : [],
          authPath: "local",
        },
      };
    }
  }

  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const u = userData?.user;
  if (userErr || !u) return notSignedIn(authHeader);
  return {
    ok: true,
    caller: {
      user: { id: u.id, email: u.email, user_metadata: u.user_metadata ?? {} },
      mapping: null,
      authPath: "network",
    },
  };
}

/** The 401 for a caller GoTrue would not vouch for, with WHY in a fixed enum. */
function notSignedIn(authHeader: string): CallerResult {
  // WHICH failure this was is the one thing the log could never say. Every cause
  // collapsed into this single string with `userErr` thrown away, so 34 "Not signed in."
  // rows across four weeks could not distinguish a tab that sent the BARE ANON KEY
  // because its session had momentarily vanished from a real token being rejected — and
  // those two want opposite fixes. Classify instead of guessing. It costs no round trip,
  // and naming the credential back to the caller that just sent it leaks nothing (the
  // reason is deliberately a fixed enum, never `userErr.message`, which is provider text
  // this project's error contract keeps out of the browser).
  // Classify STRUCTURALLY rather than by comparing against SUPABASE_ANON_KEY. That env
  // value and the literal baked into the browser bundle live in two different deploy
  // pipelines, and the day they drift the classifier would invert in silence — reporting
  // "a real token was refused" for precisely the case where no user token was sent, which
  // is worse than the one ambiguous string it replaces. The shape is the fact: an anon key
  // is a well-formed JWT whose payload carries role "anon" and no `sub`.
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const claims: Record<string, unknown> | null = (() => {
    try {
      const part = bearer.split(".")[1];
      if (!part) return null;
      const b = part.replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(b + "=".repeat((4 - (b.length % 4)) % 4))) as Record<string, unknown>;
    } catch { return null; }
  })();
  const reason = !bearer
    ? "missing"
    : (claims && !claims.sub && claims.role === "anon") ? "anon_key" : "rejected";
  return { ok: false, status: 401, body: { error: "Not signed in.", reason } };
}
