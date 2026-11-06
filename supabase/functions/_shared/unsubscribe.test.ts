// Unit tests for _shared/unsubscribe.ts (migration 366). Self-contained: no registry imports.
import { unsubscribeToken, unsubscribeTokenOk, unsubscribeUrl } from "./unsubscribe.ts";

function ok(v: boolean, msg: string) { if (!v) throw new Error(msg); }

const KEY = "fixture-not-a-real-key";
const C = "junior-barns";
const P = "11111111-2222-4333-8444-555555555555";
const Q = "22222222-3333-4444-8555-666666666666";

Deno.test("a link works for its own customer and nobody else's", async () => {
  const t = await unsubscribeToken(KEY, C, P);
  ok(t.length === 32, "token length");
  ok(await unsubscribeTokenOk(KEY, C, P, t), "its own customer");
  ok(!(await unsubscribeTokenOk(KEY, C, Q, t)), "another customer of the same builder");
  ok(!(await unsubscribeTokenOk(KEY, "other-builder", P, t)), "the same customer id under another builder");
  ok(!(await unsubscribeTokenOk("rotated-key", C, P, t)), "after the key is rotated");
  ok(!(await unsubscribeTokenOk(KEY, C, P, t.slice(0, 31))), "a truncated token");
  ok(!(await unsubscribeTokenOk(KEY, C, P, "")), "no token");
});

Deno.test("the URL carries the builder, the customer and the token, and nothing else", async () => {
  const u = new URL(await unsubscribeUrl("https://x.supabase.co/", KEY, C, P));
  ok(u.pathname === "/functions/v1/unsubscribe", u.pathname);
  ok(u.searchParams.get("c") === C && u.searchParams.get("k") === P, "ids");
  ok(await unsubscribeTokenOk(KEY, C, P, u.searchParams.get("t") ?? ""), "token round-trips");
  ok([...u.searchParams.keys()].length === 3, "no email address or name in the link");
});
