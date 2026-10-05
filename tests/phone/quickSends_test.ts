// Quick sends in the portal (Carolyn 2026-09-30: "quick sends on text and email, both of them").
// The record's Email and SMS boxes get a Quick sends picker over the SAME per-person list My
// Synergy Phone keeps (migration 258). What this file holds:
//   * the portal's copy of the fill-in rules (portal/01-core.jsx, ssFillQuickSend and friends) to
//     every phone-core case (quickSendCases.mjs), lifted out of the SHIPPED source; and, when the
//     phone repo is checked out beside this one (or SS_PHONE_CORE_DIR names its packages/phone-core),
//     to phone-core's own fillQuickSend on a seeded corpus far past the hand-written cases;
//   * portal-settings/quickSends.ts against a stub database: the seed first and never fatal, both
//     reads narrowed to the session's person AND tenant, the count on the caller's own row, a
//     non-uuid id refused before Postgres;
//   * the wiring, read off the shipped sources: "self" gates, the view-as refusal ahead of either
//     action, nothing from the body but the one id, the shell's quickSendsOn={!viewing}, and
//     Insert never reaching a send.
// The browser half (the picker on the COMPILED portal) is tests/harness/crmQuickSends.mjs.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  countQuickSendUse, QUICK_SEND_COLUMNS, QUICK_SEND_LIST_LIMIT, QUICK_SEND_NOT_FOUND, QUICK_SENDS_VIEW_AS, quickSendOut,
  readQuickSends, type QuickSendDb,
} from "../../supabase/functions/portal-settings/quickSends.ts";
import { FILL_CASES, FUZZ_FILLS, fuzzBodies, INSERT_CASES, pickerList, TOO_LONG } from "./quickSendCases.mjs";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
/** Whole-line `//` comments removed, so a comment that NAMES a thing cannot satisfy a check. */
const code = (src: string) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const CORE = await read("../../portal/01-core.jsx");
const SALES = await read("../../portal/02-sales.jsx");
const SHELL = await read("../../portal/12-shell.jsx");
const SETTINGS = code(await read("../../supabase/functions/portal-settings/index.ts"));
const WORKER = await read("../../workers/phone-api/src/routes/quickSends.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`quickSends_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

// ── The portal's helpers, lifted out of the shipped source ──────────────────────────────────
type Fill = { contactName?: string | null; myName?: string | null };
type QS = { id: string; name: string; body: string; category: string | null; sort_order: number; usage_count: number };
type Helpers = {
  ssFillQuickSend: (body: unknown, fill: Fill) => string;
  ssInsertIntoDraft: (draft: unknown, text: unknown) => string;
  ssInsertQuickSend: (draft: string, q: { body: string }, fill: Fill, channel: string) => string | null;
  ssQuickSendChips: (list: QS[]) => { category: string | null; label: string }[];
  ssQuickSendsIn: (list: QS[], category: string | null) => QS[];
  ssQuickSendTooLong: (channel: string) => string;
  SS_QUICK_SEND_MAX: { sms: number; email: number };
};
const REGION = slice(CORE, "const SS_QUICK_SEND_TOKEN_RE", "window.__ssQuickSends = ", "the quick-send helpers in 01-core.jsx");
const H = new Function(`${REGION}
  return { ssFillQuickSend, ssInsertIntoDraft, ssInsertQuickSend, ssQuickSendChips, ssQuickSendsIn, ssQuickSendTooLong, SS_QUICK_SEND_MAX };`)() as Helpers;

Deno.test("the portal fills a quick send exactly as phone-core does, case for case", () => {
  assert(FILL_CASES.length >= 30, "the case list is whole");
  for (const [what, body, fill, want] of FILL_CASES as [string, string, Fill, string][]) {
    assertEquals(H.ssFillQuickSend(body, fill), want, what);
  }
});

Deno.test("Insert puts the text in an empty box, or after what's typed with one space, as phone-core does", () => {
  for (const [draft, text, want] of INSERT_CASES as [string, string, string][]) {
    assertEquals(H.ssInsertIntoDraft(draft, text), want, JSON.stringify([draft, text]));
  }
});

Deno.test("the picker's chips and rows follow the app: All · N, then categories in first-appearance order", () => {
  const list = pickerList() as QS[];
  assertEquals(H.ssQuickSendChips(list), [
    { category: null, label: "All · 6" },
    { category: "Follow-ups", label: "Follow-ups" },
    { category: "Openers", label: "Openers" },
    { category: "Closers", label: "Closers" },
  ]);
  assertEquals(H.ssQuickSendChips([]), [{ category: null, label: "All · 0" }]);
  assertEquals(H.ssQuickSendChips([{ ...list[1] }, { ...list[1], id: "z", category: "  " }]), [{ category: null, label: "All · 2" }]);
  assertEquals(H.ssQuickSendsIn(list, null).map((q) => q.id), ["a", "b", "c", "d", "e", "f"]);
  assertEquals(H.ssQuickSendsIn(list, "Openers").map((q) => q.id), ["c", "f"]);
  assertEquals(H.ssQuickSendsIn(list, "Follow-ups").map((q) => q.id), ["a", "d"]);
  // A chip whose last quick send is gone falls back to All.
  assertEquals(H.ssQuickSendsIn(list.filter((q) => q.category !== "Closers"), "Closers").length, 5);
});

Deno.test("Insert refuses one that would run past the box rather than cutting it; an email holds far more than a text", () => {
  const fill = { contactName: "Alex Smith", myName: "Jordan Lee" };
  const q = { body: "Hey {first_name}, this is a" };
  assertEquals(H.SS_QUICK_SEND_MAX, { sms: 1600, email: 20000 });
  assertEquals(H.ssInsertQuickSend("", q, fill, "email"), "Hey Alex, this is a");
  assertEquals(H.ssInsertQuickSend("Thanks!  ", q, fill, "sms"), "Thanks! Hey Alex, this is a");
  const long = "x".repeat(1600 - 5);
  assertEquals(H.ssInsertQuickSend(long, q, fill, "sms"), null);
  assertEquals(H.ssInsertQuickSend(long, q, fill, "email"), `${long} Hey Alex, this is a`);
  // Exactly the limit still fits.
  const filled = "Hey Alex, this is a";
  assertEquals(H.ssInsertQuickSend("x".repeat(1600 - filled.length - 1), q, fill, "sms")?.length, 1600);
  assertEquals(H.ssInsertQuickSend("x".repeat(20000 - 5), q, fill, "email"), null);
  assertEquals(H.ssQuickSendTooLong("sms"), TOO_LONG.sms);
  assertEquals(H.ssQuickSendTooLong("email"), TOO_LONG.email);
});

// ── Against phone-core itself, when it is here ──────────────────────────────────────────────
// The phone repo is private and separate, so this runs only where it is checked out: beside this
// repo (../structure-studio-phone) or wherever SS_PHONE_CORE_DIR points (its packages/phone-core).
async function phoneCore(): Promise<{ fillQuickSend: Helpers["ssFillQuickSend"]; insertIntoDraft: Helpers["ssInsertIntoDraft"] } | null> {
  const dir = Deno.env.get("SS_PHONE_CORE_DIR");
  const url = dir
    ? new URL(`file:///${dir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/?$/, "/")}src/quickSends.ts`)
    : new URL("../../../structure-studio-phone/packages/phone-core/src/quickSends.ts", import.meta.url);
  try {
    await Deno.stat(url);
  } catch (_) {
    return null;
  }
  return await import(url.href);
}
const CORE_PKG = await phoneCore();

Deno.test({
  name: "against phone-core's own fillQuickSend and insertIntoDraft: every case, and a seeded corpus",
  ignore: !CORE_PKG,
  fn: () => {
    const pc = CORE_PKG!;
    let n = 0;
    for (const [what, body, fill] of FILL_CASES as [string, string, Fill, string][]) {
      assertEquals(H.ssFillQuickSend(body, fill), pc.fillQuickSend(body, fill), what);
      n++;
    }
    for (const body of fuzzBodies()) {
      for (const fill of FUZZ_FILLS) {
        assertEquals(H.ssFillQuickSend(body, fill), pc.fillQuickSend(body, fill), JSON.stringify({ body, fill }));
        n++;
      }
    }
    for (const [draft, text] of INSERT_CASES as [string, string, string][]) {
      assertEquals(H.ssInsertIntoDraft(draft, text), pc.insertIntoDraft(draft, text));
      n++;
    }
    assert(n > 2000, `${n} comparisons`);
  },
});

// ── portal-settings/quickSends.ts against a stub database ───────────────────────────────────
const U = "00000000-0000-4000-8000-0000000000a1";
const C = "acme-sheds";
const QS_ID = "3f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b";
type Step = [string, unknown[]];
type Logged = { rpc: string; args: Record<string, unknown> } | { table: string; steps: Step[] };

function stubDb(o: {
  seed?: { error: unknown } | "throw";
  list?: { data: unknown; error: unknown };
  me?: { data: unknown; error: unknown };
  used?: { data: unknown; error: unknown };
} = {}) {
  const log: Logged[] = [];
  const db: QuickSendDb = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      log.push({ rpc: fn, args });
      if (fn === "phone_seed_quick_sends") {
        if (o.seed === "throw") return Promise.reject(new Error("socket hang up"));
        return Promise.resolve({ data: 0, error: null, ...(o.seed ?? {}) });
      }
      return Promise.resolve(o.used ?? { data: true, error: null });
    },
    from: (table: string) => {
      const entry = { table, steps: [] as Step[] };
      log.push(entry);
      const result = table === "phone_quick_sends" ? (o.list ?? { data: [], error: null }) : (o.me ?? { data: { full_name: "Jordan Lee" }, error: null });
      // deno-lint-ignore no-explicit-any
      const q: any = {};
      for (const m of ["select", "eq", "order", "limit", "maybeSingle"]) {
        q[m] = (...args: unknown[]) => { entry.steps.push([m, args]); return q; };
      }
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return q;
    },
  };
  return { db, log };
}
const tableSteps = (log: Logged[], t: string) => (log.find((l) => "table" in l && l.table === t) as { steps: Step[] } | undefined)?.steps;

