/**
 * The customer quote-portal link (my-quotes.html) for a tenant.
 *
 * Where the SS-mode quote email's CTA points (migration 124): the customer signs in with a
 * texted code and can view, accept and SIGN the quote there. The GHL-mode email keeps
 * linking GHL's hosted estimate page instead — this helper is only ever called on the SS
 * path.
 *
 * HOST RULE: only `beta.` and `app.` structurestudiosuite.com exist in DNS (CLAUDE.md — the
 * bare apex has NO record, and per-tenant subdomains are a my-quotes RESOLVER feature, not
 * hostnames). So the link is built from the request's Origin when that origin is one of the
 * two real hosts — an estimate submitted from beta keeps its whole journey on beta — and
 * falls back to production for everything else (curl, n8n, a tenant's own embed page).
 * The tenant rides in `?client=`, which my-quotes.html's resolveTenant already reads.
 */

const KNOWN_HOSTS = new Set([
  "beta.structurestudiosuite.com",
  "app.structurestudiosuite.com",
]);
const CANONICAL_HOST = "app.structurestudiosuite.com";

export function myQuotesUrl(clientId: string, req?: Request | null): string {
  let host = CANONICAL_HOST;
  try {
    const origin = req?.headers?.get("origin") || "";
    if (origin) {
      const h = new URL(origin).hostname.toLowerCase();
      if (KNOWN_HOSTS.has(h)) host = h;
    }
  } catch { /* a malformed Origin header falls back to canonical */ }
  return `https://${host}/my-quotes?client=${encodeURIComponent(clientId)}`;
}
