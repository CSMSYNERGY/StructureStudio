// My Synergy Phone with more than one number (migration 266, Carolyn 09-30): a name and a person
// for each number, every setting per number, up to ten numbers, a reply from the number the
// customer used, and the apps' list of business numbers.
//
//   * phone.ts: pickNumber, parseNumberLabel, parseAssignee, carriesRoute, suggestedMembersFor,
//     callerNumberFor (the Phone tab's copy of phone_caller_context's pick);
//   * phoneNumber.ts: attachToTexting (a later number joins texting), in order, each step's stop;
//   * the handlers' wiring in portal-settings/index.ts, read from the SHIPPED source;
//   * the Phone tab's pieces in portal/11-sms.jsx (phoneNumbersOf and friends, evaluated);
//   * the Worker's reading of the RPC's `numbers`, and where the reply number is asked.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
//
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE. Fixtures are fake (555-01xx, PN00…, MG00…), per the
// public-repo rule.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  callerNumberFor, carriesRoute, MAX_NUMBERS, NUMBER_GONE, NUMBER_LABEL_MAX, ONE_NUMBER_PER_PERSON, parseAssignee, parseNumberLabel,
  pickNumber, ROUTE_KEYS, suggestedMembersFor,
} from "../../supabase/functions/portal-settings/phone.ts";
import { attachToTexting, TEXTING_JOIN_FAILED } from "../../supabase/functions/portal-settings/phoneNumber.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SRC = await read("../../supabase/functions/portal-settings/index.ts");
const SMS = await read("../../portal/11-sms.jsx");
const MIG = await read("../../supabase/migrations/266_phone_numbers.sql");
const WORKER_DB = await read("../../workers/phone-api/src/db.ts");
const WORKER_SMS = await read("../../workers/phone-api/src/routes/sms.ts");
const WORKER_TOKEN = await read("../../workers/phone-api/src/routes/token.ts");
const SUBMIT = await read("../../supabase/functions/submit-estimate/index.ts");
const EVENTS = await read("../../supabase/functions/twilio-events/index.ts");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`phoneNumbers_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const N1 = "00000000-0000-4000-8000-00000000a001";
const N2 = "00000000-0000-4000-8000-00000000a002";
const OWNER = "00000000-0000-4000-8000-000000000001";
const REP = "00000000-0000-4000-8000-000000000002";
const CREW = "00000000-0000-4000-8000-000000000003";

// ── which number a request is about ────────────────────────────────────────────────────────
Deno.test("pickNumber: no numberId = the first (an older portal bundle); a given one must be live and ours", () => {
  const rows = [{ id: N1 }, { id: N2 }];
  assertEquals(pickNumber(rows, undefined), { ok: true, n: rows[0] });
  assertEquals(pickNumber(rows, null), { ok: true, n: rows[0] });
  assertEquals(pickNumber(rows, ""), { ok: true, n: rows[0] });
  assertEquals(pickNumber(rows, N2), { ok: true, n: rows[1] });
  assertEquals(pickNumber(rows, N2.toUpperCase()), { ok: true, n: rows[1] }, "ids compare without case");
  assertEquals(pickNumber([], undefined), { ok: true, n: null });
  // Released meanwhile, another tenant's, or junk: refused, NEVER quietly read as the first.
  assertEquals(pickNumber(rows, "00000000-0000-4000-8000-00000000a009"), { ok: false, error: NUMBER_GONE });
  assertEquals(pickNumber(rows, "a001"), { ok: false, error: NUMBER_GONE });
  assertEquals(pickNumber(rows, 7), { ok: false, error: NUMBER_GONE });
});

Deno.test("parseNumberLabel: spaces tidied, empty = no name, 1 to 40 characters, no control characters", () => {
  assertEquals(parseNumberLabel("  Sales   line "), { ok: true, value: "Sales line" });
  assertEquals(parseNumberLabel(""), { ok: true, value: null });
  assertEquals(parseNumberLabel("   "), { ok: true, value: null });
  assertEquals(parseNumberLabel(null), { ok: true, value: null });
  assertEquals(parseNumberLabel("x".repeat(NUMBER_LABEL_MAX)), { ok: true, value: "x".repeat(40) });
  assertEquals(parseNumberLabel("x".repeat(41)).ok, false);
  assertEquals(parseNumberLabel("Bad\u0007name").ok, false);
  assertEquals(parseNumberLabel(42).ok, false);
  // The database's own check is the same 1 to 40 (so an empty string can never stand for "no name").
  assert(MIG.includes("check (label is null or char_length(label) between 1 and 40) not valid"));
});

Deno.test("parseAssignee: a team line, or someone on THIS team with phone access; the refusal names them", () => {
  const eligible = new Set([OWNER, REP]);
  const names = new Map<string, string | null>([[CREW, "Casey Crew"]]);
  assertEquals(parseAssignee("", eligible), { ok: true, value: null });
  assertEquals(parseAssignee(null, eligible), { ok: true, value: null });
  assertEquals(parseAssignee(REP.toUpperCase(), eligible), { ok: true, value: REP });
  const crew = parseAssignee(CREW, eligible, names);
  assert(!crew.ok && crew.error.startsWith("Casey Crew doesn't have Phone access"));
  const stranger = parseAssignee("00000000-0000-4000-8000-0000000000ff", eligible, names);
  assert(!stranger.ok && /isn't on your team/.test(stranger.error));
  assertEquals(parseAssignee("rep", eligible).ok, false);
  assertEquals(ONE_NUMBER_PER_PERSON.startsWith("That person already has their own number"), true);
});

Deno.test("carriesRoute: a save of only a name or a person changes no answer list", () => {
  assertEquals(carriesRoute({ label: "Sales line" }), false);
  assertEquals(carriesRoute({ assignedUserId: REP, numberId: N2 }), false);
  for (const k of ROUTE_KEYS) assertEquals(carriesRoute({ [k]: null }), true, k);
  assertEquals(carriesRoute({}), false);
});

Deno.test("suggestedMembersFor: a person's own number starts with just them; a team line with the owners", () => {
  const team = [
    { userId: OWNER, role: "owner", phoneLevel: "edit" },
    { userId: REP, role: "user", phoneLevel: "own" },
    { userId: CREW, role: "user", phoneLevel: "none" },
  ];
  assertEquals(suggestedMembersFor(REP, team), [REP]);
  assertEquals(suggestedMembersFor(null, team), [OWNER]);
  assertEquals(suggestedMembersFor(CREW, team), [OWNER], "someone without phone access can't be rung: the owners");
  assertEquals(suggestedMembersFor("00000000-0000-4000-8000-0000000000ff", team), [OWNER], "someone who left: the owners");
});

Deno.test("callerNumberFor is phone_caller_context's pick: own number, then a team line (texting first), then the oldest", () => {
  const rows = [
    { id: "a", phone_number: "+15555550100", assigned_user_id: REP },   // oldest, Rex's
    { id: "b", phone_number: "+15555550101", assigned_user_id: null },  // team
    { id: "c", phone_number: "+15555550102", assigned_user_id: null },  // team, texting
  ];
  assertEquals(callerNumberFor(rows, REP, "+15555550102")?.id, "a", "their own, whatever else there is");
  assertEquals(callerNumberFor(rows, OWNER, "+15555550102")?.id, "c", "no own number: the texting team line");
  assertEquals(callerNumberFor(rows, OWNER, null)?.id, "b", "no texting number: the oldest TEAM line, never Rex's");
  assertEquals(callerNumberFor([rows[0]], OWNER, null)?.id, "a", "only someone else's: still a caller ID");
  assertEquals(callerNumberFor([], OWNER, null), null);
  // The SQL says the same, in the same order (the PGlite test drives it).
  const order = slice(MIG, "order by coalesce(n.assigned_user_id = cu.user_id, false) desc,", "limit 1),", "the pick");
  assert(order.indexOf("(n.assigned_user_id is null) desc") < order.indexOf("(n.phone_number = cs.sms_number) desc nulls last"));
  assert(order.indexOf("(n.phone_number = cs.sms_number) desc nulls last") < order.indexOf("n.purchased_at asc"));
});

// ── a later number joins texting ───────────────────────────────────────────────────────────
const PN = "PN" + "0".repeat(31) + "1";
const MG = "MG" + "0".repeat(32);
function joinWorld(o: { there?: boolean; fail?: "check" | "attach" | "clear_sms_url" | "record" } = {}) {
  const log: string[] = [];
  const boom = () => Promise.reject(new Error("Twilio 503"));
  return {
    log,
    deps: {
      inService: (svc: string, sid: string) => { log.push(`check:${svc.slice(0, 2)}:${sid.slice(0, 2)}`); return o.fail === "check" ? boom() : Promise.resolve(!!o.there); },
      attach: (svc: string, sid: string) => { log.push(`attach:${svc.slice(0, 2)}:${sid.slice(0, 2)}`); return o.fail === "attach" ? boom() : Promise.resolve(); },
      clearSmsUrl: (sid: string) => { log.push(`clear:${sid.slice(0, 2)}`); return o.fail === "clear_sms_url" ? boom() : Promise.resolve(); },
      record: (p: { messaging_service_sid: string; twilio_sid: string }) => {
        log.push(`record:${p.messaging_service_sid.slice(0, 2)}:${p.twilio_sid.slice(0, 2)}`);
        return Promise.resolve(o.fail === "record" ? { error: { code: "57014" } } : { error: null });
      },
    },
  };
}

Deno.test("attachToTexting: into the service, its own SmsUrl cleared, and the row's messaging_service_sid written LAST", async () => {
  const w = joinWorld();
  assertEquals(await attachToTexting({ serviceSid: MG, numberSid: PN }, w.deps), { ok: true, attached: true });
  assertEquals(w.log, ["check:MG:PN", "attach:MG:PN", "clear:PN", "record:MG:PN"]);
  // A retry after Twilio acted and we didn't record it: not attached twice.
  const again = joinWorld({ there: true });
  assertEquals(await attachToTexting({ serviceSid: MG, numberSid: PN }, again.deps), { ok: true, attached: false });
  assertEquals(again.log, ["check:MG:PN", "clear:PN", "record:MG:PN"]);
});

Deno.test("attachToTexting: a stop anywhere is reported by step, and nothing after it runs (the row stays calling-only)", async () => {
  for (const step of ["check", "attach", "clear_sms_url", "record"] as const) {
    const w = joinWorld({ fail: step });
    const out = await attachToTexting({ serviceSid: MG, numberSid: PN }, w.deps);
    assertEquals(!out.ok && out.step, step);
    if (step !== "record") assert(!w.log.some((l) => l.startsWith("record:")), `${step}: the row is not marked`);
  }
  const bad = joinWorld();
  assertEquals((await attachToTexting({ serviceSid: "MGnope", numberSid: PN }, bad.deps) as { step: string }).step, "sid");
  assertEquals(bad.log, [], "nothing is asked of Twilio with a bad sid");
  assert(/Use this number for texting too/.test(TEXTING_JOIN_FAILED), "the warning names the button that retries it");
});

// ── portal-settings wiring ─────────────────────────────────────────────────────────────────
Deno.test("every number action reads the tenant's LIVE numbers, oldest first, and picks by numberId", () => {
  const rows = slice(SRC, "const phoneNumberRows = async ()", "\n  };\n", "phoneNumberRows");
  assert(/\.eq\("client_id", clientId\)\.is\("released_at", null\)\s*\.order\("purchased_at", \{ ascending: true \}\)\.order\("id", \{ ascending: true \}\)/.test(rows));
  assert(/res\.error && String\(\(res\.error as \{ code\?: string \}\)\.code \?\? ""\) === "42703"/.test(rows), "before 266: read again without the new columns");
  assert(!SRC.includes("phoneNumberRow()"), "no single-number read is left");
  for (const a of ["phone_settings_save", "phone_enable_number", "phone_number_texting"]) {
    const b = slice(SRC, `if (action === "${a}") {`, "\n  }\n", a);
    assert(/const picked = pickNumber\(numRes\.data \?\? \[\], payload\?\.numberId\);\s*if \(!picked\.ok\) return json\(\{ error: picked\.error \}, 409\);/.test(b), `${a} picks by numberId`);
  }
  for (const a of ["phone_trust_setup", "phone_trust_status"]) {
    const b = slice(SRC, `if (action === "${a}") {`, a === "phone_trust_setup" ? 'if (action === "phone_trust_status") {' : "// ── The Calls report", a);
    assert(/const picked = pickNumber\(numRes\.data \?\? \[\], payload\?\.numberId\);/.test(b), `${a} picks by numberId`);
    assert(b.indexOf("phoneOperatorGate()") < b.indexOf("pickNumber("), `${a}: the operator gate still comes first`);
  }
  const status = slice(SRC, 'if (action === "phone_status_set") {', "\n  }\n", "phone_status_set");
  assert(/readNumbers: async \(\) => \{\s*const numRes = await phoneNumberRows\(\);/.test(status), "the switch moves every number");
  assert(/numbers: out\.numbers/.test(status));
});

Deno.test("phone_settings_save: the number's own row first (23505 in words), then the route only when the save carries it", () => {
  const b = slice(SRC, 'if (action === "phone_settings_save") {', "\n  }\n", "phone_settings_save");
  assert(/if \(\(hasLabel \|\| hasAssignee\) && !numRes\.perNumber\) \{\s*return phoneUnavailable\(/.test(b), "a database before 266 can't take names or people");
  assert(/: parseAssignee\(p\.assignedUserId, eligible, names\);/.test(b) && /const eligible = new Set\(teamOut\.team\.filter\(\(t\) => t\.phoneLevel !== "none"\)/.test(b));
  assert(/const unchanged = typeof p\.assignedUserId === "string" && !!wasAssigned && p\.assignedUserId\.toLowerCase\(\) === wasAssigned;/.test(b),
    "leaving a stale person as they are doesn't block saving the rest");
  assert(/if \(label !== wasLabel \|\| assignedUserId !== wasAssigned\) \{\s*audit\("phone_number_saved"/.test(b), "audited only when the name or the person changed");
  assert(/\.update\(patch\)\s*\.eq\("id", n\.id\)\.eq\("client_id", clientId\)\.is\("released_at", null\)/.test(b), "only this tenant's live row");
  assert(/=== "23505"\) return json\(\{ error: ONE_NUMBER_PER_PERSON \}, 409\);/.test(b));
  assert(b.indexOf(".update(patch)") < b.indexOf('admin.from("phone_routes")'), "a refused person changes no route");
  assert(/const withRoute = carriesRoute\(p\);\s*const parsed = withRoute \? parseRoute\(p, eligible, names\) : null;/.test(b));
  assert(/if \(!saved && newlyAssigned && assignedUserId\) \{\s*const first = parseRoute\(\{ members: \[assignedUserId\] \}, eligible, names\);/.test(b),
    "a number newly given to someone, with no route, rings them");
  assert(/upsert\(\{ client_id: clientId, number_id: n\.id,/.test(b), "the route is the PICKED number's");
  assert(/return json\(\{ ok: true, numberId: n\.id, label, assignedUserId, route: routeOut\(saved\) \}\);/.test(b));
});

Deno.test("phone_settings_get: every number with its own route, caller ID and person; the first stays `number`", () => {
  const get = slice(SRC, 'if (action === "phone_settings_get") {', 'if (action === "phone_settings_save") {', "phone_settings_get");
  assert(/\.from\("phone_routes"\)\s*\.select\("number_id, mode,[^"]*"\)\s*\.eq\("client_id", clientId\)\.in\("number_id", rows\.map\(\(r\) => r\.id\)\)/.test(get), "one read of every route, on this tenant");
  assert(/number: n \? numberOut\(n\) : null,/.test(get), "the FIRST number, for an older portal bundle");
  for (const k of ["label: r.label ?? null,", "assignedUserId: r.assigned_user_id ? String(r.assigned_user_id).toLowerCase() : null,", "callerId: callerIdOf(String(r.id)),", "route: rt,",
    "suggestedMembers: rt ? null : suggestedMembersFor(r.assigned_user_id ?? null, team),", "perNumber: numRes.perNumber,",
    "maxNumbers: numRes.perNumber ? MAX_NUMBERS : 1,", "canJoinTexting: rolloutOpen && mayBuyPhoneNumber(),"]) {
    assert(get.includes(k), `phone_settings_get: ${k}`);
  }
  assert(/const mine = callerNumberFor\(rows, userId,/.test(get), "an own-level caller is told the number THEIR calls show");
  assertEquals(MAX_NUMBERS, 10);
});

Deno.test("phone_buy_number: up to MAX_NUMBERS, the tenant's own numbers never adopted, texting joined after recording", () => {
  const buy = slice(SRC, 'if (action === "phone_buy_number") {', "// ── Migration 266: a calling-only number joins texting", "phone_buy_number");
  assert(buy.indexOf("if (!mayBuyPhoneNumber())") < buy.indexOf("phoneNumberRows()"), "who may buy is still checked first");
  assert(/recorded: liveRows\.map\(\(r\) => String\(r\.phone_number\)\)/.test(buy));
  // Before 266 (no names, no owners, the RPC's caller ID still the NEWEST number): still one.
  assert(/if \(!live\.perNumber && liveRows\.length >= 1\) \{\s*return json\(\{ error: "This account already has a number\. Connect it for calls instead of buying another\." \}, 409\);/.test(buy),
    "one number on a database before 266, with the old refusal");
  assert(buy.indexOf("!live.perNumber && liveRows.length >= 1") < buy.indexOf("buyCallingNumber("), "refused before anything is bought");
  assert(buy.indexOf("textingServiceSid()") > buy.indexOf("buyCallingNumber("), "no texting change before the number is bought and recorded");
  assert(/const textingOut = \{ callingOnly: !joined,/.test(buy), "the answer says whether it can text");
  assert(!/client_settings"\)\s*\.update/.test(buy), "client_settings.sms_number (the main texting number) is never changed here");
  const tx = slice(SRC, 'if (action === "phone_number_texting") {', "\n  }\n", "phone_number_texting");
  assert(/^if \(action === "phone_number_texting"\) \{\s*const refused = await phoneRolloutGate\(\);\s*if \(refused\) return refused;/.test(tx), "behind the rollout first");
  // It changes the business's texting registration: the purchase's own check (settings_billing
  // edit, an operator's canBill), not phone:edit alone.
  assert(/if \(refused\) return refused;\s*if \(!mayBuyPhoneNumber\(\)\) \{\s*return json\(\{ error: operator && !operator\.canBill[\s\S]*?\}, 403\);\s*\}/.test(tx),
    "refused without the texting-setup authority");
  assert(tx.indexOf("mayBuyPhoneNumber()") < tx.indexOf("attachToTexting("), "before anything is asked of Twilio");
  assert(/if \(n\.messaging_service_sid\) return json\(\{ ok: true, number: \{ id: n\.id, callingOnly: false \}, already: true \}\);/.test(tx));
  assert(/const serviceSid = await textingServiceSid\(\);\s*if \(!serviceSid\) \{/.test(tx), "only while the business's texting is on");
  assert(/\n\s*phone_number_texting: \{ area: "phone", level: "edit" \},/.test(SRC), "gated phone:edit");
  const svc = slice(SRC, "const textingServiceSid = async ()", "\n  };\n", "textingServiceSid");
  assert(/r\?\.status === "active"/.test(svc) && /\^MG\[0-9a-f\]\{32\}\$/.test(svc));
  // Workstream 2: bound to the tenant's Twilio account, which the caller resolved once (tenantTwilio).
  const deps = slice(SRC, "const textingDeps = (numberId: string, creds: TwilioCreds) => ({", "\n  });\n", "textingDeps");
  assert(/numberInService\(svc, sid, trustHubHttp\(creds\)\)/.test(deps) && /attachNumberToService\(svc, sid, trustHubHttp\(creds\)\)/.test(deps)
    && /clearNumberSmsUrl\(sid, trustHubHttp\(creds\), creds\.accountSid\)/.test(deps), "every Twilio step in the tenant's account");
  assert(/\.update\(patch\)\s*\.eq\("id", numberId\)\.eq\("client_id", clientId\)\.is\("released_at", null\)\.select\("id"\)/.test(deps));
  // Declared above every action that uses them (a const used before its line is a TDZ throw).
  for (const h of ["const textingServiceSid = async", "const textingDeps = ", "const phoneNumberRows = async"]) {
    assert(SRC.indexOf(h) > 0 && SRC.indexOf(h) < SRC.indexOf('if (action === "phone_settings_get") {'), `${h} must be declared above phone_settings_get`);
  }
});

Deno.test("texts a PERSON sends reply from the customer's number; automatic texts stay on the main one", () => {
  const send = slice(SRC, 'if (action === "crm_send_sms") {', "\n  }\n", "crm_send_sms");
  assert(/const fromNumber = await replyFromNumber\(admin, clientId, \{ contactId, userId: userId \?\? null \}\);/.test(send));
  assert(/statusCallback,\s*fromNumber,/.test(send));
  const sign = slice(SRC, 'if (action === "text_sign_link") {', "\n  }\n", "text_sign_link");
  assert(!/fromNumber/.test(sign), "the signing link goes from the main number");
  assert(!/fromNumber|replyFromNumber/.test(SUBMIT), "submit-estimate's quote text goes from the main number");
  assert(/const fromNumber = await replyFromNumber\(c\.admin, c\.ctx\.client_id, contactId\s*\? \{ contactId, userId: c\.userId \}\s*: \{ customerE164: to, userId: c\.userId \}\);/.test(WORKER_SMS), "the apps' Send asks the same");
  assert(/statusCallback,\s*fromNumber,/.test(WORKER_SMS));
  // The composer shows the number its Send will use.
  assert(/from: \(smsCfg && smsCfg\.sms_status === "active"\) \? \(replyFrom \?\? smsCfg\.sms_number \?\? null\) : null,/.test(SRC));
});

Deno.test("twilio-events: only the main texting number's verdict changes the business's registration", () => {
  const branch = slice(EVENTS, "// ── Per-number registration: the reason this function exists", "// ── Brand and campaign:", "the number-event branch");
  assert(/\.select\("id, phone_number"\)/.test(branch), "the matched row's number is read back");
  assert(/\.from\("client_settings"\)\s*\.select\("sms_number"\)\.eq\("client_id", reg\.client_id\)/.test(branch), "against the main texting number");
  assert(/const effect = numberVerdictEffect\(\{/.test(branch));
  assert(/if \(effect === "activate"\) \{/.test(branch) && /\} else if \(effect === "attention"\) \{\s*patch\.needs_attention = true;/.test(branch));
  assert(!/status === "failed"\) \{\s*patch\.needs_attention/.test(branch), "no refusal flags the business without asking which number");
  assert(/code: "sms_extra_number_registration_failed"/.test(branch));
});

Deno.test("the Worker reads `numbers` off the RPC and hands it to the apps", () => {
  assert(/numbers: businessNumbersOf\(\(data as \{ numbers\?: unknown \}\)\.numbers, data\.number\?\.e164\),/.test(WORKER_DB));
  assert(/numbers: ctx\.numbers,/.test(WORKER_TOKEN));
});

// ── the Phone tab ─────────────────────────────────────────────────────────────────────────
const HELPERS = slice(SMS, "function phoneNumbersOf(d) {", "\n// ── Call recording (migration 263)", "the number helpers");
const ui = new Function(`${HELPERS}; return { phoneNumbersOf, phoneMainNumberId, phoneNumberName, phoneNumberOwner };`)() as {
  phoneNumbersOf: (d: unknown) => Record<string, unknown>[];
  phoneMainNumberId: (list: unknown) => string | null;
  phoneNumberName: (n: unknown, i: number, mainId?: string | null) => string;
  phoneNumberOwner: (n: unknown, team: unknown[]) => string;
};

Deno.test("phoneNumbersOf: the server's list; from an older server, its one number with its route and caller ID", () => {
  const list = [{ id: N1, e164: "+15555550100" }, { id: N2, e164: "+15555550101" }];
  assertEquals(ui.phoneNumbersOf({ numbers: list }), list);
  const old = ui.phoneNumbersOf({ number: { id: N1, e164: "+15555550100" }, route: { mode: "in_order" }, callerId: { available: true }, suggestedMembers: [OWNER] });
  assertEquals(old.length, 1);
  assertEquals([old[0].id, (old[0].route as { mode: string }).mode, (old[0].callerId as { available: boolean }).available, old[0].assignedUserId], [N1, "in_order", true, null]);
  assertEquals(ui.phoneNumbersOf({ number: null }), []);
  assertEquals(ui.phoneNumbersOf(null), []);
});

Deno.test("phoneNumberName / phoneNumberOwner: its name or 'Main number' / 'Number 2'; 'Team line' or the person", () => {
  assertEquals(ui.phoneNumberName({ id: N2, label: "Sales line" }, 1, N2), "Sales line", "a name always wins");
  assertEquals(ui.phoneNumberName({ id: N1, label: null }, 0, N1), "Main number");
  assertEquals(ui.phoneNumberName({ id: N1, label: null }, 0, N2), "Number 1", "the first is not the main one just for being first");
  assertEquals(ui.phoneNumberName({ id: N2 }, 2, N1), "Number 3");
  const team = [{ userId: REP, name: "Riley Rep" }];
  assertEquals(ui.phoneNumberOwner({ assignedUserId: null }, team), "Team line");
  assertEquals(ui.phoneNumberOwner({ assignedUserId: REP }, team), "Riley Rep");
  assertEquals(ui.phoneNumberOwner({ assignedUserId: CREW }, team), "Someone no longer on the team");
});

Deno.test("phoneMainNumberId: the number texting uses, else the one it will take over (buyPlan's rule), never just the first", () => {
  const own = { id: N1, assignedUserId: REP, callingOnly: true };
  const team = { id: N2, assignedUserId: null, callingOnly: true };
  // Before texting: the oldest TEAM line, as portal-sms buyPlan adopts, though someone's own is older.
  assertEquals(ui.phoneMainNumberId([own, team]), N2);
  assertEquals(ui.phoneMainNumberId([{ ...own }, { ...own, id: N2, assignedUserId: CREW }]), N1, "only personal numbers: the oldest");
  // The server's `main` (client_settings.sms_number) wins over everything.
  assertEquals(ui.phoneMainNumberId([{ ...team, id: N1 }, { ...own, id: N2, main: true }]), N2);
  // In the texting setup already, with no `main` sent: that one.
  assertEquals(ui.phoneMainNumberId([{ ...team, id: N1 }, { ...team, id: N2, callingOnly: false }]), N2);
  // An older server's one number (no `numbers`, no owners): it.
  assertEquals(ui.phoneMainNumberId(ui.phoneNumbersOf({ number: { id: N1, e164: "+15555550100", callingOnly: true } })), N1);
  assertEquals(ui.phoneMainNumberId([]), null);
  assertEquals(ui.phoneMainNumberId(null), null);
});

Deno.test("PhoneSettingsView: per-number state above every early return; Save, Connect and caller ID name the open number", () => {
  const view = slice(SMS, "function PhoneSettingsView(", "// ── The Calls page", "PhoneSettingsView");
  const firstReturn = view.indexOf("if (err && !data) return");
  for (const h of ["const [forms, setForms] = useState({});", "const [selId, setSelId] = useState(null);", "const [adding, setAdding] = useState(false);"]) {
    assert(view.indexOf(h) > 0 && view.indexOf(h) < firstReturn, `${h} must sit above the early returns (React #310)`);
  }
  assert(/\.\.\.\(sel && sel\.id \? \{ numberId: sel\.id \} : \{\}\),/.test(view), "Save names the number");
  assert(/\.\.\.\(data\.perNumber && sel \? \{ label: form\.label, assignedUserId: form\.assignedUserId \|\| null \} : \{\}\),/.test(view),
    "a name and a person are sent only to a server that keeps them");
  assert(/phoneAction\("phone_number_texting", \{ numberId: sel\.id \}\)/.test(view));
  assert(/const canAdd = data\.scope === "team" && !!data\.canBuyNumber && !!data\.numbersForSale && numbers\.length > 0\s*&& numbers\.length < \(data\.maxNumbers \|\| 1\);/.test(view),
    "another number only where the purchase accepts it, under the server's limit (none from an older server)");
  assert(/data-ss-phone-texting-join/.test(view) && /sel\.callingOnly && data\.textingActive && canEdit && data\.canJoinTexting/.test(view),
    "'Use this number for texting too' only for someone the server lets change texting");
  assert(/if \(n\.textingStatus === "failed"\) return "The carriers turned down texting on this number; it still takes calls\.";/.test(view),
    "a number the carriers refused says so, beside that number");
  assert(/const mainId = phoneMainNumberId\(numbers\);/.test(view) && /n\.id === mainId \? "Calls only for now\. Texting uses this same number/.test(view),
    "'texting uses this same number' only on the number texting will use");
  assert(/placeholder=\{sel && sel\.id === mainId \? "Main number" : "e\.g\. Sales line"\}/.test(view));
  // The first number takes over what was chosen before there was one (forms.none), so load()
  // doesn't swap it for the server's defaults.
  const buy = slice(view, "const buyNumber = async (e164) => {", "\n  };\n", "buyNumber");
  assert(/if \(!numbers\.length && n\.id\) setForms\(\(m\) => \(m\.none && !m\[n\.id\] \? \{ \.\.\.m, \[n\.id\]: m\.none \} : m\)\);/.test(buy));
  assert(buy.indexOf("setForms(") < buy.indexOf("await load()"), "carried over before load() seeds the new number");
  assert(/<option key=\{t\.userId\} value=\{t\.userId\} disabled=\{takenBy\.has\(t\.userId\)\}>/.test(view), "someone who has a number already isn't offered another");
  assert(/\{numberCard\}\n\s*\{thisNumberCard\}/.test(view), "the name and the person sit right under the list of numbers");
});
