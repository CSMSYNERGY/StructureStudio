// Your own answer on AI transcripts in Structure Studio's My Profile (2026-10-14): the same answer
// the phone app and the Chrome extension save through the phone-api Worker (migration 307's
// phone_user_settings.ai_transcripts), one per account. What this file holds:
//   * THE WORKER'S RULES, read off its SHIPPED source (workers/phone-api/src/aiConsent.ts and
//     routes/me.ts): the version limits, the columns, both refusal sentences, consentOut and
//     allowsAi word for word, the validation expressions, and the upsert's exact row;
//   * the apps' notice version and words, when the phone repo is checked out beside this one (or
//     SS_PHONE_CORE_DIR names its packages/phone-core): phone-core's AI_NOTICE_VERSION, its
//     button words, and every shared sentence of the notice and the status lines;
//   * _shared/aiConsent.ts parseAiAnswer: values, version, a stale page, nothing from the body
//     but the answer and the version;
//   * portal-settings/aiTranscripts.ts against a stub database: only the session's own row is
//     read or written, the business's facts, a database before 307, a real fault;
//   * the wiring, read off portal-settings/index.ts: the GATES lines and what they let through
//     (resolveTenant's own checkGate / gateIsRead), the view-as refusal before any write, the
//     read in view-as never touching the operator's row, nothing taken from the body;
//   * the portal card's helpers, lifted out of the SHIPPED portal/08-integrations.jsx, and its
//     version.
// The browser half (the card on the COMPILED portal) is tests/harness/myProfileAiConsent.mjs.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
//
// Every value here is an obviously fake fixture: this repo is public.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  AI_CHOICE_REFUSED, AI_CONSENT_COLUMNS, AI_CONSENT_MAX_VERSION, AI_CONSENT_MIN_VERSION, AI_NOTICE_STALE, AI_NOTICE_VERSION,
  AI_VERSION_REFUSED, allowsAi, consentOut, currentAnswer, parseAiAnswer,
} from "../../supabase/functions/_shared/aiConsent.ts";
import {
  AI_TRANSCRIPTS_NOT_READY, AI_TRANSCRIPTS_VIEW_AS, businessFacts, readAiTranscripts, saveAiTranscripts, type AiTranscriptsDb,
} from "../../supabase/functions/portal-settings/aiTranscripts.ts";
import { checkGate, gateIsRead, type Gate } from "../../supabase/functions/_shared/access.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
/** Whole-line `//` comments removed, so a comment that NAMES a thing cannot satisfy a check. */
const code = (src: string) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const SHARED = await read("../../supabase/functions/_shared/aiConsent.ts");
const SETTINGS = code(await read("../../supabase/functions/portal-settings/index.ts"));
const PORTAL = await read("../../portal/08-integrations.jsx");
const WORKER_CONSENT = await read("../../workers/phone-api/src/aiConsent.ts");
const WORKER_ME = await read("../../workers/phone-api/src/routes/me.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`aiTranscripts_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};
const constOf = (src: string, name: string, what: string): string => {
  const m = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`).exec(src);
  if (!m) throw new Error(`aiTranscripts_test: ${what} has no ${name}`);
  return m[1].trim();
};
/** One exported function's whole text, from `export function name(` to its closing brace at column 0. */
const fnOf = (src: string, name: string, what: string) => slice(src, `export function ${name}(`, "\n}\n", `${what} ${name}`) + "\n}";

const USER = "00000000-0000-4000-8000-0000000000a1";
const CLIENT = "acme-sheds";

// ── The Worker's rules, word for word ──────────────────────────────────────────────────────────

Deno.test("the version limits and the columns are the Worker's", () => {
  assertEquals(String(AI_CONSENT_MIN_VERSION), constOf(WORKER_CONSENT, "AI_CONSENT_MIN_VERSION", "workers/phone-api/src/aiConsent.ts"));
  assertEquals(String(AI_CONSENT_MAX_VERSION), constOf(WORKER_CONSENT, "AI_CONSENT_MAX_VERSION", "workers/phone-api/src/aiConsent.ts"));
  assertEquals(JSON.stringify(AI_CONSENT_COLUMNS), constOf(WORKER_CONSENT, "AI_CONSENT_COLUMNS", "workers/phone-api/src/aiConsent.ts"));
  // The notice version a save stores must still count for the Worker, or a yes given here sends nothing.
  assert(AI_NOTICE_VERSION >= AI_CONSENT_MIN_VERSION && AI_NOTICE_VERSION <= AI_CONSENT_MAX_VERSION);
});

Deno.test("both refusal sentences are the Worker's, word for word", () => {
  const sentence = (name: string) => {
    const m = new RegExp(`const ${name} = ("[^"]+");`).exec(WORKER_ME);
    if (!m) throw new Error(`workers/phone-api/src/routes/me.ts has no ${name}`);
    return JSON.parse(m[1]);
  };
  assertEquals(AI_CHOICE_REFUSED, sentence("AI_CHOICE_REFUSED"));
  assertEquals(AI_VERSION_REFUSED, sentence("AI_VERSION_REFUSED"));
});

Deno.test("consentOut and allowsAi are the Worker's, character for character", () => {
  for (const name of ["consentOut", "allowsAi"]) {
    assertEquals(fnOf(SHARED, name, "_shared/aiConsent.ts"), fnOf(WORKER_CONSENT, name, "workers/phone-api/src/aiConsent.ts"), name);
  }
});

Deno.test("the save checks the answer and the version with the Worker's own expressions", () => {
  const worker = slice(WORKER_ME, "export async function aiTranscriptsMe(", "\n}\n", "routes/me.ts aiTranscriptsMe");
  const ours = fnOf(SHARED, "parseAiAnswer", "_shared/aiConsent.ts");
  for (const expr of [
    `choice !== "allowed" && choice !== "declined"`,
    "typeof version !== \"number\" || !Number.isInteger(version) || version < 1 || version > AI_CONSENT_MAX_VERSION",
  ]) {
    assert(worker.includes(expr), `the Worker's save no longer reads: ${expr}`);
    assert(ours.includes(expr), `parseAiAnswer no longer reads: ${expr}`);
  }
  // And the row it writes: the Worker's keys, in the Worker's order, by the Worker's conflict key.
  const keys = (src: string) => {
    const m = /upsert\(\{([\s\S]*?)\}, \{ onConflict: "user_id" \}\)\.select\(AI_CONSENT_COLUMNS\)\.single\(\)/.exec(src);
    if (!m) throw new Error("no upsert by user_id selecting AI_CONSENT_COLUMNS");
    return [...m[1].matchAll(/([a-z_]+):/g)].map((x) => x[1]);
  };
  const MOD = SETTINGS_MODULE;
  assertEquals(keys(MOD), keys(worker));
});
const SETTINGS_MODULE = await read("../../supabase/functions/portal-settings/aiTranscripts.ts");

// ── The apps: phone-core's version and words, when the phone repo is here ─────────────────────
// The phone repo is private and separate, so this runs only where it is checked out: beside this
// repo (../structure-studio-phone) or wherever SS_PHONE_CORE_DIR points (its packages/phone-core).
async function phoneCoreSource(): Promise<string | null> {
  const dir = Deno.env.get("SS_PHONE_CORE_DIR");
  const url = dir
    ? new URL(`file:///${dir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/?$/, "/")}src/aiTranscripts.ts`)
    : new URL("../../../structure-studio-phone/packages/phone-core/src/aiTranscripts.ts", import.meta.url);
  try {
    return (await Deno.readTextFile(url)).replace(/\r\n/g, "\n");
  } catch (_) {
    return null;
  }
}
const CORE = await phoneCoreSource();

// ── The portal card's helpers, lifted out of the shipped source ────────────────────────────────
type Section = { heading: string; lines: string[] };
type CardHelpers = {
  SS_AI_NOTICE_VERSION: number;
  SS_AI_PRIVACY_URL: string;
  SS_AI_WORDS: Record<string, string>;
  ssAiStatusLines: (d: { callRecording?: boolean; businessTranscribes?: boolean }) => string[];
  ssAiChoiceText: (a: string | null) => string;
  ssAiNoticeSections: (businessTranscribes: boolean) => Section[];
};
const REGION = slice(PORTAL, "const SS_AI_NOTICE_VERSION", "window.__ssAiConsent = ", "the AI transcripts helpers in portal/08-integrations.jsx");
const P = new Function(`${REGION}
  return { SS_AI_NOTICE_VERSION, SS_AI_PRIVACY_URL, SS_AI_WORDS, ssAiStatusLines, ssAiChoiceText, ssAiNoticeSections };`)() as CardHelpers;

Deno.test("the card saves the server's notice version, and links the phone privacy policy", () => {
  assertEquals(P.SS_AI_NOTICE_VERSION, AI_NOTICE_VERSION);
  assertEquals(P.SS_AI_PRIVACY_URL, "https://csmsynergy.com/my-synergy-phone/privacy");
  // The save carries it, from the constant (not a literal that could drift from it).
  assert(/action: "ai_transcripts_save", answer, version: SS_AI_NOTICE_VERSION/.test(PORTAL), "the card's save no longer sends SS_AI_NOTICE_VERSION");
});

Deno.test({
  name: "phone-core: the same notice version, the same buttons, and every shared sentence",
  ignore: !CORE,
  fn: () => {
    const core = CORE!;
    assertEquals(String(AI_NOTICE_VERSION), constOf(core, "AI_NOTICE_VERSION", "phone-core aiTranscripts.ts"));
    // The card's words that are the apps' words (card key → phone-core AI_WORDS key).
    const SAME: [string, string][] = [
      ["title", "settingsTitle"], ["noticeTitle", "title"], ["allow", "allow"], ["allowLabel", "allowLabel"],
      ["decline", "decline"], ["declineLabel", "declineLabel"], ["stop", "stop"], ["stopLabel", "stopLabel"],
      ["show", "show"], ["privacy", "privacy"], ["saveFailed", "saveFailed"],
    ];
    for (const [ours, theirs] of SAME) {
      assert(core.includes(`${theirs}: ${JSON.stringify(P.SS_AI_WORDS[ours])},`), `phone-core AI_WORDS.${theirs} is not ${JSON.stringify(P.SS_AI_WORDS[ours])}`);
    }
    // Every sentence of the notice that doesn't name an app is the apps' sentence. phone-core
    // builds some of them from pieces, so each is compared with its quotes and joins taken out.
    const flat = core.replace(/"\s*\+\s*\n\s*"/g, "").replace(/\\"/g, '"');
    const shared = [
      ...P.ssAiNoticeSections(true).flatMap((s) => [s.heading, ...s.lines]),
      ...P.ssAiNoticeSections(false).flatMap((s) => s.lines),
    ].filter((t) => !/phone app|Chrome extension|My Synergy Phone|here/.test(t));
    assert(shared.length >= 12, `only ${shared.length} shared sentences found`);
    for (const t of shared) {
      // The "calls" sentence is joined at run time ("...only if you allow them: " + calls).
      const parts = t.split(/(?<=allow them: |transcripts on, )/);
      for (const part of parts) assert(flat.includes(part), `phone-core no longer says: ${part}`);
    }
    // The status line on transcripts while they're on, word for word.
    assert(flat.includes(P.ssAiStatusLines({ callRecording: true, businessTranscribes: true })[1]), "the transcripts line moved in phone-core");
    // And the answer line before a first answer.
    assert(flat.includes(P.ssAiChoiceText(null)), "the not-chosen line moved in phone-core");
  },
});

// ── parseAiAnswer ──────────────────────────────────────────────────────────────────────────────

Deno.test("a save takes allowed or declined at this notice's version, and nothing else from the body", () => {
  assertEquals(parseAiAnswer({ answer: "allowed", version: AI_NOTICE_VERSION }), { ok: true, choice: "allowed", version: AI_NOTICE_VERSION });
  assertEquals(parseAiAnswer({ answer: "declined", version: AI_NOTICE_VERSION }), { ok: true, choice: "declined", version: AI_NOTICE_VERSION });
  // Whatever else rides along (someone else's id, a tenant), the parsed answer carries none of it.
  const r = parseAiAnswer({ answer: "allowed", version: AI_NOTICE_VERSION, user_id: "00000000-0000-4000-8000-0000000000ff", userId: "x", clientId: "other-builder" });
  assertEquals(r, { ok: true, choice: "allowed", version: AI_NOTICE_VERSION });
  for (const answer of [undefined, null, "", "maybe", "Allowed", "yes", true, 1, ["allowed"]]) {
    assertEquals(parseAiAnswer({ answer, version: AI_NOTICE_VERSION }), { ok: false, error: AI_CHOICE_REFUSED }, JSON.stringify(answer));
  }
  // The Worker's `choice` field is not this action's: the portal sends `answer`.
  assertEquals(parseAiAnswer({ choice: "allowed", version: AI_NOTICE_VERSION }), { ok: false, error: AI_CHOICE_REFUSED });
  for (const version of [undefined, null, "1", 1.5, 0, -1, 32768, NaN, Infinity]) {
    assertEquals(parseAiAnswer({ answer: "allowed", version }), { ok: false, error: AI_VERSION_REFUSED }, String(version));
  }
  // A whole number the Worker would take, but not the notice this server asks about: a page left
  // open across a notice change can't record a yes to words the person never saw.
  for (const version of [AI_NOTICE_VERSION + 1, AI_CONSENT_MAX_VERSION]) {
    assertEquals(parseAiAnswer({ answer: "allowed", version }), { ok: false, error: AI_NOTICE_STALE }, String(version));
  }
  assertEquals(parseAiAnswer(null), { ok: false, error: AI_CHOICE_REFUSED });
});

Deno.test("an answer to another notice version reads as not chosen, as it does in the apps", () => {
  assertEquals(currentAnswer({ choice: "allowed", version: AI_NOTICE_VERSION, at: "2026-10-14T12:00:00Z" }), "allowed");
  assertEquals(currentAnswer({ choice: "declined", version: AI_NOTICE_VERSION, at: "2026-10-14T12:00:00Z" }), "declined");
  assertEquals(currentAnswer({ choice: "allowed", version: AI_NOTICE_VERSION + 1, at: "2026-10-14T12:00:00Z" }), null);
  assertEquals(currentAnswer({ choice: null, version: null, at: null }), null);
  assertEquals(currentAnswer(null), null);
  assertEquals(consentOut({ ai_transcripts: "maybe", ai_transcripts_version: 1, ai_transcripts_at: "x" }), { choice: null, version: null, at: null });
  assert(allowsAi({ ai_transcripts: "allowed", ai_transcripts_version: 1 }));
  assert(!allowsAi({ ai_transcripts: "declined", ai_transcripts_version: 1 }));
  assert(!allowsAi({ ai_transcripts: "allowed", ai_transcripts_version: null }));
});

// ── The module against a stub database ─────────────────────────────────────────────────────────

type Call = { table: string; op: string; args: unknown[] };
/** A chainable stub: every call is recorded; the terminal (maybeSingle / single) answers from `answers`. */
function stubDb(answers: Record<string, { data?: unknown; error?: unknown }>) {
  const calls: Call[] = [];
  const db: AiTranscriptsDb = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = (op: string) => (...args: unknown[]) => { calls.push({ table, op, args }); return q; };
      for (const op of ["select", "eq", "in", "upsert", "update", "insert", "delete", "neq", "is"]) q[op] = chain(op);
      const end = (op: string) => () => { calls.push({ table, op, args: [] }); return Promise.resolve({ data: null, error: null, ...(answers[table] ?? {}) }); };
      q.maybeSingle = end("maybeSingle");
      q.single = end("single");
      return q;
    },
  };
  return { db, calls };
}
const RAILS_ON = { recording: true, transcribe: true };

