// My Synergy Phone plan phase 6 — texting ADOPTS a calling-only number (portal-sms buy_number,
// supabase/functions/portal-sms/adoptNumber.ts and its wiring in index.ts), and the SMS tab's
// "Use this number for texting" (portal/11-sms.jsx).
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
//
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE. adoptCallingNumber takes every Twilio call and
// every write as an injected function; the shared helpers it is wired to (attachNumberToService,
// numberInService, clearNumberSmsUrl, findIncomingNumberSid) are driven against a stub in
// supabase/functions/_shared/twilioTrustHubCallerId.test.ts. Fixtures are fake.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ADOPT_NO_SID, ADOPT_STATES, ADOPT_TOO_EARLY, ADOPT_TWILIO_FAILED, ADOPT_WRITE_FAILED, adoptBranch, adoptCallingNumber, buyPlan,
  buyPlanFromRead, numberRowWritten, type LiveNumber,
} from "../../supabase/functions/portal-sms/adoptNumber.ts";
import { numberHoldKey } from "../../supabase/functions/portal-settings/phoneNumber.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SMS_FN = await read("../../supabase/functions/portal-sms/index.ts");
const SHARED = await read("../../supabase/functions/_shared/twilioTrustHub.ts");
const SMS_TAB = await read("../../portal/11-sms.jsx");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`adoptNumber_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const MS = "MG" + "3".repeat(32);
const PN = "PN" + "2".repeat(32);
const CALLING_ONLY: LiveNumber = { id: "row-1", phone_number: "+15555550142", twilio_sid: PN, messaging_service_sid: null };

function world(o: {
  twilioSid?: string | null;
  found?: string | null;
  inService?: boolean;
  fail?: "find" | "check" | "attach" | "clear" | "sms_number" | "registration" | "number_row";
  registrationStatus?: string;
} = {}) {
  const log: string[] = [];
  const reject = (what: string) => Promise.reject(new Error(`${what} failed`));
  const dbErr = { error: { code: "57014" } };
  const deps = {
    findNumberSid: (e164: string) => { log.push(`find:${e164}`); return o.fail === "find" ? reject("find") : Promise.resolve(o.found ?? null); },
    inService: (ms: string, pn: string) => { log.push(`check:${ms.slice(0, 2)}:${pn.slice(0, 2)}`); return o.fail === "check" ? reject("check") : Promise.resolve(!!o.inService); },
    attach: (ms: string, pn: string) => { log.push(`attach:${ms.slice(0, 2)}:${pn.slice(0, 2)}`); return o.fail === "attach" ? reject("attach") : Promise.resolve(); },
    clearSmsUrl: (pn: string) => { log.push(`clear-sms-url:${pn.slice(0, 2)}`); return o.fail === "clear" ? reject("clear") : Promise.resolve(); },
    setSmsNumber: (e164: string) => { log.push(`sms_number:${e164}`); return Promise.resolve(o.fail === "sms_number" ? dbErr : { error: null }); },
    toNumberPending: () => { log.push("number_pending"); return Promise.resolve(o.fail === "registration" ? dbErr : { error: null }); },
    recordNumber: (p: { messaging_service_sid: string; twilio_sid: string }) => {
      log.push(`record:${p.messaging_service_sid.slice(0, 2)}:${p.twilio_sid.slice(0, 2)}`);
      return Promise.resolve(o.fail === "number_row" ? dbErr : { error: null });
    },
  };
  const number = { ...CALLING_ONLY, twilio_sid: o.twilioSid === undefined ? PN : o.twilioSid };
  const args = { serviceSid: MS, number, registrationStatus: o.registrationStatus ?? "campaign_approved" };
  const run = () => adoptCallingNumber(args, deps);
  const branch = () => adoptBranch(args, deps);
  return { log, run, branch };
}

Deno.test("buyPlan: no number → buy; a calling-only number → adopt the oldest; one already texting → refuse", () => {
  assertEquals(buyPlan([]), { kind: "buy" });
  assertEquals(buyPlan([CALLING_ONLY]), { kind: "adopt", number: CALLING_ONLY });
  const texting = { ...CALLING_ONLY, id: "row-2", messaging_service_sid: MS };
  assertEquals(buyPlan([texting]), { kind: "has_number" });
  assertEquals(buyPlan([CALLING_ONLY, texting]), { kind: "has_number" }, "a texting number wins; nothing is adopted beside it");
  const later = { ...CALLING_ONLY, id: "row-3", phone_number: "+15555550143" };
  assertEquals(buyPlan([CALLING_ONLY, later]), { kind: "adopt", number: CALLING_ONLY }, "the oldest, the one the Phone tab shows");
});

Deno.test("buyPlan (migration 266): a team line is adopted before someone's own number, whatever their order", () => {
  const mine = { ...CALLING_ONLY, assigned_user_id: "00000000-0000-4000-8000-0000000000a1" };
  const team = { ...CALLING_ONLY, id: "row-3", phone_number: "+15555550143", assigned_user_id: null };
  assertEquals(buyPlan([mine, team]), { kind: "adopt", number: team }, "the oldest TEAM line, though a personal number is older");
  assertEquals(buyPlan([mine]), { kind: "adopt", number: mine }, "only personal numbers: the oldest, as before");
  assertEquals(buyPlan([mine, { ...team, messaging_service_sid: MS }]), { kind: "has_number" }, "a texting number still wins");
});

Deno.test("adopt: into the Messaging Service, its own SmsUrl cleared, then sms_number, number_pending, and the row LAST", async () => {
  const w = world();
  const out = await w.run();
  assertEquals(out, { ok: true, numberSid: PN, attached: true });
  assertEquals(w.log, [
    "check:MG:PN",
    "attach:MG:PN",
    "clear-sms-url:PN",
    "sms_number:+15555550142",
    "number_pending",
    "record:MG:PN",
  ]);
});

Deno.test("adopt again after a lost write: already in the service → no second attach; nothing is bought or held", async () => {
  const w = world({ inService: true });
  const out = await w.run();
  assert(out.ok && !out.attached);
  assert(!w.log.some((l) => l.startsWith("attach:")));
  assert(w.log.includes("record:MG:PN"));
});

Deno.test("adopt: the registration moves to number_pending ONLY from campaign_approved", async () => {
  for (const s of ["number_pending", "active"]) {
    const w = world({ registrationStatus: s });
    assert((await w.run()).ok);
    assert(!w.log.includes("number_pending"), `${s} must not be moved back`);
  }
  assertEquals([...ADOPT_STATES], ["campaign_approved", "number_pending", "active"]);
});

Deno.test("adopt: a row with no SID is found by its E.164; one Twilio does not have is refused before anything else", async () => {
  const w = world({ twilioSid: null, found: PN });
  const out = await w.run();
  assert(out.ok);
  assertEquals(w.log[0], "find:+15555550142");
  assert(w.log.includes("record:MG:PN"), "the found SID is recorded with the adoption, so twilio-events can match the number");
  const lost = world({ twilioSid: null, found: null });
  assertEquals(await lost.run(), { ok: false, kind: "no_sid" });
  assertEquals(lost.log, ["find:+15555550142"]);
});

Deno.test("adopt: a Twilio failure stops before any write; a write failure stops before the row is marked adopted", async () => {
  for (const [fail, step] of [["check", "check"], ["attach", "attach"], ["clear", "clear_sms_url"]] as const) {
    const w = world({ fail });
    const out = await w.run();
    assert(!out.ok && out.kind === "twilio" && out.step === step, `${fail}: ${JSON.stringify(out)}`);
    assert(!w.log.some((l) => /^(sms_number|number_pending|record):/.test(l) || l === "number_pending"), `${fail}: nothing may be written`);
  }
  for (const fail of ["sms_number", "registration"] as const) {
    const w = world({ fail });
    const out = await w.run();
    assert(!out.ok && out.kind === "db");
    assert(!w.log.some((l) => l.startsWith("record:")), `${fail}: the row stays calling-only, so the next press adopts it again`);
  }
  const w = world({ fail: "number_row" });
  const out = await w.run();
  assert(!out.ok && out.kind === "db" && out.step === "number_row");
});

// ── The whole adopt BRANCH, driven (review BE-6: it used to be checked only as source text) ────
Deno.test("adoptBranch: before campaign_approved it refuses 409 and touches NOTHING (no Twilio, no write)", async () => {
  for (const s of ["none", "brand_pending", "campaign_pending", "campaign_failed", "paused", "off"]) {
    const w = world({ registrationStatus: s });
    const out = await w.branch();
    assertEquals(out, { ok: false, status: 409, error: ADOPT_TOO_EARLY, log: null }, s);
    assertEquals(w.log, [], `${s}: nothing may run`);
  }
});

Deno.test("adoptBranch: in every ADOPT_STATE it adopts; number_pending and active are the retry of a lost last write", async () => {
  for (const s of ADOPT_STATES) {
    const w = world({ registrationStatus: s, inService: s !== "campaign_approved" });
    const out = await w.branch();
    assertEquals(out, { ok: true, numberSid: PN, attached: s === "campaign_approved" }, s);
    assert(w.log.includes("record:MG:PN"), `${s}: the row is marked adopted`);
  }
});

Deno.test("adoptBranch: what the builder is told, and what is logged, when it stops", async () => {
  const lost = await world({ twilioSid: null, found: null }).branch();
  assertEquals(lost, { ok: false, status: 409, error: ADOPT_NO_SID, log: { code: "sms_adopt_number_not_found", message: "The calling-only number has no Twilio SID and none was found by its E.164" } });
  for (const [fail, step] of [["check", "check"], ["attach", "attach"], ["clear", "clear_sms_url"], ["find", "find"]] as const) {
    const out = await world({ fail, twilioSid: fail === "find" ? null : undefined }).branch();
    assert(!out.ok && out.status === 502 && out.error === ADOPT_TWILIO_FAILED, `${fail}: ${JSON.stringify(out)}`);
    assert(!out.ok && out.log?.code === "sms_adopt_number_twilio_failed" && out.log.severity === "error" && out.log.context?.step === step, `${fail}: ${JSON.stringify(out)}`);
  }
  for (const [fail, step] of [["sms_number", "sms_number"], ["registration", "registration"], ["number_row", "number_row"]] as const) {
    const out = await world({ fail }).branch();
    assert(!out.ok && out.status === 502 && out.error === ADOPT_WRITE_FAILED, `${fail}: ${JSON.stringify(out)}`);
    assert(!out.ok && out.log?.code === "sms_adopt_number_write_failed" && out.log.context?.step === step && out.log.context?.twilio_code === null);
  }
  assert(/Press it again to finish/.test(ADOPT_WRITE_FAILED), "and the SMS tab keeps that press (SMS_ADOPT_STATES, checked below)");
});

Deno.test("adoptBranch: a stop after number_pending, pressed again from number_pending, finishes the job", async () => {
  // First press: everything but the row's last write.
  const first = world({ fail: "number_row" });
  const a = await first.branch();
  assert(!a.ok && a.error === ADOPT_WRITE_FAILED);
  assert(first.log.includes("number_pending"), "the registration had already moved on");
  // The retry (after a reload the tab reads number_pending): no second attach, the row written.
  const retry = world({ registrationStatus: "number_pending", inService: true });
  const b = await retry.branch();
  assertEquals(b, { ok: true, numberSid: PN, attached: false });
  assert(!retry.log.includes("number_pending") && !retry.log.some((l) => l.startsWith("attach:")));
  assert(retry.log.includes("record:MG:PN"));
});

Deno.test("buyPlanFromRead: a failed read REFUSES; otherwise buyPlan decides", () => {
  const err = { message: "timeout" };
  assertEquals(buyPlanFromRead({ data: null, error: err }), { kind: "read_failed", error: err });
  assertEquals(buyPlanFromRead({ data: [CALLING_ONLY], error: err }), { kind: "read_failed", error: err }, "rows with an error are not trusted");
  assertEquals(buyPlanFromRead({ data: null, error: null }), { kind: "buy" });
  assertEquals(buyPlanFromRead({ data: [CALLING_ONLY], error: null }), { kind: "adopt", number: CALLING_ONLY });
});

Deno.test("numberRowWritten: an update that matched no row is an error, not an adoption", () => {
  assertEquals(numberRowWritten({ data: [{ id: "row-1" }], error: null }), { error: null });
  const none = numberRowWritten({ data: [], error: null });
  assert(none.error && /not updated/.test((none.error as { message: string }).message));
  assert(numberRowWritten({ data: null, error: null }).error, "no data back is not a write either");
  const e = { code: "57014" };
  assertEquals(numberRowWritten({ data: null, error: e }), { error: e });
});

// ── portal-sms index.ts wiring ───────────────────────────────────────────────────────────────
const BUY = slice(SMS_FN, 'case "buy_number": {', 'case "opt_outs": {', "buy_number");
const ADOPT = slice(BUY, 'if (plan.kind === "adopt") {', 'const wanted = String(p.phoneNumber ?? "").trim();', "the adopt branch");

Deno.test("buy_number reads the live numbers (failing CLOSED) and decides with buyPlan before anything is searched or held", () => {
  // Migration 266: with whose number each is, read again without it on a database before 266.
  assert(/const readLive = \(cols: string\) => admin\.from\("sms_numbers"\)\s*\.select\(cols\)\s*\.eq\("client_id", clientId\)\.is\("released_at", null\)\s*\.order\("purchased_at", \{ ascending: true \}\);/.test(BUY));
  assert(BUY.includes('let liveRead = await readLive("id, phone_number, twilio_sid, messaging_service_sid, assigned_user_id");'));
  assert(/if \(liveRead\.error && String\(\(liveRead\.error as \{ code\?: string \}\)\.code \?\? ""\) === "42703"\) \{\s*liveRead = await readLive\("id, phone_number, twilio_sid, messaging_service_sid"\);/.test(BUY),
    "only a missing column falls back; any other failure still refuses below");
  assert(/const plan = buyPlanFromRead\(\{ data: \(liveRead\.data \?\? null\) as LiveNumber\[\] \| null, error: liveRead\.error \}\);/.test(BUY));
  assert(/if \(plan\.kind === "read_failed"\) \{[\s\S]*?return json\(\{ error: "Couldn't check your numbers just now\. Try again in a minute\." \}, 503\);/.test(BUY), "a failed read refuses instead of buying");
  const planAt = BUY.indexOf("const plan = buyPlanFromRead(");
  for (const later of ["findPurchasedNumbers(clientId)", "takeHold(admin, clientId, \"sms_number_monthly\"", "purchaseNumber({"]) {
    assert(planAt > 0 && planAt < BUY.indexOf(later), `buyPlan must come before ${later}`);
  }
  assert(/if \(plan\.kind === "has_number"\) \{\s*return json\(\{ error: "This account already has a texting number\." \}, 409\);/.test(BUY));
  assert(!/select\("id", \{ count: "exact", head: true \}\)/.test(BUY), "the old count is gone; the read above is the one check");
});

Deno.test("the adopt branch: NO hold, NO purchase, NO search — the four shared helpers and adoptCallingNumber only", () => {
  for (const banned of ["takeHold", "wallet_hold", "purchaseNumber", "findPurchasedNumbers", "searchAvailableNumbers", "sms_num:"]) {
    assert(!ADOPT.includes(banned), `the adopt branch must not use ${banned}`);
  }
  // The state refusal, the adoption and the replies are adoptBranch's (driven above); this is wiring.
  assert(/const reply = await adoptBranch\(\s*\{ serviceSid: reg\.messaging_service_sid, number: plan\.number, registrationStatus: reg\.status \}/.test(ADOPT));
  assert(/if \(!reply\.ok\) \{\s*if \(reply\.log\) await logEdgeError\(\{ fn: "portal-sms", clientId, \.\.\.reply\.log \}\)\.catch\(\(\) => \{\}\);\s*return json\(\{ error: reply\.error \}, reply\.status\);/.test(ADOPT));
  assert(!/ADOPT_STATES|adoptCallingNumber\(/.test(ADOPT), "no second copy of the branch's rules in the handler");
  for (const w of ["findIncomingNumberSid(e164)", "numberInService(serviceSid, numberSid)", "attachNumberToService(serviceSid, numberSid)", "clearNumberSmsUrl(numberSid)"]) {
    assert(ADOPT.includes(w), `not wired: ${w}`);
  }
  assert(/\.from\("client_settings"\)\.update\(\{ sms_number: e164 \}\)\.eq\("client_id", clientId\)/.test(ADOPT));
  assert(/status: "number_pending", next_poll_at: null[\s\S]*?\.eq\("client_id", clientId\)\.eq\("status", "campaign_approved"\)/.test(ADOPT), "the registration only moves from campaign_approved, in the WHERE too");
  assert(/recordNumber: async \(patch\) => numberRowWritten\(\s*await admin\.from\("sms_numbers"\)\.update\(patch\)\s*\.eq\("id", plan\.number\.id\)\.eq\("client_id", clientId\)\.is\("released_at", null\)\.select\("id"\),\s*\)/.test(ADOPT),
    "an update that matched no row is reported (numberRowWritten), not called an adoption");
  assert(/note\("number_adopted", \{ phoneNumber: plan\.number\.phone_number, attached: reply\.attached \}\)/.test(ADOPT));
  // The picked number is only read on the BUY path: adopting needs no pick.
  assert(BUY.indexOf('if (plan.kind === "adopt") {') < BUY.indexOf('const wanted = String(p.phoneNumber ?? "").trim();'));
});

Deno.test("the hold the Phone tab took is portal-sms's own key, so an adoption has nothing left to charge", () => {
  // Both sides spell the key the same way; the adoption takes no hold under it (asserted above).
  assertEquals(numberHoldKey("demo-tenant", "+15555550142"), "sms_num:demo-tenant:+15555550142");
  assert(/takeHold\(admin, clientId, "sms_number_monthly", `sms_num:\$\{clientId\}:\$\{wanted\}`/.test(BUY));
});

Deno.test("the texting purchase still attaches through the same shared helper", () => {
  const purchase = slice(SHARED, "export async function purchaseNumber(", "\n}\n", "purchaseNumber");
  assert(/if \(opts\.messagingServiceSid && sid\) \{\s*await attachNumberToService\(opts\.messagingServiceSid, sid\);/.test(purchase));
});

Deno.test("review BE-5: the SMS tab offers the adopt press in EXACTLY the server's ADOPT_STATES, so a stopped adoption survives a reload", () => {
  const list = slice(SMS_TAB, "const SMS_ADOPT_STATES = [", "];", "SMS_ADOPT_STATES");
  const states = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assertEquals(states, [...ADOPT_STATES], "the card's states are the server's; number_pending and active included");
});

Deno.test("the status view says which number is calling-only, and the SMS tab offers to use it instead of a search", () => {
  assert(/callingOnly: !n\.messaging_service_sid,/.test(SMS_FN));
  assert(/assigned: !!n\.assigned_user_id,/.test(SMS_FN), "migration 266: whose number it is, so the card names the number buyPlan adopts");
  assert(SMS_FN.includes('let res = await read("phone_number, registration_status, purchased_at, messaging_service_sid, assigned_user_id");'));
  assert(SMS_FN.includes('res = await read("phone_number, registration_status, purchased_at, messaging_service_sid");'), "a database before 266 still lists the numbers");
  const adopt = slice(SMS_TAB, "{SMS_ADOPT_STATES.includes(status) && !readOnly && smsAdoptNumber(data.numbers) && (", "\n      )}\n", "the adopt card");
  assert(/onClick=\{\(\) => act\(\(\) => call\("buy_number", \{\}\)\)\}/.test(adopt), "adopting sends no phoneNumber");
  assert(/Finish connecting/.test(adopt), "a stopped adoption is offered as a finish, not a fresh offer");
  assert(SMS_TAB.includes("{status === \"campaign_approved\" && !readOnly && !smsAdoptNumber(data.numbers) && ("), "the search only shows when there is nothing to adopt");
});

// ── Migration 266: the SMS tab names the number buyPlan adopts, and never offers one it won't ──
Deno.test("smsAdoptNumber is buyPlan's rule on the status view's numbers: nothing once a number texts; a team line first", () => {
  const src = slice(SMS_TAB, "function smsAdoptNumber(numbers) {", "\n}\n", "smsAdoptNumber");
  const smsAdoptNumber = new Function(`${src}\n}\nreturn smsAdoptNumber;`)() as (n: unknown) => { phoneNumber: string } | null;
  const co = (phoneNumber: string, assigned = false) => ({ phoneNumber, callingOnly: true, assigned });
  assertEquals(smsAdoptNumber([]), null);
  assertEquals(smsAdoptNumber(undefined), null);
  assertEquals(smsAdoptNumber([co("+15555550142")])?.phoneNumber, "+15555550142");
  assertEquals(smsAdoptNumber([co("+15555550142", true), co("+15555550143")])?.phoneNumber, "+15555550143", "a team line before someone's own");
  assertEquals(smsAdoptNumber([co("+15555550142", true)])?.phoneNumber, "+15555550142");
  assertEquals(smsAdoptNumber([co("+15555550142"), { phoneNumber: "+15555550143", callingOnly: false }]), null,
    "with a texting number already there the server answers 409, so nothing is offered (an extra calling-only number joins from the Phone tab)");
  // A server before 266 sends no `assigned`: the oldest, as before.
  assertEquals(smsAdoptNumber([{ phoneNumber: "+15555550142", callingOnly: true }, { phoneNumber: "+15555550143", callingOnly: true }])?.phoneNumber, "+15555550142");
  // Every place the tab decides about adopting asks it, never its own copy of the rule.
  assert(!/\(data\.numbers \|\| \[\]\)\.some\(\(n\) => n\.callingOnly\)/.test(SMS_TAB), "no second copy of the rule left");
  assert(!/data\.numbers\.find\(\(n\) => n\.callingOnly\)/.test(SMS_TAB));
});
