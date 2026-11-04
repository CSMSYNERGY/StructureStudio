// Which CRM user a builder's estimates go out as: client_settings.ghl_sender_user_id (migration 356).
//
// WHY THIS EXISTS. GoHighLevel picks an estimate email's route from the user it is sent as. A user
// with a connected mailbox (two-way Outlook sync) sends through that mailbox; a user with none sends
// through the location's own sending domain. Through the mailbox, an estimate carrying the floor plan
// PDF from our storage fails after GHL has already answered 201: "The email request is missing a
// required property". Measured 2026-11-04 on one live location, one send each, with the same file
// and the same fields: our storage URL failed, a copy in GHL's storage delivered, and a user with no
// mailbox delivered our storage URL through the sending domain. Left alone, submit-estimate borrows
// products[0].createdBy, so a builder's quote emails stop arriving the day that person connects a
// mailbox, with nothing changing here and nothing in app_errors.
//
// A PIN ONLY HELPS WHILE THAT USER HAS NO MAILBOX. Nothing here can tell: the builder's API key read
// `twoWaySync.outlook` as absent for a user who has one (2026-11-04), so check from a signed-in GHL
// session before pinning. If the pinned user connects a mailbox later, the silent failure comes back.
//
// THE READ NEVER FAILS ITS CALLER. It sits on the path that issues a quote, so a missing row, a read
// error or a function deployed ahead of 356 (PostgREST answers the unknown column with 42703 /
// PGRST204) all mean "no pin", which is what every quote did before 356. Its own small read rather
// than a column in submit-estimate's settings select, for the reason quoteValidity.ts gives: naming
// a new column there would fail EVERY quote if the function were deployed first.
//
// Deliberately dependency-free (no jsr:/npm: imports): ghlSender.test.ts runs in the self-contained
// _shared group.

const GHL = "https://services.leadconnectorhq.com";

/** The stored id, trimmed, or "" for no setting and for anything that stopped us reading one. */
export async function readGhlSenderPin(
  // deno-lint-ignore no-explicit-any
  db: any,
  clientId: string,
): Promise<string> {
  try {
    const { data, error } = await db.from("client_settings")
      .select("ghl_sender_user_id").eq("client_id", clientId).maybeSingle();
    if (error) return "";
    const v = data?.ghl_sender_user_id;
    return typeof v === "string" ? v.trim() : "";
  } catch (_e) {
    return "";
  }
}

/**
 * The pin, once GHL has confirmed it still lists that user. A pin it no longer lists could refuse
 * the whole estimate, so `stale` tells the caller to go without it and say so. A list we could not
 * get says nothing about the user, so a CRM hiccup keeps the pin: it must not change who a quote
 * goes out as, which is the one thing a pin promises.
 */
export async function resolveGhlSenderPin(
  // deno-lint-ignore no-explicit-any
  db: any,
  clientId: string,
  locationId: string,
  headers: Record<string, string>,
): Promise<{ userId: string; stale: boolean }> {
  const pin = await readGhlSenderPin(db, clientId);
  if (!pin) return { userId: "", stale: false };
  try {
    const r = await fetch(`${GHL}/users/?locationId=${encodeURIComponent(locationId)}`, { headers });
    if (!r.ok) return { userId: pin, stale: false };
    const d = await r.json();
    // deno-lint-ignore no-explicit-any
    const users: any[] = Array.isArray(d?.users) ? d.users : [];
    if (users.length === 0) return { userId: pin, stale: false };
    return users.some((u) => (u?.id || u?._id) === pin) ? { userId: pin, stale: false } : { userId: "", stale: true };
  } catch (_e) {
    return { userId: pin, stale: false };
  }
}
