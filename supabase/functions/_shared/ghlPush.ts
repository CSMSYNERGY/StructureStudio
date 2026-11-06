// "Push the customer to GoHighLevel", an automation action (migration 370). The tick
// (crm-rules-tick) is the only caller; it reads the builder's saved location and key and hands them
// in, so this file never touches the database.
//
// Two calls, not one: /contacts/upsert with who they are (no tags in it), then /contacts/{id}/tags
// to ADD the rule's tags. capture-lead and lead-form put tags in the upsert body, but those make
// new leads; a rule usually pushes someone GoHighLevel already knows, and its tag belongs beside
// the ones they carry. The tags call adds; it never replaces.
//
// ⚠️ CHECK WHO CAME BACK (capture-lead's guard, for the same reason): /contacts/upsert matches on
// phone OR email and does not say which. A returned contact whose phone and email both belong to
// somebody else is a different person, and the rule's tags must not land on them; the run log says
// why. The upsert itself has happened by then. That is GoHighLevel's matching, the same for every
// upsert this product already makes.
//
// Pure apart from the fetch it is handed, so ghlPush.test.ts runs offline. Never an address, a
// phone number or the key in a message.

export const GHL_API = "https://services.leadconnectorhq.com";
const GHL_TIMEOUT_MS = 10_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type GhlPushIn = {
  locationId: string; apiKey: string;
  contact: { name: string | null; email: string | null; phone: string | null; company: string | null };
  tags: string[];
};
export type GhlPushOut =
  | { ok: true; contactId: string; tagged: number }
  | { ok: false; code: "no_identity" | "auth" | "refused" | "busy" | "mismatch"; status: number | null; retry: boolean; error: string };

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const tenDigits = (v: unknown) => {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};

function refusal(st: number | null, what: string): GhlPushOut {
  if (st === 401 || st === 403) {
    return { ok: false, code: "auth", status: st, retry: false, error: "GoHighLevel refused your saved key. Re-save it under Settings → GHL Connection." };
  }
  if (st === null || st === 429 || st >= 500) {
    return { ok: false, code: "busy", status: st, retry: true, error: `GoHighLevel was busy or down${st ? ` (HTTP ${st})` : ""} ${what}.` };
  }
  return { ok: false, code: "refused", status: st, retry: false, error: `GoHighLevel refused it (HTTP ${st}) ${what}.` };
}

export async function pushContactToGhl(fetchFn: FetchFn, i: GhlPushIn): Promise<GhlPushOut> {
  const name = String(i.contact.name ?? "").trim();
  const email = String(i.contact.email ?? "").trim();
  const phone = String(i.contact.phone ?? "").trim();
  const ours = tenDigits(phone);
  const hasPhone = ours.length === 10;
  const hasEmail = EMAIL.test(email);
  if (!hasPhone && !hasEmail) {
    return { ok: false, code: "no_identity", status: null, retry: false, error: "That customer has no email address or phone number to find them by." };
  }
  const parts = name.split(/\s+/).filter(Boolean);
  const headers = {
    "Version": "2021-07-28",
    "Authorization": `Bearer ${i.apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  const call = async (path: string, body: unknown): Promise<Response | null> => {
    try {
      return await fetchFn(`${GHL_API}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(GHL_TIMEOUT_MS) });
    } catch {
      return null;
    }
  };

  const up = await call("/contacts/upsert", {
    locationId: i.locationId,
    ...(name ? { name } : {}),
    ...(parts.length ? { firstName: parts[0] } : {}),
    ...(parts.length > 1 ? { lastName: parts.slice(1).join(" ") } : {}),
    ...(hasEmail ? { email } : {}),
    ...(hasPhone ? { phone } : {}),
    ...(i.contact.company ? { companyName: String(i.contact.company).trim() } : {}),
    source: "StructureStudio automation",
  });
  if (!up || !up.ok) {
    try { await up?.body?.cancel(); } catch { /* nothing to free */ }
    return refusal(up ? up.status : null, "saving the customer");
  }
  const d = await up.json().catch(() => null) as { contact?: { id?: string; phone?: string; email?: string } } | null;
  const id = d?.contact?.id ? String(d.contact.id) : "";
  if (!id) return { ok: false, code: "refused", status: up.status, retry: false, error: "GoHighLevel did not say which contact it saved." };

  const theirs = tenDigits(d?.contact?.phone);
  const theirEmail = String(d?.contact?.email ?? "").trim().toLowerCase();
  const phoneSame = hasPhone && theirs === ours;
  const emailSame = hasEmail && theirEmail === email.toLowerCase();
  const phoneClash = hasPhone && theirs.length === 10 && !phoneSame;
  const emailClash = hasEmail && !!theirEmail && !emailSame;
  if ((phoneClash && !emailSame) || (emailClash && !phoneSame)) {
    return { ok: false, code: "mismatch", status: up.status, retry: false,
      error: "GoHighLevel matched this customer to a different person, so the tags were not added. Check that contact in GoHighLevel." };
  }

  if (i.tags.length) {
    const tg = await call(`/contacts/${encodeURIComponent(id)}/tags`, { tags: i.tags });
    try { await tg?.body?.cancel(); } catch { /* nothing to free */ }
    if (!tg || !tg.ok) return refusal(tg ? tg.status : null, "adding the tags (the customer itself was saved)");
  }
  return { ok: true, contactId: id, tagged: i.tags.length };
}
