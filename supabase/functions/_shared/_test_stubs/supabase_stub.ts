// Test double for `jsr:@supabase/supabase-js@2`, wired in via import-map when running
// resolveTenant_test.ts. Only the surface resolveTenant actually touches is implemented:
// createClient(...).auth.getUser(). The ADMIN client is passed into resolveTenant by its
// caller, so the test hand-rolls that one directly (see makeAdmin in the test).

// deno-lint-ignore-file no-explicit-any

/** Set by the test to control what auth.getUser() returns for the next call. */
export const stubAuth: { user: any; error: any } = { user: null, error: null };

/** The users auth.admin.getUserById() knows, by id (cofCharges_test: the owner lookup behind the
 *  wallet receipt and the add-a-card reminder). Empty by default: an id not here answers no user,
 *  which the lookups read as "no email on file". Reset it when the test is done. */
export const stubUsers: Record<string, { email: string }> = {};

/** Opt-in data surface for a test that drives a whole request handler
 *  (customerAuthSlots_test.ts): set `from` to a hand-rolled fake and every
 *  createClient(...).from(...) call goes to it. Left null, from() still throws, so no other
 *  test can lean on a database it never built. Reset it to null when the test is done. */
export const stubDb: { from: ((table: string) => any) | null } = { from: null };

/** The same opt-in for createClient(...).rpc(...), for a test that drives a handler which calls a
 *  database function (aiDraftStreamWiring_test.ts: calibrate_style_ai's wallet_hold / release /
 *  capture). Left null, rpc() throws, like from(). Reset it to null when the test is done. */
export const stubRpc: { rpc: ((fn: string, args?: any) => any) | null } = { rpc: null };

/** The same opt-in for createClient(...).storage.from(bucket), for a test that drives a handler
 *  which lists or removes objects (deleteDesignWiring_test.ts: delete_design's floor-plans step).
 *  Left null, storage.from() throws, like from(). Reset it to null when the test is done. */
export const stubStorage: { from: ((bucket: string) => any) | null } = { from: null };

/** PLANS AS DATA (migrations 386 to 388). Every handler that resolves its tenant now asks the
 *  database one more question, "is this company on the tab map?" (access_for_server, and
 *  access_for_portal from portal-billing's status). For every real company that is not named in the
 *  rollout switch the answer is null, and null changes nothing. So that is what this double answers
 *  by default, WITHOUT handing the call to stubRpc.rpc: the many tests that record or strictly fake
 *  their own rpc calls keep seeing exactly their own, and none of them has to learn a question that
 *  is not theirs. A test ABOUT the map sets `on` true, and the two calls then go to stubRpc.rpc like
 *  any other (and throw like any other when none is installed). Reset it to false when done. */
export const stubPlanRead: { on: boolean } = { on: false };
const PLAN_READS = new Set(["access_for_server", "access_for_portal"]);

export function createClient(_url: string, _key: string, _opts?: any) {
  return {
    auth: {
      // deno-lint-ignore require-await
      getUser: async () => ({ data: { user: stubAuth.user }, error: stubAuth.error }),
      admin: {
        // deno-lint-ignore require-await
        getUserById: async (id: string) => ({ data: { user: stubUsers[id] ? { id, email: stubUsers[id].email } : null }, error: null }),
      },
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
      if (PLAN_READS.has(_fn) && !stubPlanRead.on) return Promise.resolve({ data: null, error: null });
      if (stubRpc.rpc) return stubRpc.rpc(_fn, _args);
      throw new Error("supabase_stub createClient().rpc() has no fake installed — set stubRpc.rpc for the test that needs it");
    },
    storage: {
      from: (_bucket: string): any => {
        if (stubStorage.from) return stubStorage.from(_bucket);
        throw new Error("supabase_stub createClient().storage has no fake installed — set stubStorage.from for the test that needs it");
      },
    },
  };
}