Deno.test("the list: the starter set first, then the caller's own rows, narrowed to person AND tenant, in order", async () => {
  const row = { id: QS_ID, name: "Check in", body: "Hey {first_name}", category: "Follow-ups", sort_order: 2, usage_count: 3, user_id: "x", client_id: "y" };
  const { db, log } = stubDb({ list: { data: [row], error: null }, me: { data: { full_name: "  Jordan Lee " }, error: null } });
  const seeded: string[] = [];
  const out = await readQuickSends(db, { userId: U, clientId: C }, (why) => { seeded.push(why); });
  assertEquals(out, { quick_sends: [{ id: QS_ID, name: "Check in", body: "Hey {first_name}", category: "Follow-ups", sort_order: 2, usage_count: 3 }], my_name: "Jordan Lee" });
  assertEquals(seeded, [], "a seed that worked reports nothing");
  // The seed ran first, with the session's pair.
  assertEquals(log[0], { rpc: "phone_seed_quick_sends", args: { p_user: U, p_client: C } });
  assertEquals(tableSteps(log, "phone_quick_sends"), [
    ["select", [QUICK_SEND_COLUMNS]],
    ["eq", ["user_id", U]],
    ["eq", ["client_id", C]],
    ["order", ["sort_order", { ascending: true }]],
    ["order", ["created_at", { ascending: true }]],
    ["limit", [QUICK_SEND_LIST_LIMIT]],
  ]);
  // {my_name}: this person's row on THIS tenant, one row.
  assertEquals(tableSteps(log, "client_users"), [
    ["select", ["full_name"]],
    ["eq", ["user_id", U]],
    ["eq", ["client_id", C]],
    ["limit", [1]],
    ["maybeSingle", []],
  ]);
  assertEquals(log.filter((l) => "rpc" in l).length, 1, "nothing else is called");
});

