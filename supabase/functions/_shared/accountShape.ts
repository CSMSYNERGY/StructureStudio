// _shared/accountShape.ts — the PHONE-ONLY account (migration 384), server side.
//
// Carolyn, 2026-11-10: "So it'll say customer hub, but all they have access to is contacts. And then
// obviously if they want to do more, later they can." A phone-only account
// (client_settings.phone_only = true) has My Synergy Phone, the contact list with each contact's calls
// and texts, its phone settings, Business Details, Team, Billing and My Profile. Nothing else.
//
// THREE RULES LIVE HERE, and each has exactly one enforcer:
//
//   1. WHICH EDGE-FUNCTION ACTIONS a phone-only account may call at all. Enforced in
//      _shared/resolveTenant.ts: every function that resolves its tenant there passes its own
//      allow-list (`phoneOnly` option), and a function that passes none refuses a phone-only account
//      EVERY action. Deny by default, so a function or action added later is refused to them until
//      somebody decides otherwise — the posture GATES already has for unknown actions.
//
//   2. WHICH crm_* ACTIONS a phone-only account gets WITHOUT the Customer Hub subscription. Enforced in
//      portal-settings, beside its crm gate: the phone is what they pay for, and the contacts come
//      with it ("the phone in itself would just get them contacts ... and call logs", 2026-11-09).
//      Pipelines, forms, automations, templates, fields setup and the inbox stay the CRM's.
//
//   3. Nothing about MONEY. The phone-api Worker charges calls, texts and the number fee from the
//      wallet exactly as it does for every builder, and never reads this column. portal-billing lets a
//      phone-only account past the subscription gate (it pays by the wallet) and changes no price.
//
// The browser's half (the rail, the router, the Settings lists) is 01-core.jsx's SS_PHONE_ONLY_* and
// ssPhoneOnly; it decides what is OFFERED, and this file decides what is ALLOWED.
//
// ⚠️ The general per-company switchboard (research 2026-11-11) may turn this into one preset of a
// module map. Until then, keep the lists here and nowhere else.

// deno-lint-ignore no-explicit-any
type Admin = any;

/** portal-settings: the actions a phone-only account may call. Everything else 403s. */
export const PHONE_ONLY_SETTINGS_ACTIONS: ReadonlySet<string> = new Set([
  // The portal's first call, and the person's own account.
  "status", "save_prefs", "signature_upload_url", "get_profile", "save_profile",
  // My Synergy Phone's per-person helpers: saved quick sends, and the AI call-transcript switch.
  "quick_sends_list", "quick_send_used", "ai_transcripts_get", "ai_transcripts_save",
  // Business Details (Settings > Company): `save` writes named business fields only (never the
  // account's shape), and the logo.
  "save", "upload_logo",
  // The phone: Settings > Customer Hub > Phone, the number, caller ID, recording, and the Calls page.
  "phone_settings_get", "phone_calls_report", "phone_settings_save", "phone_recording_save",
  "phone_status_set", "phone_signout_user", "phone_search_numbers", "phone_buy_number",
  "phone_enable_number", "phone_number_texting", "phone_trust_setup", "phone_trust_status",
  "phone_trust_profile", "phone_port_request", "phone_adopt_number",
  // A contact's design history (read-only; a phone-only account has no designs, so it is empty).
  "contact_activity",
]);

/** The crm_* actions that make up a CONTACT: the record, its details, notes, follow-ups, files, tags,
 *  consent, and texting or emailing the person from it (the My Synergy Phone apps call
 *  crm_create_contact, crm_record_consent and crm_send_email too). A phone-only account gets these
 *  without the Customer Hub subscription; every other crm_* action stays the subscription's. */
export const PHONE_ONLY_CONTACT_ACTIONS: ReadonlySet<string> = new Set([
  "crm_record", "crm_feed", "crm_create_contact", "crm_save_contact", "crm_contact_custom_save",
  "crm_fields_list", "crm_save_note", "crm_delete_note", "crm_save_activity", "crm_complete_activity",
  "crm_contact_tag", "crm_contact_dnd", "crm_record_consent",
  "crm_file_sign", "crm_file_attach", "crm_file_delete",
  "crm_send_sms", "crm_send_email",
]);

