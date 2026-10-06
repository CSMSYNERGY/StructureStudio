// Who is calling an app endpoint: the verified login, and their phone context from ONE
// uncached RPC (phone_caller_context). Every app endpoint goes through here, so a person removed
// from the team, or set to phone access `none`, is refused on their very next request rather
// than when their login token runs out.

import type { Env } from "./env";
import { adminClient, callerContext, type Admin, type CallerContext } from "./db";
import { ApiError } from "./http";
import { bearerToken, verifySupabaseJwt, type AuthClaims } from "./jwt";

export interface Caller {
  admin: Admin;
  claims: AuthClaims;
  token: string;
  userId: string;
  ctx: CallerContext;
}

export interface RequireOpts {
  /** ?access_token= is accepted (voicemail audio only, for extension builds from before 2026-09-29 that play it through <audio src>). */
  allowQueryToken?: boolean;
  /** Refuse unless the tenant's phone switch is on. Default true. */
  needOn?: boolean;
}

export async function requireCaller(env: Env, req: Request, opts: RequireOpts = {}): Promise<Caller> {
  const token = bearerToken(req, opts.allowQueryToken === true);
  if (!token) throw new ApiError("unauthorized");
  const claims = await verifySupabaseJwt(env, token);
  const admin = adminClient(env);
  const ctx = await callerContext(admin, claims.sub);
  if (!ctx || ctx.phone_level === "none") {
    throw new ApiError("no_phone_access");
  }
  if (opts.needOn !== false && ctx.phone_status !== "on") throw new ApiError("phone_off");
  return { admin, claims, token, userId: claims.sub, ctx };
}

/** Signed in, nothing more (for /log, /devices/signout-all). The context may be null. */
export async function requireLogin(env: Env, req: Request): Promise<{ admin: Admin; claims: AuthClaims; token: string; userId: string; ctx: CallerContext | null }> {
  const token = bearerToken(req);
  if (!token) throw new ApiError("unauthorized");
  const claims = await verifySupabaseJwt(env, token);
  const admin = adminClient(env);
  const ctx = await callerContext(admin, claims.sub);
  return { admin, claims, token, userId: claims.sub, ctx };
}