Deno.test("the read: the session's own row only, and the business's facts", async () => {
  const { db, calls } = stubDb({
    phone_user_settings: { data: { ai_transcripts: "allowed", ai_transcripts_version: 1, ai_transcripts_at: "2026-10-14T12:00:00Z" } },
    client_settings: { data: { phone_record_calls: true, phone_transcribe_calls: true } },
  });
  const out = await readAiTranscripts(db, { userId: USER, clientId: CLIENT }, RAILS_ON);
  assertEquals(out, { consent: { choice: "allowed", version: 1, at: "2026-10-14T12:00:00Z" }, callRecording: true, businessTranscribes: true });
  const mine = calls.filter((c) => c.table === "phone_user_settings");
  assertEquals(mine.map((c) => [c.op, c.args]), [["select", [AI_CONSENT_COLUMNS]], ["eq", ["user_id", USER]], ["maybeSingle", []]]);
  const biz = calls.filter((c) => c.table === "client_settings");
  assertEquals(biz.map((c) => [c.op, c.args]), [["select", ["phone_record_calls, phone_transcribe_calls"]], ["eq", ["client_id", CLIENT]], ["maybeSingle", []]]);
  assert(!calls.some((c) => ["upsert", "update", "insert", "delete"].includes(c.op)), "a read wrote something");
});

