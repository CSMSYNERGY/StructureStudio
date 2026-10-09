// My Synergy Phone — the review fixes of 2026-09-29 that live in portal-settings' pure module (phone.ts)
// and in the Phone tab: the rollout switch on the server (SSB-1), "Sign out all devices" and a
// CSM Synergy operator's sessions (SSB-9), the generation bump and the Save-as-contact refusals
// pulled out of index.ts so they RUN here (SSB-10).
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
//
// Nothing here reaches Supabase or Twilio. The handlers' wiring in index.ts (which calls
// Deno.serve at import) is checked on the shipped source between stable anchors, the way the
// other files here do; everything with a decision in it is driven for real.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  bumpDeviceGeneration, createContactRefusal, DUPLICATE_PHONE_SENTENCE, PHONE_ROLLOUT_SENTENCE, phoneRolloutRefusal, phoneSelfServeOn,
  signoutPlan,
} from "../../supabase/functions/portal-settings/phone.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SRC = await read("../../supabase/functions/portal-settings/index.ts");
const SMS = await read("../../portal/11-sms.jsx");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`phoneReview_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

// ── SSB-1: the rollout, on the server ──────────────────────────────────────────────────────
Deno.test("rollout: only PHONE_SELF_SERVE=on opens it to builders; until then an operator is needed", () => {
  // Workstream 2: and only once TWILIO_SUBACCOUNTS is "on" too, so no builder buys a number on the
  // parent account by accident (one tenant, one account, for good).
  const env = (v?: string, sub = "on") => (k: string) => (k === "PHONE_SELF_SERVE" ? v : k === "TWILIO_SUBACCOUNTS" ? sub : undefined);
  assertEquals(phoneSelfServeOn(env(undefined)), false);
  assertEquals(phoneSelfServeOn(env("")), false);
  assertEquals(phoneSelfServeOn(env("true")), false, "only the exact word opens it");
  assertEquals(phoneSelfServeOn(env(" ON ")), true);
  for (const sub of ["", "off", "ON", "true", "manual"]) assertEquals(phoneSelfServeOn(env("on", sub)), false, `sub-accounts "${sub}" keeps it closed`);
  assertEquals(phoneRolloutRefusal({ selfServe: false, operator: false }), PHONE_ROLLOUT_SENTENCE);
  assertEquals(phoneRolloutRefusal({ selfServe: false, operator: true }), null);
  assertEquals(phoneRolloutRefusal({ selfServe: true, operator: false }), null);
});

Deno.test("rollout: turning calling ON, searching, buying and connecting all ask the gate FIRST; turning it OFF never does", () => {
  const gate = slice(SRC, "const phoneRolloutGate = async", "\n  };\n", "phoneRolloutGate");
  assert(/phoneRefused\(why, 403\)/.test(gate), "a refusal is a 403 marked as a refusal, not a fault");
  const status = slice(SRC, 'if (action === "phone_status_set") {', "\n  }\n", "phone_status_set");
  assert(/if \(on\) \{\s*const refused = await phoneRolloutGate\(\);/.test(status));
  assert(status.indexOf("phoneRolloutGate(") < status.indexOf("switchCalling("), "checked before the column is written");
  for (const a of ["phone_search_numbers", "phone_buy_number", "phone_enable_number"]) {
    const b = slice(SRC, `if (action === "${a}") {`, "\n  }\n", a);
    assert(/^if \(action === "\w+"\) \{\s*const refused = await phoneRolloutGate\(\);\s*if \(refused\) return refused;/.test(b), `${a}: gate first`);
  }
});

Deno.test("rollout: an operator is one in view-as, or an app_operators member with can_write on their own tenant", () => {
  const op = slice(SRC, "const callerIsOperator = (): Promise<boolean> => {", "\n  };\n", "callerIsOperator");
  assert(/if \(operator\) return Promise\.resolve\(true\);/.test(op));
  assert(/return ownOperatorRow\(\)\.then\(\(row\) => !!row && row\.can_write === true\);/.test(op), "a read-only operator is not an operator");
  // The one memoised app_operators read, shared with the caller-ID gate (which also asks support_only).
  const row = slice(SRC, "const ownOperatorRow = ", "\n  };\n", "ownOperatorRow");
  assert(/admin\.from\("app_operators"\)\.select\("user_id, can_write, support_only"\)\.eq\("user_id", userId\)\.maybeSingle\(\)/.test(row), "a service-role read (app_operators has no policies)");
  assert(/!error && data \? \{ can_write: data\.can_write === true, support_only: data\.support_only === true \} : null,\s*\(\) => null\);/.test(row), "a failed read is not an operator");
});

Deno.test("rollout: phone_settings_get tells the screen what the gate will accept, and the Phone tab offers only that", () => {
  const get = slice(SRC, 'if (action === "phone_settings_get") {', 'if (action === "phone_settings_save") {', "phone_settings_get");
  assert(/const rolloutOpen = canEdit\("phone"\) && \(phoneSelfServe\(\) \|\| await callerIsOperator\(\)\);/.test(get));
  assert(/canSwitchOn: rolloutOpen,/.test(get) && /canConnect: rolloutOpen,/.test(get));
  assert(/canBuyNumber: rolloutOpen && mayBuyPhoneNumber\(\),/.test(get), "Buy is offered only where the rollout AND billing allow it");
  const view = slice(SMS, "function PhoneSettingsView(", "// ── The Calls page", "PhoneSettingsView");
  assert(/canEdit && data\.scope === "team" && \(on \|\| data\.canSwitchOn\) && \(/.test(view), "'Turn calling on' only where the server will accept it; 'off' always");
  assert(/!on && data\.scope === "team" && !data\.canSwitchOn && \(/.test(view), "and the owner is told why there is no switch");
  assert(/\{canEdit && data\.canConnect && \(/.test(view), "Connect only where the server will accept it");
});

Deno.test("ssPhoneOffered can stay a DRAWING rule: the server refuses the writes whatever the host", async () => {
  const CORE = await read("../../portal/01-core.jsx");
  // The browser guard still draws the tab on beta; the point of SSB-1 is that it no longer matters.
  assert(/function ssPhoneOffered\(phoneStatus, operatorViewing\) \{/.test(CORE));
  assert(!/ssIsBetaHost\(\)/.test(slice(SRC, "const phoneRolloutGate = async", "\n  };\n", "gate")), "the server gate knows nothing about hosts");
});

// ── SSB-9: "Sign out all devices" and a CSM Synergy operator ────────────────────────────────
Deno.test("signoutPlan: an admin never signs out the owner; an owner or an operator may", () => {
  const base = { targetIsOperator: false };
  assertEquals(signoutPlan({ ...base, targetRole: "owner", callerRole: "admin", callerIsOperator: false }).ok, false);
  assertEquals(signoutPlan({ ...base, targetRole: "owner", callerRole: "owner", callerIsOperator: false }), { ok: true, endSessions: true });
  assertEquals(signoutPlan({ ...base, targetRole: "owner", callerRole: "operator", callerIsOperator: true }), { ok: true, endSessions: true });
  assertEquals(signoutPlan({ ...base, targetRole: "user", callerRole: "admin", callerIsOperator: false }), { ok: true, endSessions: true });
});

Deno.test("signoutPlan (review SSB-9): a builder can retire an operator's devices here but never end their sessions; an operator can", () => {
  // An operator with a 'user' row on the tenant, signed out by the builder's admin.
  assertEquals(signoutPlan({ targetRole: "user", callerRole: "admin", callerIsOperator: false, targetIsOperator: true }), { ok: true, endSessions: false });
  // An operator who is a co-owner, signed out by the builder's owner.
  assertEquals(signoutPlan({ targetRole: "owner", callerRole: "owner", callerIsOperator: false, targetIsOperator: true }), { ok: true, endSessions: false });
  // Another operator repairing the account may end them.
  assertEquals(signoutPlan({ targetRole: "user", callerRole: "operator", callerIsOperator: true, targetIsOperator: true }), { ok: true, endSessions: true });
  // The answer says their sign-ins were kept, and the Phone tab words it.
  const b = slice(SRC, 'if (action === "phone_signout_user") {', '// ── "Save as contact" (My Synergy Phone)', "phone_signout_user");
  assert(/\.\.\.\(plan\.endSessions \? \{\} : \{ sessionsKept: "operator" \}\)/.test(b));
  assert(/d\.sessionsKept === "operator"/.test(SMS), "the Phone tab says why their Structure Studio sign-ins were left alone");
});

// ── The generation bump, run for real (it was a regex over index.ts) ─────────────────────────
function genDb(start: number | null, script: { insertCodes?: (string | null)[]; lose?: number; readError?: boolean } = {}) {
  let gen = start;
  let lost = 0;
  const ins = [...(script.insertCodes ?? [])];
  const log: string[] = [];
  return {
    log,
    get gen() { return gen; },
    db: {
      read: () => { log.push(`read:${gen}`); return Promise.resolve({ gen, error: script.readError ? { code: "XX000" } : null }); },
      insert: (g: number) => {
        const code = ins.length ? ins.shift()! : null;
        log.push(`insert:${g}:${code ?? "ok"}`);
        if (code === "23505") { gen = 5; return Promise.resolve({ error: { code } }); }   // someone else created it meanwhile
        if (code) return Promise.resolve({ error: { code } });
        gen = g; return Promise.resolve({ error: null });
      },
      update: (from: number, to: number) => {
        if (lost < (script.lose ?? 0)) { lost++; gen = (gen ?? 1) + 1; log.push(`update:${from}->${to}:lost`); return Promise.resolve({ swapped: false, error: null }); }
        log.push(`update:${from}->${to}`);
        if (gen !== from) return Promise.resolve({ swapped: false, error: null });
        gen = to; return Promise.resolve({ swapped: true, error: null });
      },
    },
  };
}

Deno.test("bumpDeviceGeneration: the first sign-out writes 2; later ones add one by compare-and-swap", async () => {
  const fresh = genDb(null);
  assertEquals(await bumpDeviceGeneration(fresh.db), { generation: 2 });
  const later = genDb(4);
  assertEquals(await bumpDeviceGeneration(later.db), { generation: 5 });
  assertEquals(later.log, ["read:4", "update:4->5"]);
});

Deno.test("bumpDeviceGeneration: an insert that loses to another insert bumps THAT row; two lost swaps retry; three give up", async () => {
  const race = genDb(null, { insertCodes: ["23505"] });
  assertEquals(await bumpDeviceGeneration(race.db), { generation: 6 });
  assertEquals(race.log, ["read:null", "insert:2:23505", "read:5", "update:5->6"]);
  const busy = genDb(3, { lose: 2 });
  assertEquals(await bumpDeviceGeneration(busy.db), { generation: 6 });
  const hopeless = genDb(3, { lose: 3 });
  assertEquals(await bumpDeviceGeneration(hopeless.db), { conflict: true });
  const broken = genDb(null, { insertCodes: ["42P01"] });
  assertEquals(await bumpDeviceGeneration(broken.db), { error: { code: "42P01" } });
  const unread = genDb(2, { readError: true });
  assertEquals(await bumpDeviceGeneration(unread.db), { error: { code: "XX000" } });
});

// ── Save as contact: the refusals, run for real ─────────────────────────────────────────────
Deno.test("createContactRefusal maps each known database answer to its sentence; anything else is a fault (null)", () => {
  assertEquals(createContactRefusal({ code: "23505", message: "duplicate key value violates unique constraint \"crm_contacts_tenant_phone\"" }),
    { status: 409, error: DUPLICATE_PHONE_SENTENCE });
  assertEquals(createContactRefusal({ code: "PGRST202", message: "Could not find the function" })?.status, 503);
  assertEquals(createContactRefusal({ code: "42883", message: "function does not exist" })?.refusal, true, "a server without 254 is a refusal, not a fault");
  assertEquals(createContactRefusal({ code: "23514", message: "a phone number is required" })?.status, 400);
  assertEquals(createContactRefusal({ code: "23503", message: "owner is not on this team" })?.status, 403);
  assertEquals(createContactRefusal({ code: "57014", message: "canceling statement due to statement timeout" }), null);
  assertEquals(createContactRefusal(null), null);
});
