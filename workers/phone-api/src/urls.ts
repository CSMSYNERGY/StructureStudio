// Every URL the Worker hands Twilio: built from PUBLIC_BASE_URL, carrying ?key=.
//
// ⚠️ STRICT PERCENT-ENCODING, on purpose. Twilio signs the URL string exactly as we wrote it,
// while the Worker sees req.url after the WHATWG parser, which percent-encodes a few characters
// that encodeURIComponent leaves alone (an apostrophe in "Bob's Sheds", for one). A value that
// changes between the two fails the signature on a perfectly genuine request, so every value is
// encoded down to the unreserved set, where both sides agree byte for byte.

import { baseUrl, type Env } from "./env";

export function strictEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function hook(env: Env, path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${strictEncode(k)}=${strictEncode(String(v))}`);
  }
  parts.push(`key=${strictEncode(env.PHONE_WEBHOOK_SECRET ?? "")}`);
  return `${baseUrl(env)}${path}?${parts.join("&")}`;
}