Deno.test("the read in view-as never reads the person's row (it would be the operator's)", async () => {
  const { db, calls } = stubDb({ client_settings: { data: { phone_record_calls: true } } });
  const out = await readAiTranscripts(db, { userId: USER, clientId: CLIENT }, RAILS_ON, false);
  assertEquals(out, { consent: null, callRecording: true, businessTranscribes: true });
  assert(!calls.some((c) => c.table === "phone_user_settings"), "view-as read the operator's own row");
});

Deno.test("never answered reads as null; a database before 307 says so; a real fault is a fault", async () => {
  const none = await readAiTranscripts(stubDb({ phone_user_settings: { data: null }, client_settings: { data: null } }).db, { userId: USER, clientId: CLIENT }, RAILS_ON);
  assertEquals(none, { consent: { choice: null, version: null, at: null }, callRecording: false, businessTranscribes: false });
  for (const code of ["42703", "42P01", "PGRST204", "PGRST205"]) {
    const nr = await readAiTranscripts(stubDb({ phone_user_settings: { error: { code, message: "column does not exist" } } }).db, { userId: USER, clientId: CLIENT }, RAILS_ON);
    assertEquals(nr, { notReady: true }, code);
  }
  const bad = await readAiTranscripts(stubDb({ phone_user_settings: { error: { code: "57014", message: "canceling statement" } } }).db, { userId: USER, clientId: CLIENT }, RAILS_ON);
  assertEquals(bad, { dbError: { code: "57014", message: "canceling statement" } });
  const bizBad = await readAiTranscripts(stubDb({ client_settings: { error: { code: "08006", message: "connection failure" } } }).db, { userId: USER, clientId: CLIENT }, RAILS_ON);
  assertEquals(bizBad, { dbError: { code: "08006", message: "connection failure" } });
  // A session user id that isn't a uuid never reaches the database.
  const odd = stubDb({});
  assert("dbError" in await readAiTranscripts(odd.db, { userId: "not-a-uuid", clientId: CLIENT }, RAILS_ON));
  assertEquals(odd.calls.length, 0);
});

