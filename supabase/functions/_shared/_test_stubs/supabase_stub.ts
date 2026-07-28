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
  };
}
