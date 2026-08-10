// Test double for `jsr:@supabase/supabase-js@2`, wired in via import-map when running
// resolveTenant_test.ts. Only the surface resolveTenant actually touches is implemented:
// createClient(...).auth.getUser(). The ADMIN client is passed into resolveTenant by its
// caller, so the test hand-rolls that one directly (see makeAdmin in the test).

// deno-lint-ignore-file no-explicit-any

/** Set by the test to control what auth.getUser() returns for the next call. */
export const stubAuth: { user: any; error: any } = { user: null, error: null };

export function createClient(_url: string, _key: string, _opts?: any) {
  return {
    auth: {
      // deno-lint-ignore require-await
      getUser: async () => ({ data: { user: stubAuth.user }, error: stubAuth.error }),
    },
    // TYPE-ONLY surface: postmarkEvents_test.ts imports postmark-events/index.ts, which
    // pulls _shared/logError.ts into this import-mapped graph, and both call
    // createClient(...).from(...) — without this member the whole test file fails
    // type-checking with TS2339. No current test ever CALLS it (the .from chains live in
    // request handlers the tests never invoke), so it throws rather than pretending to be
    // a database: a future test that reaches it should fail loudly and implement a real
    // fake (the way makeAdmin does), not lean on a silent no-op.
    from: (_table: string): any => {
      throw new Error("supabase_stub createClient().from() is type-only — hand-roll a fake client for data paths (see makeAdmin in resolveTenant_test.ts)");
    },
  };
}