Deno.test("the business's facts follow the Worker's transcriptsFor: switch AND rail, transcripts default on", () => {
  const cases: [Record<string, unknown> | null, { recording: boolean; transcribe: boolean }, boolean, boolean][] = [
    [{ phone_record_calls: true, phone_transcribe_calls: true }, RAILS_ON, true, true],
    [{ phone_record_calls: true }, RAILS_ON, true, true], // transcripts' column defaults on
    [{ phone_record_calls: true, phone_transcribe_calls: null }, RAILS_ON, true, true],
    [{ phone_record_calls: true, phone_transcribe_calls: false }, RAILS_ON, true, false],
    [{ phone_record_calls: false, phone_transcribe_calls: true }, RAILS_ON, false, false],
    [{ phone_record_calls: true, phone_transcribe_calls: true }, { recording: false, transcribe: true }, false, false],
    [{ phone_record_calls: true, phone_transcribe_calls: true }, { recording: true, transcribe: false }, true, false],
    [{ phone_record_calls: "true" }, RAILS_ON, false, false],
    [null, RAILS_ON, false, false],
  ];
  for (const [row, rails, rec, tr] of cases) {
    assertEquals(businessFacts(row, rails), { callRecording: rec, businessTranscribes: tr }, JSON.stringify([row, rails]));
  }
});