Deno.test("a seed that fails is reported and never costs the list (the phone's seed() rule)", async () => {
  for (const seed of [{ error: { message: "permission denied" } }, "throw" as const]) {
    const { db } = stubDb({ seed, list: { data: [{ id: QS_ID, name: "A", body: "B", category: null, sort_order: 0, usage_count: 0 }], error: null } });
    const seen: string[] = [];
    const out = await readQuickSends(db, { userId: U, clientId: C }, (why) => { seen.push(why); });
    assert("quick_sends" in out && out.quick_sends.length === 1, "the list still comes back");
    assertEquals(seen.length, 1);
    assert(/permission denied|socket hang up/.test(seen[0]), seen[0]);
  }
  // A logger that throws is swallowed too.
  const { db } = stubDb({ seed: { error: { message: "x" } } });
  const out = await readQuickSends(db, { userId: U, clientId: C }, () => { throw new Error("log down"); });
  assert("quick_sends" in out);
});

Deno.test("a list that can't be read is a database failure; a name that can't be read is just no {my_name}", async () => {
  const bad = await readQuickSends(stubDb({ list: { data: null, error: { message: "boom", code: "XX000" } } }).db, { userId: U, clientId: C }, () => {});
  assertEquals(bad, { dbError: { message: "boom", code: "XX000" } });
  const noName = await readQuickSends(stubDb({ me: { data: null, error: { message: "nope" } } }).db, { userId: U, clientId: C }, () => {});
  assertEquals(noName, { quick_sends: [], my_name: "" });
  const missing = await readQuickSends(stubDb({ me: { data: null, error: null } }).db, { userId: U, clientId: C }, () => {});
  assertEquals(missing, { quick_sends: [], my_name: "" });
});

