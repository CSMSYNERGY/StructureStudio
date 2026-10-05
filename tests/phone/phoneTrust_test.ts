// My Synergy Phone plan phase 6 — caller-ID trust (plan §14): portal-settings' phone_trust_setup and
// phone_trust_status (supabase/functions/portal-settings/phoneTrust.ts and their wiring in
// index.ts), and the Phone tab's Caller ID card (portal/11-sms.jsx).
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
//
// ⚠️ NOTHING HERE REACHES TWILIO OR A DATABASE. runTrustSetup / runTrustStatus take the Twilio
// calls and the row write as injected functions; the shared Twilio flow itself
// (setupVoiceTrust) is driven against a stateful stub in
// supabase/functions/_shared/twilioTrustHubCallerId.test.ts. Fixtures are fake.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  callerIdView, chooseTrustProfile, parseTrustProduct, profileRefusal, runTrustSetup, runTrustStatus, TRUST_BUSY_SENTENCE, TRUST_COLS,
  TRUST_COLUMNS, TRUST_LOCK_MS, TRUST_OPERATOR_SENTENCE, trustOperatorAllowed, trustProfileFor, type TrustLock,
} from "../../supabase/functions/portal-settings/phoneTrust.ts";
import {
  TRUST_PRODUCT_STATUSES, TrustHubError, VOICE_INTEGRITY_INFO_REQUIRED, VOICE_INTEGRITY_USE_CASES,
  type VoiceTrustResult, type VoiceTrustSetup,
} from "../../supabase/functions/_shared/twilioTrustHub.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SRC = await read("../../supabase/functions/portal-settings/index.ts");
const SMS = await read("../../portal/11-sms.jsx");
const MIG = await read("../../supabase/migrations/255_sss_phone_followups.sql");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`phoneTrust_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const SECONDARY = "BU" + "1".repeat(32);
const PRIMARY = "BU" + "0".repeat(32);
const NUMBER = "PN" + "2".repeat(32);
const TP = "BU" + "a".repeat(32);

// ── which profile, and when it is ready ────────────────────────────────────────────────────
Deno.test("the builder's own Secondary Customer Profile; the platform's primary ONLY for an internal tenant", () => {
  assertEquals(trustProfileFor({ secondaryProfileSid: SECONDARY, internal: false, primaryProfileSid: PRIMARY }),
    { ok: true, profileSid: SECONDARY, which: "secondary" });
  // Internal with its own secondary still uses it: the ISV shape is the default everywhere.
  assertEquals(trustProfileFor({ secondaryProfileSid: SECONDARY, internal: true, primaryProfileSid: PRIMARY }),
    { ok: true, profileSid: SECONDARY, which: "secondary" });
  assertEquals(trustProfileFor({ secondaryProfileSid: null, internal: true, primaryProfileSid: PRIMARY }),
    { ok: true, profileSid: PRIMARY, which: "primary" });
  // A customer is NEVER signed as us, however the env is set.
  const cust = trustProfileFor({ secondaryProfileSid: null, internal: false, primaryProfileSid: PRIMARY });
  assert(!cust.ok && /Text Messaging registration/.test(cust.error));
  const noEnv = trustProfileFor({ secondaryProfileSid: "junk", internal: true, primaryProfileSid: "" });
  assert(!noEnv.ok && /isn't configured/.test(noEnv.error));
  // An internal tenant whose number is ALREADY on the primary (put there by hand) stays there: a
  // number sits on one business profile, so assigning it to the secondary would only fail.
  assertEquals(trustProfileFor({ secondaryProfileSid: SECONDARY, internal: true, primaryProfileSid: PRIMARY, numberOnPrimary: true }),
    { ok: true, profileSid: PRIMARY, which: "primary" });
  // …and that fact never moves a CUSTOMER onto the primary.
  assertEquals(trustProfileFor({ secondaryProfileSid: SECONDARY, internal: false, primaryProfileSid: PRIMARY, numberOnPrimary: true }),
    { ok: true, profileSid: SECONDARY, which: "secondary" });
});

// ── review BE-4: the primary-profile read FAILS CLOSED ──────────────────────────────────────
function primaryReads(answer: boolean | Error) {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      numberOnProfile: (p: string, n: string) => {
        asked.push(`${p.slice(0, 3)}:${n.slice(0, 2)}`);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
}
const INTERNAL_BOTH = { secondaryProfileSid: SECONDARY, internal: true, primaryProfileSid: PRIMARY, numberSid: NUMBER };

Deno.test("chooseTrustProfile: an internal tenant's number found on the primary stays there; not found → its secondary", async () => {
  const on = primaryReads(true);
  assertEquals(await chooseTrustProfile(INTERNAL_BOTH, on.deps), { ok: true, profileSid: PRIMARY, which: "primary" });
  assertEquals(on.asked, ["BU0:PN"]);
  const off = primaryReads(false);
  assertEquals(await chooseTrustProfile(INTERNAL_BOTH, off.deps), { ok: true, profileSid: SECONDARY, which: "secondary" });
});

Deno.test("chooseTrustProfile: a FAILED primary read is a 502 with nothing chosen — never 'not on the primary'", async () => {
  const down = primaryReads(new TrustHubError({ message: "Could not reach Twilio: reset", status: 0, code: 0, permanent: false }));
  const out = await chooseTrustProfile(INTERNAL_BOTH, down.deps);
  assert(!out.ok && out.kind === "twilio" && out.status === 502, JSON.stringify(out));
  assert(!out.ok && /Nothing was sent/.test(out.error) && !/reset/.test(out.error), "our sentence, not Twilio's text");
  const refused = primaryReads(new TrustHubError({ message: "403", status: 403, code: 20003, permanent: true }));
  const out2 = await chooseTrustProfile(INTERNAL_BOTH, refused.deps);
  assert(!out2.ok && out2.kind === "twilio" && out2.code === 20003);
  // A bug is not dressed up as Twilio.
  let thrown: unknown = null;
  try { await chooseTrustProfile(INTERNAL_BOTH, primaryReads(new TypeError("x")).deps); } catch (e) { thrown = e; }
  assert(thrown instanceof TypeError);
});

Deno.test("chooseTrustProfile asks Twilio ONLY when it decides: internal, with both a primary and a secondary", async () => {
  const cases: Array<[typeof INTERNAL_BOTH | Record<string, unknown>, unknown]> = [
    [{ ...INTERNAL_BOTH, internal: false }, { ok: true, profileSid: SECONDARY, which: "secondary" }],          // a customer
    [{ ...INTERNAL_BOTH, secondaryProfileSid: null }, { ok: true, profileSid: PRIMARY, which: "primary" }],     // internal, no secondary
    [{ ...INTERNAL_BOTH, primaryProfileSid: "" }, { ok: true, profileSid: SECONDARY, which: "secondary" }],     // no primary configured
  ];
  for (const [o, want] of cases) {
    const r = primaryReads(new Error("must not be asked"));
    const out = await chooseTrustProfile(o as typeof INTERNAL_BOTH, r.deps);
    assertEquals(r.asked, [], JSON.stringify(o));
    assertEquals(out, want, JSON.stringify(o));
  }
  const cust = await chooseTrustProfile({ ...INTERNAL_BOTH, internal: false, secondaryProfileSid: null }, primaryReads(false).deps);
  assert(!cust.ok && cust.kind === "refused" && cust.status === 409 && /Text Messaging registration/.test(cust.error));
});

Deno.test("the handler takes the profile from chooseTrustProfile, and no read of Twilio is swallowed into a guess", () => {
  const b = slice(SRC, 'if (action === "phone_trust_setup") {', "\n  }\n", "phone_trust_setup branch");
  assert(/const prof = await chooseTrustProfile\(\{[\s\S]*?numberSid: sidRes\.sid,\s*\}, \{ numberOnProfile: \(p, num\) => numberOnProfile\(p, num\) \}\);/.test(b));
  assert(!/\.catch\(\(\) => false\)/.test(b), "a failed read must not become 'no'");
  assert(/if \(prof\.kind === "refused"\) return json\(\{ error: prof\.error \}, prof\.status\);/.test(b));
  assert(/return filedHere\(json\(\{ error: prof\.error, code: prof\.code \|\| null \}, prof\.status\)\);/.test(b));
  assert(b.indexOf("chooseTrustProfile(") < b.indexOf("runTrustSetup("), "nothing is claimed or sent before the profile is known");
});

// ── review BE-3: who may register / check ──────────────────────────────────────────────────────
Deno.test("trustOperatorAllowed: view-as needs can_write and not support-only; own tenant needs an app_operators row with can_write", async () => {
  const never = () => Promise.reject(new Error("the own-tenant row must not be read in view-as"));
  const cases: Array<[string, { canWrite: boolean; supportOnly: boolean } | null, { can_write?: boolean; support_only?: boolean } | null | Error, boolean]> = [
    ["view-as, can_write", { canWrite: true, supportOnly: false }, null, true],
    ["view-as, READ-ONLY", { canWrite: false, supportOnly: false }, null, false],
    ["view-as, support-only with can_write", { canWrite: true, supportOnly: true }, null, false],
    ["view-as, support-only read-only", { canWrite: false, supportOnly: true }, null, false],
    ["own tenant, operator with can_write", null, { can_write: true, support_only: false }, true],
    ["own tenant, operator READ-ONLY", null, { can_write: false, support_only: false }, false],
    ["own tenant, support-only operator", null, { can_write: true, support_only: true }, false],
    ["own tenant, not an operator", null, null, false],
    ["own tenant, the read failed", null, new Error("db down"), false],
  ];
  for (const [name, operator, row, want] of cases) {
    const got = await trustOperatorAllowed({
      operator,
      ownOperatorRow: operator ? never : () => (row instanceof Error ? Promise.reject(row) : Promise.resolve(row)),
    });
    assertEquals(got, want, name);
  }
});

Deno.test("the gate is trustOperatorAllowed on resolveTenant's operator and the one memoised app_operators read", () => {
  const gate = slice(SRC, "const callerMayManageCallerId = ", "\n  // The number's caller-ID columns", "callerMayManageCallerId");
  assert(/trustOperatorAllowed\(\{ operator: operator \?\? null, ownOperatorRow \}\)/.test(gate));
  assert(/\(await callerMayManageCallerId\(\)\) \? null : phoneRefused\(TRUST_OPERATOR_SENTENCE, 403\)/.test(gate));
  const row = slice(SRC, "const ownOperatorRow = ", "\n  };\n", "ownOperatorRow");
  assert(/admin\.from\("app_operators"\)\.select\("user_id, can_write, support_only"\)\.eq\("user_id", userId\)\.maybeSingle\(\)/.test(row));
  assert(/support_only: data\.support_only === true/.test(row));
  const get = slice(SRC, 'if (action === "phone_settings_get") {', 'if (action === "phone_settings_save") {', "phone_settings_get");
  assert(/canManageCallerId: canEdit\("phone"\) && await callerMayManageCallerId\(\)/.test(get), "the buttons are offered to exactly who the gate lets through");
});

Deno.test("only an approved business profile goes forward, and the refusal says where it stands", () => {
  assertEquals(profileRefusal("twilio-approved"), null);
  assert(/waiting for Twilio's review/.test(profileRefusal("pending-review")!));
  assert(/rejected by Twilio/.test(profileRefusal("twilio-rejected")!));
  assert(/don't recognise/.test(profileRefusal(null)!));
});

Deno.test("the product is SHAKEN/STIR unless Voice Integrity is asked for; nothing else is accepted", () => {
  assertEquals([parseTrustProduct(undefined), parseTrustProduct(""), parseTrustProduct("shaken_stir"), parseTrustProduct("voice_integrity")],
    ["shaken_stir", "shaken_stir", "shaken_stir", "voice_integrity"]);
  assertEquals(parseTrustProduct("branded_calling"), null);
});

Deno.test("callerIdView tells the Phone tab where each stands, with no SIDs", () => {
  const v = callerIdView({ id: "n1", shaken_trust_product_sid: TP, shaken_status: "in-review", voice_integrity_trust_product_sid: null, voice_integrity_status: null, caller_id_checked_at: "2026-09-29T12:00:00Z" });
  assertEquals(v, {
    available: true,
    shakenStir: { registered: true, status: "in-review" },
    voiceIntegrity: { registered: false, status: null },
    checkedAt: "2026-09-29T12:00:00Z",
  });
  assert(!JSON.stringify(v).includes(TP));
  assertEquals(callerIdView(null, false).available, false);
  assertEquals(callerIdView({ shaken_status: "approved" }).shakenStir.status, null, "a word outside Twilio's enum is never shown as a status");
});

// ── runTrustSetup: the order ─────────────────────────────────────────────────────────────────
function setupWorld(o: {
  profile?: { status: "twilio-approved" | "pending-review" | "twilio-rejected" | null; email: string };
  setupFails?: unknown;
  writeFailsAt?: number; // 1-based write number that fails
  result?: Partial<VoiceTrustResult>;
  claim?: "ok" | "busy" | "db";
  releaseFails?: boolean;
} = {}) {
  const log: string[] = [];
  const writes: Record<string, unknown>[] = [];
  let setupArg: VoiceTrustSetup | null = null;
  const lock: TrustLock = {
    claim: () => {
      log.push("claim");
      if (o.claim === "busy") return Promise.resolve({ ok: false as const, busy: true as const });
      if (o.claim === "db") return Promise.resolve({ ok: false as const, busy: false as const, error: { code: "57014" } });
      return Promise.resolve({ ok: true as const });
    },
    release: () => { log.push("release"); return o.releaseFails ? Promise.reject(new Error("release failed")) : Promise.resolve(); },
  };
  const deps = {
    lock,
    fetchProfile: (sid: string) => { log.push(`profile:${sid}`); return Promise.resolve(o.profile ?? { status: "twilio-approved" as const, email: "owner@example.test" }); },
    setup: async (s: VoiceTrustSetup) => {
      setupArg = s;
      log.push("setup");
      await s.onTrustProduct?.(TP, "draft");
      log.push("assignments");
      if (o.setupFails) throw o.setupFails;
      return {
        trustProductSid: TP, status: "pending-review" as const, created: true, numberOnProfile: true,
        profileLinked: true, endUserCreated: false, endUserUpdated: false, numberLinked: true, submitted: true, ...(o.result ?? {}),
      };
    },
    write: (patch: Record<string, unknown>) => {
      writes.push(patch);
      log.push(`write:${Object.keys(patch).join(",")}`);
      return Promise.resolve(o.writeFailsAt === writes.length ? { ok: false as const, error: { code: "57014" } } : { ok: true as const });
    },
    now: () => "2026-09-29T12:00:00.000Z",
  };
  return { deps, log, writes, setupArg: () => setupArg };
}
const ARGS = { kind: "shaken_stir" as const, clientId: "demo-tenant", numberSid: NUMBER, profileSid: SECONDARY, existingSid: null, info: null };

Deno.test("setup: profile read first, the Trust Product written down BEFORE the assignments, then the result", async () => {
  const w = setupWorld();
  const out = await runTrustSetup(ARGS, w.deps);
  assert(out.ok);
  assertEquals(w.log, [
    "claim",                                                              // one run per number (BE-2)
    `profile:${SECONDARY}`,
    "setup",
    "write:shaken_trust_product_sid,shaken_status,caller_id_checked_at",   // the moment Twilio names it
    "assignments",
    "write:shaken_trust_product_sid,shaken_status,caller_id_checked_at",
    "release",
  ]);
  assertEquals(w.writes[1], { shaken_trust_product_sid: TP, shaken_status: "pending-review", caller_id_checked_at: "2026-09-29T12:00:00.000Z" });
  const s = w.setupArg()!;
  assertEquals([s.kind, s.email, s.friendlyName, s.profileSid, s.numberSid], ["shaken_stir", "owner@example.test", "demo-tenant — SHAKEN/STIR", SECONDARY, NUMBER]);
});

Deno.test("setup: Voice Integrity writes its own two columns, and passes the answers through", async () => {
  const w = setupWorld();
  const info = { useCase: "Phone System" as const, employeeCount: 4, averageDailyCalls: 25, notes: "" };
  const out = await runTrustSetup({ ...ARGS, kind: "voice_integrity", info, existingSid: TP }, w.deps);
  assert(out.ok);
  assertEquals(Object.keys(w.writes[0]), ["voice_integrity_trust_product_sid", "voice_integrity_status", "caller_id_checked_at"]);
  assertEquals([w.setupArg()!.voiceIntegrity, w.setupArg()!.existingSid, w.setupArg()!.friendlyName], [info, TP, "demo-tenant — Voice Integrity"]);
  assertEquals(TRUST_COLS.voice_integrity, { sid: "voice_integrity_trust_product_sid", status: "voice_integrity_status" });
});

Deno.test("setup: a profile that is not approved, or has no email, sends NOTHING to Twilio and writes nothing", async () => {
  for (const profile of [{ status: "pending-review" as const, email: "a@example.test" }, { status: "twilio-rejected" as const, email: "a@example.test" }, { status: "twilio-approved" as const, email: "" }]) {
    const w = setupWorld({ profile });
    const out = await runTrustSetup(ARGS, w.deps);
    assert(!out.ok && out.kind === "refused" && out.status === 409, JSON.stringify(profile));
    assertEquals(w.log, ["claim", `profile:${SECONDARY}`, "release"]);
  }
});

Deno.test("setup: a failed first write stops everything after it; the product is found by name next time", async () => {
  const w = setupWorld({ writeFailsAt: 1 });
  const out = await runTrustSetup(ARGS, w.deps);
  assert(!out.ok && out.kind === "db");
  assert(!w.log.includes("assignments"), "no Twilio step runs after a write the database refused");
});

// ── review BE-2: one run per number ────────────────────────────────────────────────────────────
Deno.test("setup: while another run holds the number, a press is refused 409 and NOTHING else happens", async () => {
  const w = setupWorld({ claim: "busy" });
  const out = await runTrustSetup(ARGS, w.deps);
  assertEquals(out, { ok: false, kind: "refused", status: 409, error: TRUST_BUSY_SENTENCE });
  assertEquals(w.log, ["claim"], "no profile read, no Twilio, no write, and nothing released that this run never took");
  const db = setupWorld({ claim: "db" });
  const out2 = await runTrustSetup(ARGS, db.deps);
  assert(!out2.ok && out2.kind === "db");
  assertEquals(db.log, ["claim"]);
});

Deno.test("setup: the claim is released however the run ends — refused, Twilio failure, a bug — and a failed release changes nothing", async () => {
  const twilio = setupWorld({ setupFails: new TrustHubError({ message: "x", status: 400, code: 22210, permanent: true }) });
  const t = await runTrustSetup(ARGS, twilio.deps);
  assert(!t.ok && t.kind === "twilio");
  assertEquals(twilio.log.at(-1), "release");
  const bug = setupWorld({ setupFails: new TypeError("x is undefined") });
  let thrown: unknown = null;
  try { await runTrustSetup(ARGS, bug.deps); } catch (e) { thrown = e; }
  assert(thrown instanceof TypeError);
  assertEquals(bug.log.at(-1), "release");
  const dbw = setupWorld({ writeFailsAt: 1 });
  await runTrustSetup(ARGS, dbw.deps);
  assertEquals(dbw.log.at(-1), "release");
  const sticky = setupWorld({ releaseFails: true });
  const s = await runTrustSetup(ARGS, sticky.deps);
  assert(s.ok, "a release that failed only waits out TRUST_LOCK_MS; the outcome stands");
  assertEquals(TRUST_LOCK_MS, 5 * 60_000);
});

Deno.test("the handler claims with ONE conditional update on sms_numbers and releases only its own claim", () => {
  const b = slice(SRC, 'if (action === "phone_trust_setup") {', "\n  }\n", "phone_trust_setup branch");
  assert(/const lockUntil = new Date\(Date\.now\(\) \+ TRUST_LOCK_MS\)\.toISOString\(\);/.test(b));
  assert(/\.from\("sms_numbers"\)\.update\(\{ caller_id_lock_until: lockUntil \}\)\s*\.eq\("id", n\.id\)\.eq\("client_id", clientId\)\s*\.or\(`caller_id_lock_until\.is\.null,caller_id_lock_until\.lt\.\$\{new Date\(\)\.toISOString\(\)\}`\)\s*\.select\("id"\);/.test(b),
    "the claim is one statement, and a row back is the claim");
  assert(/return \(data \?\? \[\]\)\.length \? \{ ok: true as const \} : \{ ok: false as const, busy: true as const \};/.test(b));
  assert(/\.update\(\{ caller_id_lock_until: null \}\)\s*\.eq\("id", n\.id\)\.eq\("client_id", clientId\)\.eq\("caller_id_lock_until", lockUntil\);/.test(b),
    "release clears only this run's claim");
  assert(b.indexOf("phoneOperatorGate") < b.indexOf("caller_id_lock_until"), "a non-operator never touches the lock");
});

Deno.test("setup: Twilio's refusal is a code and our sentence; Voice Integrity without answers asks for them", async () => {
  const w = setupWorld({ setupFails: new TrustHubError({ message: "Twilio refused POST /v1/TrustProducts/BU…/ChannelEndpointAssignments (HTTP 400, code 22210).", status: 400, code: 22210, permanent: true, detail: { message: "owner@example.test is invalid" } }) });
  const out = await runTrustSetup(ARGS, w.deps);
  assert(!out.ok && out.kind === "twilio");
  assertEquals(!out.ok && out.kind === "twilio" && [out.status, out.code], [502, 22210]);
  assert(!out.ok && out.kind === "twilio" && /error 22210/.test(out.error) && !/example\.test/.test(out.error), "no Twilio body text in the answer");
  const vi = setupWorld({ setupFails: new TrustHubError({ message: VOICE_INTEGRITY_INFO_REQUIRED, status: 400, code: 0, permanent: true }) });
  const out2 = await runTrustSetup({ ...ARGS, kind: "voice_integrity" }, vi.deps);
  assert(!out2.ok && out2.kind === "refused" && out2.status === 400 && /Voice Integrity questions/.test(out2.error));
  // A bug is not dressed up as a Twilio refusal.
  const bug = setupWorld({ setupFails: new TypeError("x is undefined") });
  let thrown: unknown = null;
  try { await runTrustSetup(ARGS, bug.deps); } catch (e) { thrown = e; }
  assert(thrown instanceof TypeError);
});

// ── runTrustStatus ───────────────────────────────────────────────────────────────────────────
Deno.test("status: each recorded product is read and stored; a deleted one is cleared; codes come back", async () => {
  const writes: Record<string, unknown>[] = [];
  const out = await runTrustStatus(
    { id: "n1", shaken_trust_product_sid: TP, shaken_status: "pending-review", voice_integrity_trust_product_sid: "BU" + "b".repeat(32), voice_integrity_status: "in-review" },
    {
      fetchTrustProduct: (sid) => sid === TP
        ? Promise.resolve({ status: "twilio-rejected" as const, errorCodes: [22215] })
        : Promise.reject(new TrustHubError({ message: "404", status: 404, code: 20404, permanent: true })),
      write: (p) => { writes.push(p); return Promise.resolve({ ok: true as const }); },
      now: () => "2026-09-29T12:00:00.000Z",
    },
  );
  assert(out.ok);
  assertEquals(writes, [{
    shaken_status: "twilio-rejected", voice_integrity_trust_product_sid: null, voice_integrity_status: null,
    caller_id_checked_at: "2026-09-29T12:00:00.000Z",
  }]);
  assertEquals(out.ok && out.view.shakenStir, { registered: true, status: "twilio-rejected" });
  assertEquals(out.ok && out.view.voiceIntegrity, { registered: false, status: null });
  assertEquals(out.ok && out.errorCodes, { shakenStir: [22215], voiceIntegrity: [] });
  // Nothing recorded: nothing asked, nothing written.
  const none = await runTrustStatus({}, { fetchTrustProduct: () => Promise.reject(new Error("must not be called")), write: () => Promise.reject(new Error("must not be called")) });
  assert(none.ok && !none.changed);
  // Twilio down: a refusal in words, and nothing written.
  const down = await runTrustStatus({ shaken_trust_product_sid: TP }, {
    fetchTrustProduct: () => Promise.reject(new TrustHubError({ message: "503", status: 503, code: 0, permanent: false })),
    write: () => Promise.reject(new Error("must not be called")),
  });
  assert(!down.ok && down.kind === "twilio" && down.status === 502);
});

// ── index.ts wiring ──────────────────────────────────────────────────────────────────────────
Deno.test("both actions are in GATES, and each one's FIRST act is the operator gate — never the rollout gate", () => {
  assert(/\n\s*phone_trust_setup:\s*\{\s*area:\s*"phone",\s*level:\s*"edit"\s*\}/.test(SRC));
  // Status WRITES the row, so it is an edit-level line too (review BE-3): a READ-level line is where
  // resolveTenant lets a read-only operator through.
  assert(/\n\s*phone_trust_status:\s*\{\s*area:\s*"phone",\s*level:\s*"edit"\s*\}/.test(SRC));
  for (const a of ["phone_trust_setup", "phone_trust_status"]) {
    const b = slice(SRC, `if (action === "${a}") {`, "\n  }\n", `${a} branch`);
    assert(/^if \(action === "\w+"\) \{\s*const refused = await phoneOperatorGate\(\);\s*if \(refused\) return refused;/.test(b), `${a} must refuse non-operators before anything else`);
    assert(!/phoneRolloutGate|phoneSelfServe/.test(b), `${a} must not open with PHONE_SELF_SERVE`);
  }
  const gate = slice(SRC, "const phoneOperatorGate = async", "\n  // The number's caller-ID columns", "phoneOperatorGate");
  assert(/\(await callerMayManageCallerId\(\)\) \? null : phoneRefused\(TRUST_OPERATOR_SENTENCE, 403\)/.test(gate),
    "the STRICT gate (can_write, not support-only), not the rollout's callerIsOperator");
  assert(/Structure Studio/.test(TRUST_OPERATOR_SENTENCE));
});

Deno.test("setup: the profile comes from the texting registration (or, internal only, the primary), then runTrustSetup with the shared flow", () => {
  const b = slice(SRC, 'if (action === "phone_trust_setup") {', "\n  }\n", "phone_trust_setup branch");
  assert(/\.from\("sms_registrations"\)\s*\.select\("customer_profile_sid"\)/.test(b));
  assert(/isInternalTenant\(admin, clientId\)/.test(b));
  assert(/const primaryProfileSid = Deno\.env\.get\("TWILIO_PRIMARY_PROFILE_SID"\) \?\? null;/.test(b));
  assert(/runTrustSetup\(\{/.test(b) && /setup: \(s\) => setupVoiceTrust\(s\)/.test(b) && /fetchProfile: \(sid\) => fetchCustomerProfile\(sid\)/.test(b));
  assert(/parseVoiceIntegrityInfo\(payload\.voiceIntegrity\)/.test(b));
  assert(b.indexOf("phoneOperatorGate") < b.indexOf("trustHubConfigured()"), "a non-operator learns nothing about the server's setup");
  assert(!/wallet_hold|takeNumberHold/.test(b), "nothing here spends the builder's wallet");
  const st = slice(SRC, 'if (action === "phone_trust_status") {', "\n  }\n", "phone_trust_status branch");
  assert(/runTrustStatus\(/.test(st) && /fetchTrustProduct: \(sid\) => fetchTrustProduct\(sid\)/.test(st));
});

Deno.test("phone_settings_get reports the caller ID from its OWN select, and who may change it", () => {
  const get = slice(SRC, 'if (action === "phone_settings_get") {', 'if (action === "phone_settings_save") {', "phone_settings_get");
  // Migration 266: ONE read of every number's caller-ID columns, in their own select, on this tenant.
  assert(/const tr = await admin\.from\("sms_numbers"\)\.select\(TRUST_COLUMNS\)\.eq\("client_id", clientId\)\.in\("id", rows\.map\(\(r\) => r\.id\)\)/.test(get));
  assert(/trustAvailable = !tr\.error;/.test(get) && /trustAvailable \? callerIdView\(/.test(get) && /: callerIdView\(null, false\);/.test(get),
    "a server without 255 shows 'not available', never a failed screen");
  assert(/callerId: callerIdOf\(String\(r\.id\)\)/.test(get), "each number carries its own caller ID");
  assert(/canManageCallerId: canEdit\("phone"\) && await callerMayManageCallerId\(\)/.test(get));
  // The number read everything else uses is untouched by 255's columns.
  const numberRead = slice(SRC, "const phoneNumberRows = async ()", "\n  };\n", "phoneNumberRows");
  assert(!/shaken|voice_integrity|caller_id/.test(numberRead));
  assert(!/shaken|voice_integrity|caller_id/.test(slice(SRC, "const NUMBER_COLUMNS = ", ";", "NUMBER_COLUMNS")));
  assert(/\.select\(TRUST_COLUMNS\)/.test(SRC));
});

Deno.test("migration 255 has every column phoneTrust reads, and the same status vocabulary", () => {
  for (const col of [...TRUST_COLUMNS.split(",").map((c) => c.trim()).filter((c) => c !== "id"), "caller_id_lock_until"]) {
    assert(new RegExp(`add column if not exists ${col}\\b`).test(MIG), `255 does not add ${col}`);
  }
  assert(/add column if not exists caller_id_lock_until\s+timestamptz/.test(MIG), "the claim is a timestamptz, NULL = free (review BE-2)");
  assert(!/caller_id_lock_until/.test(TRUST_COLUMNS), "the lock is never sent to the Phone tab");
  const enumSql = "'draft','pending-review','in-review','twilio-rejected','twilio-approved'";
  assertEquals(TRUST_PRODUCT_STATUSES.map((s) => `'${s}'`).join(","), enumSql);
  assertEquals(MIG.split(enumSql).length - 1, 2, "both status checks carry Twilio's enum");
  assert(/^begin;$/m.test(MIG) && /^commit;$/m.test(MIG), "255 carries its own transaction");
});

// ── the Phone tab ────────────────────────────────────────────────────────────────────────────
Deno.test("the Caller ID card: status words for Twilio's enum, Twilio's use cases, and buttons for an operator only", () => {
  const words = slice(SMS, "const PHONE_TRUST_WORDS = {", "};", "PHONE_TRUST_WORDS");
  for (const s of TRUST_PRODUCT_STATUSES) assert(words.includes(`"${s}":`), `no words for ${s}`);
  const cases = slice(SMS, "const PHONE_VI_USE_CASES = [", "];", "PHONE_VI_USE_CASES");
  const listed = [...cases.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert(listed.length >= 4);
  for (const u of listed) assert((VOICE_INTEGRITY_USE_CASES as readonly string[]).includes(u), `"${u}" is not one of Twilio's use cases`);
  assert(/useState\(\{ useCase: "Customer Support",/.test(SMS) && listed.includes("Customer Support"), "the default is one of the listed options");
  const card = slice(SMS, "const callerIdCard = ", ") : null;", "callerIdCard");
  const row = slice(SMS, "const trustRow = (key, label, blurb, product) => {", "\n  };\n", "trustRow");
  assert(/data\.canManageCallerId && canSend &&/.test(row), "Register only for an operator, and only while there is something to send");
  assert(/data\.canManageCallerId && \(cid\.shakenStir\.registered \|\| cid\.voiceIntegrity\.registered\) &&/.test(card), "Check status only for an operator");
  // Migration 266: each press names the number that is open (caller ID is per number).
  assert(/phoneAction\("phone_trust_setup", \{ product, numberId: sel\.id,/.test(SMS) && /phoneAction\("phone_trust_status", \{ numberId: sel\.id \}\)/.test(SMS));
  assert(/const cid = \(sel && sel\.callerId\) \|\| null;/.test(SMS), "the card reads the open number's registrations");
  // Under the number on the team screen; since migration 266 the number's name and person come first.
  assert(/\{numberCard\}\n\s*\{thisNumberCard\}\n\s*\{callerIdCard\}/.test(SMS), "the card sits under the number on the team screen");
});
