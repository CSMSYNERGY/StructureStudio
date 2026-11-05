// THE UNSUBSCRIBE LINK in every automated email (migration 366, Carolyn 2026-11-05).
//
// A link that does nothing is worse than none — the law is about honouring the request, not
// showing the word — so it is SIGNED: a token over (client, contact) keyed off the service key,
// which only our functions hold. Nobody can unsubscribe a customer by guessing a URL, and nobody
// needs to log in to unsubscribe themselves.
//
// The key is DERIVED (HMAC of a fixed label under the service key) rather than the service key
// used directly, so a token on the wire says nothing about the key it was made with. Rotating the
// service key retires every old link — they answer "this link has expired" — which is the right
// way round for a key rotation.
//
// Self-contained (no jsr: imports): preflight runs `_shared/*.test.ts` offline.

const enc = new TextEncoder();

async function hmac(key: Uint8Array | string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw", (typeof key === "string" ? enc.encode(key) : key) as BufferSource,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The token for one customer of one builder. `secret` is the service key (tests pass a fixture). */
export async function unsubscribeToken(secret: string, clientId: string, contactId: string): Promise<string> {
  const derived = await hmac(secret, "ss-unsubscribe-v1");
  return b64url(await hmac(derived, `${clientId}\u0000${contactId}`)).slice(0, 32);
}

/** Constant-time: a wrong token takes as long to refuse as a nearly-right one. */
export async function unsubscribeTokenOk(secret: string, clientId: string, contactId: string, token: string): Promise<boolean> {
  const want = await unsubscribeToken(secret, clientId, contactId);
  if (typeof token !== "string" || token.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/** The link itself, on the public `unsubscribe` function. */
export async function unsubscribeUrl(supabaseUrl: string, secret: string, clientId: string, contactId: string): Promise<string> {
  const t = await unsubscribeToken(secret, clientId, contactId);
  const q = new URLSearchParams({ c: clientId, k: contactId, t });
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/unsubscribe?${q.toString()}`;
}