Deno.test("the save: an upsert of the session's own row, the Worker's write, read back", async () => {
  const at = "2026-10-14T15:30:00.000Z";
  const { db, calls } = stubDb({ phone_user_settings: { data: { ai_transcripts: "declined", ai_transcripts_version: 1, ai_transcripts_at: at } } });
  const out = await saveAiTranscripts(db, { userId: USER, clientId: CLIENT }, { choice: "declined", version: 1 }, new Date(at));
  assertEquals(out, { consent: { choice: "declined", version: 1, at } });
  assertEquals(calls.map((c) => [c.table, c.op]), [["phone_user_settings", "upsert"], ["phone_user_settings", "select"], ["phone_user_settings", "single"]]);
  assertEquals(calls[0].args, [{
    user_id: USER, client_id: CLIENT, updated_at: at,
    ai_transcripts: "declined", ai_transcripts_version: 1, ai_transcripts_at: at,
  }, { onConflict: "user_id" }]);
  assertEquals(calls[1].args, [AI_CONSENT_COLUMNS]);
  // What the database holds is what comes back, whatever was asked: the card compares the two.
  const drifted = await saveAiTranscripts(stubDb({ phone_user_settings: { data: null } }).db, { userId: USER, clientId: CLIENT }, { choice: "allowed", version: 1 });
  assertEquals(drifted, { consent: { choice: null, version: null, at: null } });
  assertEquals(
    await saveAiTranscripts(stubDb({ phone_user_settings: { error: { code: "42703", message: "no column" } } }).db, { userId: USER, clientId: CLIENT }, { choice: "allowed", version: 1 }),
    { notReady: true },
  );
  const odd = stubDb({});
  assert("dbError" in await saveAiTranscripts(odd.db, { userId: "", clientId: CLIENT }, { choice: "allowed", version: 1 }));
  assertEquals(odd.calls.length, 0, "a save with no session user reached the database");
});

