// SSS Phone — "Save as contact" (portal-settings crm_create_contact) and the migration-254
// pieces behind it and behind "Sign out all devices".
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/
//
// The input rules run for real (phone.ts). The handler lives in index.ts, which calls
// Deno.serve at import, so its wiring is checked on the SHIPPED source between stable anchors,
// the portalPhone_test way; the SQL itself is exercised end to end by the PGlite harness
// (tests/sql/migration254.test.cjs) and by the migration's own PART 10/11. Fixtures are fake.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { DUPLICATE_PHONE_SENTENCE, parseCreateContact } from "../../supabase/functions/portal-settings/phone.ts";

// Line endings normalised: the working tree may hold CRLF (autocrlf), and the merge test below
// compares migration bodies line by line.
const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SRC = await read("../../supabase/functions/portal-settings/index.ts");
const MIG = await read("../../supabase/migrations/254_sss_phone.sql");
const MIG192 = await read("../../supabase/migrations/192_crm_merge_contacts.sql");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`crmCreateContact_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

// ── the input ──────────────────────────────────────────────────────────────────────────────
Deno.test("parseCreateContact takes the apps' exact body and stores a US number the CRM's way", () => {
  const r = parseCreateContact({ name: "  Pat   Example ", phone: "+15555550142", source: "phone" });
  assertEquals(r, { ok: true, name: "Pat Example", phone: "(555) 555-0142" });
  // source may be omitted; it is still a phone save.
  assertEquals(parseCreateContact({ name: "Pat", phone: "+15555550142" }), { ok: true, name: "Pat", phone: "(555) 555-0142" });
  // A non-NANP E.164 is kept as sent (crm_phone_key keys it by its digits).
  assertEquals(parseCreateContact({ name: "Pat", phone: "+442079460000" }), { ok: true, name: "Pat", phone: "+442079460000" });
  // A +1 number that is not a real NANP shape is not reformatted (no digit is ever dropped).
  assertEquals(parseCreateContact({ name: "Pat", phone: "+11555550142" }), { ok: true, name: "Pat", phone: "+11555550142" });
});

Deno.test("parseCreateContact refuses what the apps never send, each with a sentence", () => {
  const err = (b: Record<string, unknown>) => { const r = parseCreateContact(b); assert(!r.ok); return (r as { error: string }).error; };
  assert(/name/.test(err({ name: "   ", phone: "+15555550142" })));
  assert(/name/.test(err({ phone: "+15555550142" })));
  assert(/phone number/.test(err({ name: "Pat", phone: "(555) 555-0142" })), "only E.164, the SPEC's shape");
  assert(/phone number/.test(err({ name: "Pat", phone: "Anonymous" })));
  assert(/phone number/.test(err({ name: "Pat", phone: "" })));
  assert(/SSS Phone/.test(err({ name: "Pat", phone: "+15555550142", source: "design" })));
  assertEquals(parseCreateContact({ name: "x".repeat(250), phone: "+15555550142" }).ok && (parseCreateContact({ name: "x".repeat(250), phone: "+15555550142" }) as { name: string }).name.length, 200);
});

Deno.test("a duplicate number gets crm_save_contact's sentence, word for word", () => {
  const save = slice(SRC, 'if (action === "crm_save_contact") {', 'if (action === "contact_activity")', "crm_save_contact branch");
  assert(save.includes(`"${DUPLICATE_PHONE_SENTENCE}"`), "crm_save_contact's 23505 sentence and DUPLICATE_PHONE_SENTENCE have drifted apart");
});

// ── the handler's wiring ───────────────────────────────────────────────────────────────────
const BRANCH = slice(SRC, 'if (action === "crm_create_contact") {', "// ── Plan phase 6: a number for calls", "crm_create_contact branch");

Deno.test("crm_create_contact is gated like crm_save_contact and declared in CONTACT_ROW_SCOPE as a create", () => {
  assert(/\n\s*crm_create_contact:\s*\{\s*area:\s*"contacts",\s*level:\s*"edit"\s*\}/.test(SRC), "GATES.crm_create_contact should be contacts:edit");
  const scope = slice(SRC, "const CONTACT_ROW_SCOPE:", "\n  };", "CONTACT_ROW_SCOPE");
  assert(/\n\s{4}crm_create_contact:\s*\{\s*creates:\s*true\s*\}/.test(scope), "CONTACT_ROW_SCOPE must mark crm_create_contact `creates`");
  const refuse = slice(SRC, "const refuseUnlessOwnContactRow = async", "{ const bad = await refuseUnlessOwnContactRow()", "refuseUnlessOwnContactRow");
  assert(/if \(rule\.creates\) return null;/.test(refuse), "a `creates` rule must let the narrowed caller through (the branch owns the row for them)");
  // The crm_ prefix puts it behind the CRM subscription with every other crm_* action.
  assert(/const crmGated = action\.startsWith\("crm_"\)/.test(SRC));
});

Deno.test("a caller limited to their own customers becomes the owner; everyone else leaves it unassigned", () => {
  assert(/p_owner:\s*ownContacts \? me : null/.test(BRANCH), "the owner must be the caller exactly when ownContacts");
  assert(/p_source:\s*"phone"/.test(BRANCH));
  assert(/admin\.rpc\("crm_create_contact"/.test(BRANCH), "the create and the re-link are ONE database call");
  // The refusals (23505 → crm_save_contact's sentence, a missing function → a 503 refusal, …)
  // are mapped by phone.ts createContactRefusal, which phoneReview_test.ts drives.
  assert(/const refusal = createContactRefusal\(error\);/.test(BRANCH), "the branch maps its database errors through createContactRefusal");
  assert(/if \(!refusal\) return dbFail\(req, clientId, "save that contact", error\);/.test(BRANCH), "anything else is a fault");
  // Answers {ok, id} (and contactId, which both apps also accept).
  assert(/json\(\{ ok: true, id: out\.id, contactId: out\.id/.test(BRANCH));
});

Deno.test("the branch sits BELOW phoneRefused, so a database without 254 gets a sentence, not a TDZ throw", () => {
  const helper = SRC.indexOf("const phoneRefused = (");
  const branch = SRC.indexOf('if (action === "crm_create_contact") {');
  assert(helper > 0 && branch > helper, `phoneRefused at ${helper}, the branch at ${branch}`);
  assert(/refusal\.refusal \? phoneRefused\(refusal\.error, refusal\.status\)/.test(BRANCH));
});

// ── migration 254: the SQL behind it ───────────────────────────────────────────────────────
Deno.test("254 adds crm_create_contact: definer, service_role only, re-linking this tenant's unlinked rows", () => {
  const fn = slice(MIG, "create or replace function public.crm_create_contact(", "$fn$;", "crm_create_contact");
  assert(/security definer/.test(fn));
  assert(/public\.crm_phone_key\(v_phone\)/.test(fn), "phone_digits must be keyed like every other contact (132)");
  for (const t of ["phone_calls", "sms_messages"]) {
    const upd = slice(fn, `update public.${t}`, "get diagnostics", `${t} re-link`);
    assert(/client_id = p_client_id/.test(upd), `${t}: the re-link must stay inside the tenant`);
    assert(/contact_id is null/.test(upd), `${t}: only rows with no contact move`);
    assert(/public\.crm_phone_key\(case when \w\.direction = 'in'/.test(upd), `${t}: the customer side is chosen by direction`);
    // Review SSB-6: a saver limited to their own customers moves only what they were on.
    assert(/not v_narrowed/.test(upd), `${t}: a narrowed saver must not take a teammate's rows`);
  }
  // …and a call moves only if every team member on it can still see it afterwards
  // (tests/sql/migration254.test.cjs drives the two-reps case end to end).
  const calls = slice(fn, "update public.phone_calls", "get diagnostics", "phone_calls re-link");
  assert(/and not exists \(/.test(calls) && /area_level_for\(cu\.role, cu\.title, cu\.access, 'contacts'\) in \('view', 'edit'\)/.test(calls),
    "a call must not move away from a teammate who could not see the new contact");
  assert(/area_level_for\(cu\.role, cu\.title, cu\.access, 'contacts'\) not in \('view', 'edit'\)\s+into v_narrowed/.test(fn),
    "who counts as narrowed comes from the same resolver as the edge's ownContactsOnly");
  assert(/owner is not on this team/.test(fn), "the owner is checked against the tenant's team (188's rule)");
  assert(MIG.includes("revoke execute on function public.crm_create_contact(text, text, text, uuid, uuid, text) from public, anon, authenticated;"));
  assert(MIG.includes("grant  execute on function public.crm_create_contact(text, text, text, uuid, uuid, text) to service_role;"));
  assert(/check \(source in \('design', 'captured_lead', 'manual', 'import', 'phone'\)\)/.test(MIG), "crm_contacts.source must allow 'phone'");
});