/** Every portal-settings action a phone-only account may call: the list above plus the contact half. */
export const PHONE_ONLY_PORTAL_SETTINGS: ReadonlySet<string> = new Set([
  ...PHONE_ONLY_SETTINGS_ACTIONS, ...PHONE_ONLY_CONTACT_ACTIONS,
]);

/** The three account types an operator chooses between (admin-catalog create_client and
 *  set_account_type). "sheds": the whole product. "smartbuild": no shed designer (364). "phone":
 *  My Synergy Phone and the contact list only (384). */
export const ACCOUNT_TYPES: readonly string[] = ["sheds", "smartbuild", "phone"];

/** A client_settings row's account type. phone_only wins (a phone-only account sells no sheds
 *  either); then 364's sheds_enabled, read only as an explicit false. */
export function accountTypeOf(row: { sheds_enabled?: unknown; phone_only?: unknown } | null | undefined): string {
  if (row?.phone_only === true) return "phone";
  if (row?.sheds_enabled === false) return "smartbuild";
  return "sheds";
}

/** What a function passes to resolveTenant: "all" (every action is part of a phone-only account:
 *  portal-billing, portal-setup, portal-sms, support-agent) or a set of action names. Leaving it out
 *  refuses a phone-only account every action of that function. */
export type PhoneOnlyAllowed = "all" | ReadonlySet<string>;

/** The refusal a phone-only account gets for anything outside its allow-list. 403, so app_errors
 *  files it as a refusal (info), not a fault. */
export const PHONE_ONLY_REFUSAL =
  "This isn't part of your account. Your account has the phone and your contacts - ask Structure Studio to add more.";

/** Is `action` allowed for a phone-only account under `allowed`? Pure, for the tests. */
export function phoneOnlyAllows(allowed: PhoneOnlyAllowed | undefined, action: string): boolean {
  if (allowed === "all") return true;
  return !!allowed && allowed.has(action);
}

// ── Reading the flag ───────────────────────────────────────────────────────────────────────
// One indexed read per tenant, cached for CACHE_MS in the isolate: resolveTenant asks it on every
// call that is not on a phone-only allow-list (most of portal-settings' traffic), so an uncached read
// would add a round trip to nearly every portal call for every builder. An operator switching an
// account's shape therefore takes effect within CACHE_MS. Only a successful read is cached.
//
// FAILS TO "NOT PHONE-ONLY", and that is the safe direction for BOTH of this file's rules: a lost
// read refuses nothing (the account behaves as it did before 384) and grants nothing (the contact
// actions go back behind the subscription). Never invert it.
const CACHE_MS = 30_000;
const cache = new Map<string, { value: boolean; at: number }>();
// ONLY ON THE EDGE RUNTIME (Supabase defines the `EdgeRuntime` global; `deno test` does not). Every
// test file shares this module in one process, so a cache there would make a test's reads depend on
// which test ran first — a fake that counts client_settings reads would pass or fail by order. Off the
// runtime the flag is simply read every time.
const caching = typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== "undefined";

/** Tests only: forget every cached answer. */
export function phoneOnlyCacheClear(): void {
  cache.clear();
}

export async function phoneOnlyOf(admin: Admin, clientId: string): Promise<boolean> {
  const key = String(clientId || "");
  if (!key) return false;
  const hit = caching ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    const { data, error } = await admin.from("client_settings").select("phone_only")
      .eq("client_id", key).maybeSingle();
    if (error) throw error;
    const value = data?.phone_only === true;
    if (caching) cache.set(key, { value, at: Date.now() });
    return value;
  } catch (e) {
    console.warn("accountShape: phone_only read failed; treating the account as not phone-only:",
      (e as Error)?.message ?? String(e));
    return false;
  }
}