Deno.test("each row goes out as the app sees it, whatever the database hands back", () => {
  assertEquals(quickSendOut({ id: QS_ID, name: "A", body: "B" }), { id: QS_ID, name: "A", body: "B", category: null, sort_order: 0, usage_count: 0 });
  assertEquals(quickSendOut({ id: QS_ID, name: "A", body: "B", category: "C", sort_order: "4" as unknown as number, usage_count: null as unknown as number }),
    { id: QS_ID, name: "A", body: "B", category: "C", sort_order: 4, usage_count: 0 });
});

Deno.test("used: counted on the caller's own row; anything else is not found, a non-uuid before Postgres sees it", async () => {
  const ok = stubDb();
  assertEquals(await countQuickSendUse(ok.db, QS_ID, { userId: U, clientId: C }), "counted");
  assertEquals(ok.log, [{ rpc: "phone_quick_send_used", args: { p_id: QS_ID, p_user: U, p_client: C } }]);

  for (const data of [false, null, 0, "true"]) {
    assertEquals(await countQuickSendUse(stubDb({ used: { data, error: null } }).db, QS_ID, { userId: U, clientId: C }), "not_found", String(data));
  }
  for (const id of [undefined, null, "", "qs-1", "a/b", 7, `${QS_ID}x`, { id: QS_ID }]) {
    const s = stubDb();
    assertEquals(await countQuickSendUse(s.db, id, { userId: U, clientId: C }), "not_found", JSON.stringify(id));
    assertEquals(s.log.length, 0, "nothing reaches the database");
  }
  const err = await countQuickSendUse(stubDb({ used: { data: null, error: { message: "down" } } }).db, QS_ID, { userId: U, clientId: C });
  assertEquals(err, { dbError: { message: "down" } });
});

Deno.test("the module says what the phone-api Worker says, and reads as far", () => {
  assert(WORKER.includes(`new ApiError("not_found", "${QUICK_SEND_NOT_FOUND}")`), "the not-found sentence matches the Worker's word for word");
  assert(WORKER.includes(`const LIST_LIMIT = ${QUICK_SEND_LIST_LIMIT};`), "the same list limit as the Worker");
  for (const col of QUICK_SEND_COLUMNS.split(", ")) assert(WORKER.includes(col), `the Worker reads ${col} too`);
});

// ── The wiring, read off the shipped sources ────────────────────────────────────────────────
Deno.test("GATES: both actions are \"self\", neither is a crm_ action nor per contact", () => {
  const gates = slice(SETTINGS, "const GATES: GateTable = {", "\n};", "GATES");
  assert(/\n\s*quick_sends_list: "self",\n/.test(gates), "quick_sends_list is self");
  assert(/\n\s*quick_send_used: "self",\n/.test(gates), "quick_send_used is self");
  const scope = slice(SETTINGS, "const CONTACT_ROW_SCOPE:", "\n  };", "CONTACT_ROW_SCOPE");
  assert(!/quick_send/.test(scope), "no contact row scope: these are per person");
});