// ── The wiring in portal-settings/index.ts ─────────────────────────────────────────────────────

const GATES_SRC = slice(SETTINGS, "const GATES: GateTable = {", "\n};", "the GATES table");
const gateOf = (name: string): Gate => {
  const m = new RegExp(`\\n\\s*${name}:\\s*("open"|"self")\\s*,`).exec(GATES_SRC);
  if (!m) throw new Error(`GATES has no "open"/"self" line for ${name}`);
  return JSON.parse(m[1]) as Gate;
};
const BRANCH = slice(SETTINGS, 'if (action === "ai_transcripts_get" || action === "ai_transcripts_save") {', "\n  }\n", "the ai_transcripts branch");

Deno.test("GATES: the read is open to anyone on the team (a read-only operator too); the save is a self-write", () => {
  const get = gateOf("ai_transcripts_get");
  const save = gateOf("ai_transcripts_save");
  assertEquals(get, "open");
  assertEquals(save, "self");
  // What resolveTenant makes of them: nobody's area map stops either (a driver with every area
  // "none" still answers for their own calls); the read is a READ (a read-only operator's view-as
  // isn't refused), the save is a WRITE (it is).
  const NOTHING = { phone: "none", contacts: "none", settings_team: "none" } as Record<string, "none">;
  assertEquals(checkGate(get, NOTHING), null);
  assertEquals(checkGate(save, NOTHING), null);
  assert(gateIsRead(get));
  assert(!gateIsRead(save));
});

