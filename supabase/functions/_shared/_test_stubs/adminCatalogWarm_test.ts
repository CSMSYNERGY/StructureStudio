// admin-catalog's ?warm=1 must answer BEFORE the admin gate. Below it, an anon-key ping with no
// password is a FAILED ADMIN PASSWORD: an admin_auth_attempts failure on the caller's IP bucket,
// an admin_auth_failed audit row, a count toward the global brake. The portal pings this function
// (operator warm-up, hover on the Admin link), so a refactor that moved the gate above the warm
// check would quietly lock operators out of break-glass. Same read-the-source technique as
// taxCodesWiring_test.ts.

import { assert } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);
/** Source with whole-line comments removed, so a comment that NAMES a call cannot satisfy it.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (s: string) => s.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
const SRC = code(await Deno.readTextFile(new URL("admin-catalog/index.ts", FUNCTIONS)));

Deno.test("admin-catalog ?warm=1 answers before the body, the client and the admin gate", () => {
  const serve = SRC.indexOf('Deno.serve(withErrorLog("admin-catalog"');
  const at = (needle: string) => SRC.indexOf(needle, serve);
  const opts = at('req.method === "OPTIONS"');
  const warm = at('searchParams.get("warm") === "1"');
  assert(serve >= 0 && opts > serve && warm > opts, "warm check missing, or above OPTIONS");
  for (const later of ["await req.json()", "createClient(", "checkAdminAuth(req"]) {
    const i = at(later);
    assert(i > warm, `${later} now runs before the warm check (or is gone)`);
  }
});