Deno.test("254 re-issues crm_merge_contacts as 192's body plus phone_calls, nothing else", () => {
  const body = (src: string) => slice(src, "as $fn$", "$fn$;", "crm_merge_contacts body");
  const old = body(MIG192);
  const neu = body(slice(MIG, "create or replace function public.crm_merge_contacts(", "comment on function public.crm_merge_contacts", "254 merge"));
  const added = neu.split("\n").filter((l) => !old.split("\n").includes(l));
  assertEquals(added.filter((l) => l.trim() && !l.trim().startsWith("--")), [
    "  update public.phone_calls    set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;",
    "  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('calls', v_n);",
  ]);
  // …and nothing of 192's was lost.
  const removed = old.split("\n").filter((l) => !neu.split("\n").includes(l));
  assertEquals(removed, []);
  assert(/position\(\('update public\.' \|\| v_tbl\) in v_src\) = 0/.test(MIG), "PART 10 must assert the re-point at apply time");
});

Deno.test("254 adds phone_end_user_sessions (service_role only) and phone_signout_user calls it", () => {
  const fn = slice(MIG, "create or replace function public.phone_end_user_sessions(p_user_id uuid)", "$fn$;", "phone_end_user_sessions");
  assert(/returns integer/.test(fn) && /security definer/.test(fn));
  assert(/delete from auth\.sessions s where s\.user_id = p_user_id;/.test(fn), "it must delete ONLY that user's sessions");
  assert(MIG.includes("revoke execute on function public.phone_end_user_sessions(uuid) from public, anon, authenticated;"));
  assert(MIG.includes("grant  execute on function public.phone_end_user_sessions(uuid) to service_role;"));
  const signout = slice(SRC, 'if (action === "phone_signout_user") {', '// ── "Save as contact" (SSS Phone)', "phone_signout_user branch");
  assert(/admin\.rpc\("phone_end_user_sessions", \{ p_user_id: target \}\)/.test(signout));
  // Who may, and whether sessions end, is phone.ts signoutPlan (driven in phoneReview_test.ts);
  // the branch must ask it BEFORE anything changes and end sessions only when it says so.
  assert(/const plan = signoutPlan\(\{/.test(signout), "the branch asks signoutPlan");
  assert(signout.indexOf("signoutPlan(") < signout.indexOf("bumpDeviceGeneration("), "the refusal comes before the generation bump");
  assert(/if \(plan\.endSessions\) \{\s*const \{ data: ended, error: endErr \} = await admin\.rpc\("phone_end_user_sessions"/.test(signout),
    "sessions are ended only when the plan allows it (never a CSM Synergy operator's, unless the caller is one)");
  assert(/admin\.from\("app_operators"\)\.select\("user_id"\)\.eq\("user_id", target\)/.test(signout), "the target's operator status is read");
  assert(/targetIsOperator: targetOp\.is \|\| !!targetOp\.error/.test(signout), "an unreadable operator check keeps their sessions (fails closed)");
});

Deno.test("254's busy check lets go of a call its placer handed on", () => {
  const busy = slice(MIG, "'busy',", "'has_access',", "busy expression");
  const placed = slice(busy, "c.placed_by = m.user_id", "interval '4 hours' end)", "placed_by branch");
  assert(/and c\.transferred_from is null/.test(placed), "the placed_by branch must ignore a transferred call");
  const answered = slice(busy, "c.answered_by = m.user_id", "interval '4 hours' end)", "answered_by branch");
  assert(!/transferred_from/.test(answered), "the answered_by branch is unchanged");
});

Deno.test("254's busy check has the Worker's third clause: whoever is consulting in a warm transfer is busy (review SSB-8)", async () => {
  const busy = slice(MIG, "'busy',", "'has_access',", "busy expression");
  const conf = slice(busy, "c.transfer_state = 'conference'", "interval '4 hours' end)", "conference branch");
  assert(/and c\.transferred_from = m\.user_id/.test(conf), "the person who handed the call on, while it is in its conference");
  assert(/c\.status in \('ringing', 'in_progress'\)/.test(slice(busy, "DEVIATION 13", "interval '4 hours' end)", "conference branch head")),
    "the same liveness and staleness bound as the other two branches");
  // The rule it mirrors, byte for byte, so a change on either side fails here.
  const worker = await read("../../workers/phone-api/src/conference.ts");
  assert(worker.includes('(call.transfer_state === "conference" && call.transferred_from === userId)'),
    "the Worker's onTheCall changed; update 254's busy expression to match");
  assert(/phone_calls_live_conference_idx/.test(MIG), "the third branch has its own partial index (the 200 ms budget)");
});