Deno.test("the branch: view-as refused before any write; both keyed off the session; nothing taken from the body", () => {
  const save = slice(BRANCH, 'if (action === "ai_transcripts_save") {', "\n    }\n", "the save half");
  const refuse = save.indexOf("if (operator) return refusal(AI_TRANSCRIPTS_VIEW_AS, 403);");
  assert(refuse >= 0, "the save no longer refuses an operator in view-as");
  assert(refuse < save.indexOf("parseAiAnswer(") && refuse < save.indexOf("saveAiTranscripts("), "the view-as refusal must come before the parse and the write");
  // The refusal is marked as one (so a view-as press isn't filed as a fault) and exposed.
  assert(/r\.headers\.set\(SS_REFUSAL_HEADER, "1"\)/.test(BRANCH) && /Access-Control-Expose-Headers/.test(BRANCH));
  // The person is the session's: userId and the resolved clientId, never a body field.
  assert(BRANCH.includes('const who = { userId: String(userId ?? ""), clientId };'), "who is no longer the session's user and tenant");
  assert(!/payload\??\.(user_?[iI]d|clientId|client_id|targetUser)/.test(BRANCH), "the branch reads a person or tenant from the body");
  // The read never touches the operator's own row in view-as.
  assert(BRANCH.includes("readAiTranscripts(admin, who, rails, !operator)"), "the read no longer skips the person's row in view-as");
  // The answer shown is the current one (version-aware), and the owner pointer is phone_recording_save's rule.
  assert(BRANCH.includes("currentAnswer(saved.consent)") && BRANCH.includes("currentAnswer(read.consent)"));
  assert(BRANCH.includes('canChangeRecording: role === "owner" && canEdit("phone")'));
  assert(SETTINGS.includes('if (role !== "owner") return json({ error: "Only the business owner can change call recording." }, 403);'),
    "phone_recording_save's owner rule moved; re-check canChangeRecording");
});

Deno.test("the refusal sentences say what happened, plainly", () => {
  assert(/viewing another account/.test(AI_TRANSCRIPTS_VIEW_AS));
  assert(/isn't set up on this server yet/.test(AI_TRANSCRIPTS_NOT_READY));
  assert(/Reload it/.test(AI_NOTICE_STALE));
});

// ── The card's words ───────────────────────────────────────────────────────────────────────────

Deno.test("the card's lines: recording, transcripts only with everyone's yes, voicemails by Twilio", () => {
  const on = P.ssAiStatusLines({ callRecording: true, businessTranscribes: true });
  assertEquals(on.length, 3);
  assert(/recorded by Twilio, our calling provider, unless the business owner turns recording off/.test(on[0]));
  assert(/Cloudflare Workers AI and summarized by Anthropic's Claude, but only when everyone from your team on the call allowed it/.test(on[1]));
  assertEquals(on[2], "Voicemails are turned into text by Twilio.");
  const off = P.ssAiStatusLines({ callRecording: false, businessTranscribes: false });
  assert(/aren't recorded right now/.test(off[0]) && /aren't transcribed or summarized right now/.test(off[1]));
  assert(/You allowed it/.test(P.ssAiChoiceText("allowed")));
  assert(/You said no/.test(P.ssAiChoiceText("declined")));
  assert(/You haven't chosen yet/.test(P.ssAiChoiceText(null)));
  // The notice names every service and where the answer counts, before the first answer.
  const all = P.ssAiNoticeSections(true).flatMap((s) => [s.heading, ...s.lines]).join(" ");
  for (const must of ["Twilio", "Cloudflare Workers AI", "Anthropic", "Claude", "don't train AI models", "everyone from your team",
    "My Synergy Phone app", "Chrome extension", "deleted with its recording"]) {
    assert(all.includes(must), `the notice no longer says "${must}"`);
  }
  // Structure Studio's own screens don't hide summaries, so the card never says they do.
  assert(!/Structure Studio (shows|hides)|hidden in Structure Studio/.test(all + P.ssAiChoiceText("declined")));
});
