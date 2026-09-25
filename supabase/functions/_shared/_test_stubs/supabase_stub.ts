// Test double for `jsr:@supabase/supabase-js@2`, wired in via import-map when running
// resolveTenant_test.ts. Only the surface resolveTenant actually touches is implemented:
// createClient(...).auth.getUser(). The ADMIN client is passed into resolveTenant by its
// caller, so the test hand-rolls that one directly (see makeAdmin in the test).

// deno-lint-ignore-file no-explicit-any

/** Set by the test to control what auth.getUser() returns for the next call. */
export const stubAuth: { user: any; error: any } = { user: null, error: null };

/** Opt-in data surface for a test that drives a whole request handler
 *  (customerAuthSlots_test.ts): set `from` to a hand-rolled fake and every
 *  createClient(...).from(...) call goes to it. Left null, from() still throws, so no other
 *  test can lean on a database it never built. Reset it to null when the test is done. */
export const stubDb: { from: ((table: string) => any) | null } = { from: null };

/** The same opt-in for createClient(...).rpc(...), for a test that drives a handler which calls a
 *  database function (aiDraftStreamWiring_test.ts: calibrate_style_ai's wallet_hold / release /
 *  capture). Left null, rpc() throws, like from(). Reset it to null when the test is done. */
export const stubRpc: { rpc: ((fn: string, args?: any) => any) | null } = { rpc: null };

export function createClient(_url: string, _key: string, _opts?: any) {
  return {
    auth: {
      // deno-lint-ignore require-await
      getUser: async () => ({ data: { user: stubAuth.user }, error: stubAuth.error }),
    },
    // TYPE-ONLY surface: postmarkEvents_test.ts imports postmark-events/index.ts, which
    // pulls _shared/logError.ts into this import-mapped graph, and both call
    // createClient(...).from(...) — without this member the whole test file fails
    // type-checking with TS2339. Unless a test installs its own fake through stubDb above,
    // it throws rather than pretending to be a database: a test that reaches it should fail
    // loudly and implement a real fake (the way makeAdmin does), not lean on a silent no-op.
    from: (_table: string): any => {
      if (stubDb.from) return stubDb.from(_table);
      throw new Error("supabase_stub createClient().from() is type-only — hand-roll a fake client for data paths (see makeAdmin in resolveTenant_test.ts)");
    },
    rpc: (_fn: string, _args?: any): any => {
      if (stubRpc.rpc) return stubRpc.rpc(_fn, _args);
      throw new Error("supabase_stub createClient().rpc() has no fake installed — set stubRpc.rpc for the test that needs it");
    },
  };
}
