// Is this tenant OURS? (migration 169_internal_account)
//
// `client_settings.internal_account` already means exactly one thing — "this tenant IS US.
// Not a customer at all" — and 169's own header carries the warning "⚠️ NEVER set this on a
// customer tenant". This module is the second reader of that flag, and it exists so the
// answer is spelled the same way in both places rather than being re-derived from a slug.
//
// WHY NOT A HARDCODED 'structure-studio'. It would be a fourth copy of a fact the database
// already holds, and 169 speaks of internal "tenants", plural — a second one appearing must
// change behaviour, not silently disagree with a constant nobody re-reads. An env var is
// worse again: unset in one deploy it matches nothing, and the two functions that consult
// this ship separately, so a drift would split the roster with no error anywhere.
//
// Fails CLOSED, the same posture as featureCheck.ts's own read of this column: a read error
// throws to the caller's 5xx rather than being swallowed into "not internal, carry on".
// Both callers use the answer to decide whether a login may be handed cross-tenant reach,
// and "we could not tell" must never resolve to "go ahead".
export async function isInternalTenant(
  admin: {
    from: (t: string) => {
      // deno-lint-ignore no-explicit-any
      select: (c: string) => any;
    };
  },
  clientId: string,
): Promise<boolean> {
  if (!clientId) return false;
  const res = await admin.from("client_settings").select("internal_account")
    .eq("client_id", clientId).maybeSingle();
  if (res.error) throw new Error(`client_settings read failed: ${res.error.message}`);
  return res.data?.internal_account === true;
}

// The tenant a LOGIN belongs to, and whether it is ours.
//
// ⚠️ `clientId: null` is a real and supported answer, not a failure. `client_users.user_id`
// is the primary key, so a login belongs to at most one tenant — and a platform operator
// belongs to NONE. resolveTenant has always handled that case deliberately (there is a test
// pinning it), so every caller here must read "no row" as "not a tenant member", never as
// "refuse". Refusing would lock out exactly the cross-tenant operators this product runs on.
//
// `.limit(1)` rather than `.maybeSingle()`: a duplicate row is a data fault that should not
// turn into a hard lockout at the door — the same reasoning, and the same idiom, as
// resolveTenant's own read of this table.
export async function loginTenant(
  admin: {
    from: (t: string) => {
      // deno-lint-ignore no-explicit-any
      select: (c: string) => any;
    };
  },
  userId: string,
): Promise<{ clientId: string | null; internal: boolean }> {
  const res = await admin.from("client_users").select("client_id").eq("user_id", userId).limit(1);
  if (res.error) throw new Error(`client_users read failed: ${res.error.message}`);
  const clientId = (res.data && res.data[0] ? res.data[0].client_id : null) as string | null;
  if (!clientId) return { clientId: null, internal: false };
  return { clientId, internal: await isInternalTenant(admin, clientId) };
}