Deno.test("the branch refuses an operator in view-as before either action runs, and keys only off the session", () => {
  const branch = slice(SETTINGS, `if (action === "quick_sends_list" || action === "quick_send_used") {`, `if (action === "crm_send_email") {`, "the quick sends branch");
  const refuse = branch.indexOf("if (operator) {");
  assert(refuse > 0, "operators are refused");
  assert(refuse < branch.indexOf("readQuickSends(") && refuse < branch.indexOf("countQuickSendUse("), "before anything is read, seeded or counted");
  assert(branch.includes("json({ error: QUICK_SENDS_VIEW_AS }, 403)"), "a 403 with the sentence");
  assert(branch.includes(`r.headers.set(SS_REFUSAL_HEADER, "1");`) && branch.includes(`r.headers.set("Access-Control-Expose-Headers", SS_REFUSAL_HEADER);`),
    "marked as a refusal, and the mark exposed so the browser can read it");
  assert(branch.includes("const who = { userId, clientId };"), "the pair is the session's");
  const fromBody = [...branch.matchAll(/payload\??\.([a-zA-Z_]+)/g)].map((m) => m[1]);
  assertEquals(fromBody, ["id"], "the one quick send's id is the only thing read from the body");
  assert(branch.includes(`code: "quick_send_seed_failed", severity: "warn"`), "a failed seed is logged as a warning, not a fault");
  assert(branch.includes(`return json({ error: QUICK_SEND_NOT_FOUND }, 404);`), "an id that isn't theirs is a 404");
  assert(!/sendTenant(Email|Sms)|crm_send/.test(branch), "nothing here sends");
  assert(QUICK_SENDS_VIEW_AS.includes("viewing another account"));
});

Deno.test("the shell offers quick sends only outside view-as", () => {
  const mount = slice(SHELL, "<CrmRecord\n", "/>", "the CrmRecord mount");
  assert(mount.includes("quickSendsOn={!viewing}"), "quickSendsOn={!viewing}");
});

Deno.test("the record reads the list only when a picker opens, and Insert never sends", () => {
  const head = slice(SALES, "function CrmRecord(", "const [data, setData] = useState(null);", "CrmRecord's props");
  // Not pinned to the end of the props list: later props (cardOrder, 2026-10-05) follow it.
  assert(/\bquickSendsOn = false[,\s}]/.test(head), "off unless the shell says so");
  // The list is read in loadQuickSends and nowhere else; loadQuickSends runs only as a picker's onOpen.
  assertEquals(SALES.split(`action: "quick_sends_list"`).length - 1, 1, "one read");
  const load = slice(SALES, "const loadQuickSends = async () => {", "const insertQuickSend = ", "loadQuickSends");
  assert(load.includes(`action: "quick_sends_list"`));
  const refs = [...SALES.matchAll(/loadQuickSends\b[^\n]*/g)].map((m) => m[0]);
  assertEquals(refs.length, 3, refs.join(" | "));
  assert(refs.slice(1).every((r) => r.startsWith("loadQuickSends}")), "both other mentions are onOpen={loadQuickSends}");
  assert(/onOpen=\{loadQuickSends\}/.test(SALES));
  // Insert: body only, subject kept, and no send anywhere in it.
  const insert = slice(SALES, "const insertQuickSend = (q, channel) => {", "const renderSection = ", "insertQuickSend");
  assert(insert.includes("if (email) setMail((p) => ({ ...p, body: next })); else setText(next);"), "the body (or the text box), never the subject");
  assert(insert.includes(`action: "quick_send_used", id: q.id`), "the use is counted with that id");
  assert(insert.includes("if (next === null) { say({ err: ssQuickSendTooLong(channel) }); return; }"), "too long is refused, the box untouched");
  assert(!/crm_send_(email|sms)|sendEmail\(|sendSms\(/.test(insert), "Insert never sends");
  // The picker itself only calls what it is handed.
  const picker = slice(SALES, "function CrmQuickSendPicker(", "// The record page. One component", "CrmQuickSendPicker");
  assert(!/sb\.functions|crm_send/.test(picker), "the picker makes no calls of its own");
  assert(picker.includes("Inserting fills the box. Sending is yours."), "Carolyn's line");
  assert(picker.includes("No quick sends yet. Add them in My Synergy Phone, under Settings → Quick sends."), "the empty state says where to add them");
  // Both boxes, both behind quickSendsOn.
  assertEquals((SALES.match(/\{quickSendsOn && \(\n\s*<CrmQuickSendPicker channel="(email|sms)"/g) ?? []).length, 2);
});
