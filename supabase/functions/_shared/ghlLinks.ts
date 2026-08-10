/**
 * GHL hosted document links — the customer-facing estimate and invoice pages.
 *
 * GHL hosts a page for every estimate and invoice on the agency's white-label payments domain.
 * The URL shape is simply `/{estimate|invoice}/{documentId}` — the plain document _id is the
 * whole capability, no token, no signature. Verified live 2026-08-10 on the test location: the
 * estimate page renders working Accept/Reject buttons, and the invoice shape was confirmed via
 * a text2pay probe whose short link 301'd straight to `/invoice/{invoiceId}`. Before this
 * module every consumer would have rebuilt these strings by hand, and the two subtleties below
 * are exactly the kind that hand-built strings get wrong.
 *
 * ── THE HOST IS A DEFAULT, NOT A LAW ───────────────────────────────────────────────────────
 * `go.csmsynergy.com` is the CSM Synergy AGENCY's white-label payments domain ("FastPayDirect"
 * in GHL's settings), so it holds for every StructureStudio tenant — all locations sit under
 * this agency. But the payments domain is LOCATION-configurable in GHL, which is why every
 * builder here takes a `host` override instead of baking the constant into the string. If a
 * tenant ever moves off the agency domain, their override belongs on `client_settings` (the
 * service-role-only per-tenant settings row), threaded through as `host`. It never has to be
 * guessed: POST /invoices/text2pay returns an `invoiceUrl` on the location's configured
 * domain, so the right value is discoverable programmatically.
 *
 * ── THE 200-FOR-BOGUS-IDS CAVEAT ───────────────────────────────────────────────────────────
 * The hosted page is an SPA: it answers HTTP 200 even for a BOGUS document id and renders its
 * not-found state client-side. A validity probe must therefore never trust the status code —
 * it has to check the response HTML for the document's number (`pageLooksValid` below). A
 * probe written the obvious way (`res.ok`) would report every link valid forever.
 */

/**
 * Agency-level white-label payments domain, verified end-to-end 2026-08-10. Location-
 * configurable in GHL, so a per-tenant override goes on `client_settings` if a tenant ever
 * moves off it; discoverable programmatically via POST /invoices/text2pay (returns
 * `invoiceUrl` on whatever domain the location actually has configured).
 */
export const DEFAULT_PAYMENTS_HOST = "https://go.csmsynergy.com";

/**
 * Shared shape for both document kinds. Returns null rather than a broken link when there is
 * no id — the callers all render "no link" better than they render
 * "https://go.csmsynergy.com/estimate/undefined" in a customer's email.
 */
function docUrl(
  kind: "estimate" | "invoice",
  id: string | null | undefined,
  host?: string,
): string | null {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!trimmed) return null;
  // Trailing slashes stripped so a host stored with one (settings fields collect them) cannot
  // produce "https://host//estimate/…" — GHL's router treats that as a different path.
  const base = (host ?? DEFAULT_PAYMENTS_HOST).replace(/\/+$/, "");
  // encodeURIComponent, even though every id observed so far is clean hex: ids arrive from
  // API responses and webhook bodies we do not control, and an unencoded "../" or "?x=" in
  // one would rewrite the path of a link we put in front of a customer.
  return `${base}/${kind}/${encodeURIComponent(trimmed)}`;
}

/** The hosted estimate page (Accept/Reject live there). Null/empty/whitespace id → null. */
export function estimateUrl(
  estimateId: string | null | undefined,
  host?: string,
): string | null {
  return docUrl("estimate", estimateId, host);
}

/** The hosted invoice page (payment lives there). Null/empty/whitespace id → null. */
export function invoiceUrl(
  invoiceId: string | null | undefined,
  host?: string,
): string | null {
  return docUrl("invoice", invoiceId, host);
}

/**
 * The validity probe's judge: does this fetched page actually show the document?
 *
 * True iff the HTML contains the document's number (e.g. "EST-49"). This exists because the
 * status code CANNOT be the check — the SPA answers 200 for bogus ids and renders a
 * not-found state, so a 200 proves only that GHL's frontend is up. The document number is
 * the discriminator: it appears in the rendered payload for a real document and nowhere in
 * the not-found state.
 *
 * An empty/whitespace docNumber returns false rather than true-by-vacuity: "" is a substring
 * of every page, including the not-found one, which would make the probe pass on exactly the
 * pages it exists to catch.
 */
export function pageLooksValid(html: string, docNumber: string): boolean {
  const needle = typeof docNumber === "string" ? docNumber.trim() : "";
  if (!needle) return false;
  return typeof html === "string" && html.includes(needle);
}
