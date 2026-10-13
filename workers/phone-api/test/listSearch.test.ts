// List search (2026-10-13): POST /threads/search, POST /calls/search and GET /calls?voicemail=1.
// Asked for 2026-10-12: Messages searched "by anything in the message ... the names of the
// person, or the phone number", the same on Voicemail, and Recents "to see if I ever called this
// number", in both My and Team. The phone repo's docs/SPEC.md section 3 "List search" is the
// contract. Every table here answers through pgTable (helpers.ts), which honours the filters the
// Worker sends, so a filter it forgets is a wrong answer, not a passing test.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Auth, BUSINESS_NUMBER, CLIENT, CONTACT_1, CONTACT_2, CUSTOMER, FakeNet, USER_A, USER_B,
  appRequest, call, callerCtx, jsonRes, makeEnv, pgTable,
} from "./helpers";
import { listSearchDigits, listSearchTerm, snippetAround, termPattern } from "../src/routes/reads";

type Row = Record<string, unknown>;
const T = (min: number) => new Date(Date.UTC(2026, 9, 12, 15, 0) - min * 60_000).toISOString();
const S = (sec: number) => new Date(Date.UTC(2026, 9, 12, 15, 0) - sec * 1000).toISOString();
const CONTACT_3 = "00000000-0000-4000-8000-00000000c003";
const CONTACT_4 = "00000000-0000-4000-8000-00000000c004";
const OTHER_TENANT = "other-tenant";
const UNKNOWN = "+15555550150";

const person = (id: string, name: string | null, over: Row = {}): Row => ({
  id, client_id: CLIENT, merged_into: null, name, owner_user_id: null, phone: null, phone_digits: null, updated_at: T(0), ...over,
});
const text = (id: string, over: Row): Row => ({
  id, client_id: CLIENT, contact_id: null, direction: "in", body: `text ${id}`, status: "received", created_at: T(1),
  from_number: CUSTOMER, to_number: BUSINESS_NUMBER, sent_by: null, ...over,
});

interface World { sms?: Row[]; contacts?: Row[]; calls?: Row[] }

// The searches log counts on every request; keep the test output readable. The privacy tests
// spy on it again and read what was said.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// One login key for the whole file: a test that sets up more than one world would otherwise
// present a key the Worker has not seen, and unknown keys are refetched at most every 30 s.
let shared: Auth | null = null;

async function setup(ctx: Row, w: World = {}, visible: string[] | null = null) {
  const net = new FakeNet().install();
  const auth = (shared ??= await new Auth().init());
  auth.serve(net);
  net.rpc("phone_caller_context", () => ctx);
  net.rpc("crm_visible_contact_ids", (s) => (visible ? (s.json.p_ids as string[]).filter((id) => visible.includes(id)) : s.json.p_ids));
  net.rest("GET", "sms_messages", pgTable(w.sms ?? []));
  net.rest("GET", "crm_contacts", pgTable(w.contacts ?? []));
  net.rest("GET", "phone_calls", pgTable(w.calls ?? []));
  net.rest("GET", "phone_call_events", () => []);
  net.rest("POST", "app_errors", () => []);
  return { net, token: await auth.token(USER_A), env: makeEnv() };
}

const searchThreads = (token: string, body: unknown) => appRequest("POST", "/threads/search", token, body);
/** A contact id per number, for worlds of many contacts. */
const uuidOf = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** Every page of a search or a list, following the cursor: the ids in order, and how many pages it took. */
async function allPages(env: ReturnType<typeof makeEnv>, page: (cursor: string | undefined) => Request) {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const { json } = await call(env, page(cursor));
    expect(json.ok).toBe(true);
    const rows = (json.calls ?? json.threads) as { id?: string; key?: string }[];
    expect(rows.length).toBeLessThanOrEqual(50);
    seen.push(...rows.map((r) => String(r.id ?? r.key)));
    cursor = json.cursor;
    pages++;
  } while (cursor && pages < 20);
  return { seen, pages };
}
const searchCalls = (token: string, body: unknown) => appRequest("POST", "/calls/search", token, body);
const keys = (list: { key: string }[]) => list.map((t) => t.key);
const ids = (list: { id: string }[]) => list.map((c) => c.id);

// ── The term ─────────────────────────────────────────────────────────────────────────────────

/** Terms the Worker and phone-core must decide alike (the parity test below runs every one). */
const TERM_CASES: string[] = [
  "+1", "+1 ", "(8", "#5", "$5", "a+", "?!", "👍👍", "a", "", "   ", "#", "ab", "__", "..", "'@", "--",
  "  shed   porch ", "+1 816", "(816)", "(816) 555-01", "O'Neil", "José", "a@b", "lean),to*(", "lean-to, 12x24!", "  *  ,( ",
  "x\u00a0y", "\u00a0\u00a0z", "e\u0301", "日本", "١٢", "\t\nab\r\n", "😀a", "a😀", "😀ab",
  // Long ones: the apps cut to 60 BEFORE cleaning, so what lies past the cut never counts.
  "!".repeat(60) + "ab", "a".repeat(59) + "\u{1D400}", "a".repeat(80), " ".repeat(10) + "ab" + "!".repeat(70), "b" + "!".repeat(58) + "cd",
];
const TOO_SHORT = "Type at least 2 characters to search.";

describe("the term", () => {
  it("is phone-core's term: cut to 60 as the apps send it, then cleaned, and under 2 characters either way is refused", () => {
    // What the apps hold back without asking (phone-core listSearchTerm, 2026-10-13).
    for (const q of ["+1", "+1 ", "(8", "#5", "$5", "a+", "?!", "👍👍", "a", "", "   ", "  *  ,( "]) expect(listSearchTerm(q), q).toBeNull();
    expect(listSearchTerm(42)).toBeNull();
    expect(listSearchTerm(undefined)).toBeNull();
    expect(listSearchTerm("  shed   porch ")).toBe("shed porch");
    expect(listSearchTerm("+1 816")).toBe("1 816");
    expect(listSearchTerm("lean),to*(")).toBe("lean to");
    // Cut BEFORE it is cleaned, as the apps cut it. Cleaning the whole body first took the first
    // (the apps send only its first 60 characters, which clean to nothing) and searched the second
    // with half of its last character left on the end.
    expect(listSearchTerm("!".repeat(60) + "ab")).toBeNull();
    expect(listSearchTerm("a".repeat(59) + "\u{1D400}")).toBe("a".repeat(59));
  });


  it("is a number to match by only when it is digits and what people type around them, 3 digits or more (phone-core's rule)", () => {
    expect(listSearchDigits("(555) 555-01")).toBe("55555501");
    expect(listSearchDigits("+1 555 555")).toBe("1555555");
    expect(listSearchDigits("555.555.0142")).toBe("5555550142");
    expect(listSearchDigits("  555  ")).toBe("555");
    expect(listSearchDigits("55")).toBeNull();
    expect(listSearchDigits("Bob 555")).toBeNull();
    expect(listSearchDigits("lean-to")).toBeNull();
  });

  it("a snippet is the text around the hit, on one line, at most 160 characters, cut with …", () => {
    const pat = termPattern("lean-to");
    expect(snippetAround("Short one about a lean-to.", pat)).toBe("Short one about a lean-to.");
    const long = `${"a".repeat(300)} the LEAN-TO\nestimate ${"b".repeat(300)}`;
    const snip = snippetAround(long, pat);
    expect(snip.length).toBe(160);
    expect(snip.startsWith("…") && snip.endsWith("…")).toBe(true);
    expect(snip).toContain("the LEAN-TO estimate");
    // A hit at the very start is not cut in front.
    const head = snippetAround(`lean-to ${"c".repeat(400)}`, pat);
    expect(head.startsWith("lean-to")).toBe(true);
    expect(head.endsWith("…")).toBe(true);
    expect(head.length).toBe(160);
    // A hit at the very end is not cut behind.
    const tail = snippetAround(`${"d".repeat(400)} lean-to`, pat);
    expect(tail.startsWith("…") && tail.endsWith("lean-to")).toBe(true);
    // _ is any one character, as in ilike.
    expect(termPattern("a_c").test("xABCx")).toBe(true);
  });
});

// The client half (the phone repo's packages/phone-core) must read terms and numbers the same way:
// run with PHONE_CORE_DIR pointing at a checkout's packages/phone-core, as test/identity.test.ts does.
const coreDir = process.env.PHONE_CORE_DIR;
describe.skipIf(!coreDir || !existsSync(join(coreDir, "src", "listSearch.ts")))("parity with @sss/phone-core list search", () => {
  it("agrees on what is a number and which digits it is", async () => {
    const core = await import(/* @vite-ignore */ pathToFileURL(join(coreDir!, "src", "listSearch.ts")).href);
    const cases = ["(555) 555-01", "555-555", "5555550100", "+1 555 555", "1.555.555.0100", "  555  ", "55", "Bob 555", "lean-to", "555 555 x", "(((", "+", "12345678901234567890"];
    for (const q of cases) expect(listSearchDigits(q), q).toBe(core.listSearchDigits(core.listSearchTerm(q) ?? q));
  });

  // The term itself (2026-10-13): phone-core holds back what its listSearchCleaned leaves under 2
  // characters ("+1", "(8", "#5", "$5", "a+", "?!") and never asks. The Worker must refuse exactly
  // those, take every term the apps send, and search the same text the apps count on.
  it("refuses exactly the terms the apps hold back, and searches what they send, cleaned the same way", async () => {
    const core = await import(/* @vite-ignore */ pathToFileURL(join(coreDir!, "src", "listSearch.ts")).href);
    for (const q of TERM_CASES) {
      const sent = core.listSearchTerm(q);
      const mine = listSearchTerm(q);
      expect(mine === null, `refused? ${JSON.stringify(q)}`).toBe(sent === null);
      if (sent === null) continue;
      expect(mine, JSON.stringify(q)).toBe(core.listSearchCleaned(sent));
      // The apps send `sent`, not what was typed: the Worker reads that the same way.
      expect(listSearchTerm(sent), `sent ${JSON.stringify(sent)}`).toBe(mine);
    }
  });
});

// ── POST /threads/search ─────────────────────────────────────────────────────────────────────

describe("POST /threads/search", () => {
  const PEOPLE = [
    person(CONTACT_1, "Jordan Demo", { owner_user_id: USER_A, phone: "(555) 555-0142", phone_digits: "5555550142" }),
    person(CONTACT_2, "Casey Lean", { owner_user_id: USER_B, phone: "(555) 555-0143", phone_digits: "5555550143" }),
    person(CONTACT_3, "Riley", { phone: "(555) 555-0144", phone_digits: "5555550144" }),
    // Matches by name, but has never texted: no conversation to show.
    person(CONTACT_4, "Jordan Quiet", { phone_digits: "5555550145" }),
    person("00000000-0000-4000-8000-00000000c009", "Jordan Elsewhere", { client_id: OTHER_TENANT }),
  ];
  const TEXTS = [
    // Jordan: the lean-to is in an OLDER text; the newest says something else.
    text("j1", { contact_id: CONTACT_1, body: "See you Tuesday", created_at: T(1) }),
    text("j2", { contact_id: CONTACT_1, direction: "out", from_number: BUSINESS_NUMBER, to_number: CUSTOMER, sent_by: USER_A, body: "Can you send the lean-to estimate for the barn?", created_at: T(30) }),
    text("c1", { contact_id: CONTACT_2, from_number: "+15555550143", body: "The lean-to looks great", created_at: T(5) }),
    text("r1", { contact_id: CONTACT_3, from_number: "+15555550144", body: "Thanks!", created_at: T(8) }),
    // A number nobody saved.
    text("u1", { from_number: UNKNOWN, body: "Do you build a lean-to?", created_at: T(12) }),
    // Another business's texts: never found.
    text("x1", { client_id: OTHER_TENANT, contact_id: CONTACT_1, body: "lean-to elsewhere", created_at: T(0.5) }),
    text("x2", { client_id: OTHER_TENANT, from_number: "+15555550199", body: "lean-to elsewhere", created_at: T(0.5) }),
  ];
  const world = { sms: TEXTS, contacts: PEOPLE };

  it("finds a conversation by ANY of its texts, as a GET /threads row (newest text in `last`) plus why it matched", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    const { res, json } = await call(env, searchThreads(token, { q: "lean-to", scope: "team" }));
    expect(res.status).toBe(200);
    expect(json.threads).toEqual([
      {
        key: CONTACT_1, contact_id: CONTACT_1, contact_name: "Jordan Demo", e164: CUSTOMER,
        last: { body: "See you Tuesday", direction: "in", at: T(1) },
        match: { field: "body", snippet: "Can you send the lean-to estimate for the barn?", at: T(30) },
      },
      {
        key: CONTACT_2, contact_id: CONTACT_2, contact_name: "Casey Lean", e164: "+15555550143",
        last: { body: "The lean-to looks great", direction: "in", at: T(5) },
        match: { field: "body", snippet: "The lean-to looks great", at: T(5) },
      },
      {
        key: `n:${UNKNOWN}`, contact_id: null, contact_name: null, e164: UNKNOWN,
        last: { body: "Do you build a lean-to?", direction: "in", at: T(12) },
        match: { field: "body", snippet: "Do you build a lean-to?", at: T(12) },
      },
    ]);
    expect(json).not.toHaveProperty("cursor");
    // Every read is this business's; contacts merged away are never candidates.
    for (const r of [...net.reads("sms_messages"), ...net.reads("crm_contacts")]) expect(r.url.searchParams.get("client_id")).toBe(`eq.${CLIENT}`);
    expect(net.reads("crm_contacts")[0].url.searchParams.get("merged_into")).toBe("is.null");
  });

  it("finds by the contact's name (match name); a contact who never texted has no conversation to show", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    const { json } = await call(env, searchThreads(token, { q: "JORD", scope: "team" }));
    expect(json.threads.map((t: { key: string; match: unknown }) => [t.key, t.match])).toEqual([[CONTACT_1, { field: "name" }]]);
  });

  it("finds by number however it is typed, the contact's and an unknown number's (match number); words never match numbers", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    for (const q of ["(555) 555-0143", "555-555-0143", "5555550143", "+1 555 555 0143", "1-555-555-0143", "555.0143"]) {
      const { json } = await call(env, searchThreads(token, { q, scope: "team" }));
      expect(json.threads.map((t: { key: string; match: unknown }) => [t.key, t.match]), q).toEqual([[CONTACT_2, { field: "number" }]]);
    }
    const { json: unknown } = await call(env, searchThreads(token, { q: "555 0150", scope: "team" }));
    expect(keys(unknown.threads)).toEqual([`n:${UNKNOWN}`]);
    expect(unknown.threads[0].match).toEqual({ field: "number" });
    // "Bob 555" is words: no number matches, and no text says it.
    const { json: words } = await call(env, searchThreads(token, { q: "Bob 555", scope: "team" }));
    expect(words.threads).toEqual([]);
  });

  it("a number written inside a text is found too, as words", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "view" }), {
      contacts: PEOPLE,
      sms: [text("w1", { contact_id: CONTACT_3, from_number: "+15555550144", body: "My wife's cell is 555 0177", created_at: T(2) })],
    });
    const { json } = await call(env, searchThreads(token, { q: "555 0177", scope: "team" }));
    expect(json.threads.map((t: { key: string; match: { field: string } }) => [t.key, t.match.field])).toEqual([[CONTACT_3, "body"]]);
  });

  it("the business's own number matches nothing: only the customer's side of a text is a number to match", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    const { json } = await call(env, searchThreads(token, { q: "555-555-0100", scope: "team" }));
    expect(json.threads).toEqual([]);
  });

  it("My: someone else's customer only when I texted them; no owner, everyone; phone level own asking for Team gets My", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "own" }), {
      contacts: PEOPLE,
      sms: [
        text("a1", { contact_id: CONTACT_1, body: "shed one", created_at: T(1) }),
        text("b1", { contact_id: CONTACT_2, from_number: "+15555550143", body: "shed two", created_at: T(2) }),
        text("r1", { contact_id: CONTACT_3, from_number: "+15555550144", body: "shed three", created_at: T(3) }),
      ],
    });
    const { json } = await call(env, searchThreads(token, { q: "shed", scope: "team" }));
    // Casey belongs to B and I sent nothing there.
    expect(keys(json.threads)).toEqual([CONTACT_1, CONTACT_3]);
    // A view-level teammate asking for Team sees Casey too.
    const team = await setup(callerCtx({ phone_level: "view" }), { contacts: PEOPLE, sms: [text("b1", { contact_id: CONTACT_2, body: "shed two" })] });
    expect(keys((await call(team.env, searchThreads(team.token, { q: "shed", scope: "team" }))).json.threads)).toEqual([CONTACT_2]);
    expect(keys((await call(team.env, searchThreads(team.token, { q: "shed", scope: "mine" }))).json.threads)).toEqual([]);
    // I texted Casey: mine.
    const sent = await setup(callerCtx({ phone_level: "own" }), {
      contacts: PEOPLE,
      sms: [
        text("b1", { contact_id: CONTACT_2, body: "shed two", created_at: T(1) }),
        text("b2", { contact_id: CONTACT_2, direction: "out", from_number: BUSINESS_NUMBER, to_number: "+15555550143", sent_by: USER_A, body: "On it", created_at: T(2) }),
      ],
    });
    expect(keys((await call(sent.env, searchThreads(sent.token, { q: "shed", scope: "mine" }))).json.threads)).toEqual([CONTACT_2]);
  });

  it("own-scoped contacts: only their own customers, and no unknown numbers; contacts none: nothing, and nothing read", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view", contacts_level: "own", own_contacts_only: true }), world, [CONTACT_1]);
    const { json } = await call(env, searchThreads(token, { q: "lean-to", scope: "team" }));
    expect(keys(json.threads)).toEqual([CONTACT_1]);
    // The walk reads only conversations they may see: Casey's and the unknown number's texts are never asked for.
    const walk = net.reads("sms_messages")[1];
    expect(walk.url.searchParams.get("or")).toBe(`(contact_id.in.(${CONTACT_1}))`);

    const viewOwn = await setup(callerCtx({ phone_level: "view", contacts_level: "own_view", own_contacts_only: true }), world, [CONTACT_2]);
    expect(keys((await call(viewOwn.env, searchThreads(viewOwn.token, { q: "lean-to", scope: "team" }))).json.threads)).toEqual([CONTACT_2]);

    const none = await setup(callerCtx({ phone_level: "view", contacts_level: "none" }), world);
    const { res, json: nothing } = await call(none.env, searchThreads(none.token, { q: "lean-to", scope: "team" }));
    expect(res.status).toBe(200);
    expect(nothing).toEqual({ ok: true, threads: [] });
    expect(none.net.reads("sms_messages")).toEqual([]);
    expect(none.net.reads("crm_contacts")).toEqual([]);
  });

  it("refuses what it can't search: no term, under 2 characters once cleaned, an unknown scope, a bad page marker, a body that isn't JSON", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    const cases: [unknown, string][] = [
      [{ scope: "team" }, "Type at least 2 characters to search."],
      [{ q: 42, scope: "team" }, "Type at least 2 characters to search."],
      [{ q: "a", scope: "team" }, "Type at least 2 characters to search."],
      [{ q: "  *  ,( ", scope: "team" }, "Type at least 2 characters to search."],
      // The terms the apps hold back without asking (phone-core listSearchTerm) are refused here too.
      ...["+1", "(8", "#5", "$5", "a+", "?!"].map((q): [unknown, string] => [{ q, scope: "team" }, TOO_SHORT]),
      // And past the 60 the apps send, nothing counts: this one's first 60 characters clean to nothing.
      [{ q: "!".repeat(60) + "ab", scope: "team" }, TOO_SHORT],
      [{ q: "lean", scope: "everyone" }, "Search My or Team."],
      [{ q: "lean", scope: "team", cursor: "yesterday" }, "That page marker isn't valid."],
      [{ q: "lean", scope: "team", cursor: 12 }, "That page marker isn't valid."],
    ];
    for (const [body, message] of cases) {
      const { res, json } = await call(env, searchThreads(token, body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(json.error).toEqual({ code: "bad_request", message });
    }
    const raw = new Request("https://phone.example.test/threads/search", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "q=lean" });
    const { res } = await call(env, raw);
    expect(res.status).toBe(400);
    expect(net.reads("sms_messages")).toEqual([]);
    // No login, no search.
    expect((await call(env, searchThreads("", { q: "lean", scope: "team" }))).res.status).toBe(401);
  });

  it("strips filter syntax out of the term before it reaches a filter", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    await call(env, searchThreads(token, { q: "lean),to*(", scope: "team" }));
    expect(net.reads("sms_messages")[0].url.searchParams.get("or")).toBe("(body.ilike.*lean to*)");
    expect(net.reads("crm_contacts")[0].url.searchParams.get("or")).toBe("(name.ilike.*lean to*)");
  });

  it("pages: every matching conversation once, in order of its newest text, even when the pages cut through their texts", async () => {
    // A fixed seed, so a failure is the same failure every run.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const people = Array.from({ length: 80 }, (_, i) => person(`00000000-0000-4000-8000-${(0xd000 + i).toString(16).padStart(12, "0")}`, `Pat ${i}`));
    const secs = Array.from({ length: 900 }, (_, i) => i + 1);
    for (let i = secs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [secs[i], secs[j]] = [secs[j], secs[i]];
    }
    let n = 0;
    const sms: Row[] = [];
    // 70 of the 80 have texts (several each); the other 10 never texted.
    for (let i = 0; i < 700; i++) sms.push(text(`s${i}`, { contact_id: people[Math.floor(rand() * 70)].id, body: `hello ${i}`, created_at: S(secs[n++]) }));
    // Texts from people who don't match, newer and older, to fill the scan between them.
    for (let i = 0; i < 200; i++) sms.push(text(`o${i}`, { contact_id: CONTACT_3, body: "other", created_at: S(secs[n++]) }));
    const { token, env } = await setup(callerCtx({ phone_level: "view" }), { contacts: [...people, person(CONTACT_3, "Riley")], sms });

    const newest = new Map<string, string>();
    for (const m of sms) {
      if (m.contact_id === CONTACT_3) continue;
      const k = String(m.contact_id);
      if (!newest.has(k) || String(m.created_at) > newest.get(k)!) newest.set(k, String(m.created_at));
    }
    const want = [...newest.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([k, at]) => [k, at]);

    const got: [string, string][] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { json } = await call(env, searchThreads(token, { q: "pat", scope: "team", ...(cursor ? { cursor } : {}) }));
      expect(json.ok).toBe(true);
      expect(json.threads.length).toBeLessThanOrEqual(50);
      got.push(...json.threads.map((t: { key: string; last: { at: string } }) => [t.key, t.last.at] as [string, string]));
      cursor = json.cursor;
      pages++;
    } while (cursor && pages < 50);
    expect(got).toEqual(want);
    expect(new Set(got.map(([k]) => k)).size).toBe(70);
    expect(pages).toBeGreaterThan(1);
  });

  it("the scope comes before the limits: contacts this person can't see never take the places of ones they can", async () => {
    // Someone limited to their own customers, at a busy business. 100 contacts called Jordan they
    // can't see (all the name read takes), then the texts that say "jordan": 50 newer conversations
    // they can't see, and 10 older ones they can. With the limit counted first, the 150 places
    // went to the 150 they can't see, and the 10 were never found.
    const hidden = Array.from({ length: 100 }, (_, i) => person(uuidOf(0xe000 + i), `Jordan ${i}`));
    const texted = Array.from({ length: 60 }, (_, i) => person(uuidOf(0xf000 + i), `Customer ${i}`));
    const sms = texted.map((p, i) => text(`h${i}`, { contact_id: p.id, body: `jordan said hi ${i}`, created_at: S(i + 1) }));
    const theirs = texted.slice(50).map((p) => String(p.id));
    const { token, env } = await setup(
      callerCtx({ phone_level: "view", contacts_level: "own", own_contacts_only: true }),
      { contacts: [...hidden, ...texted], sms }, theirs,
    );
    const { json } = await call(env, searchThreads(token, { q: "jordan", scope: "team" }));
    expect(keys(json.threads)).toEqual(theirs);
    // The name read was full, so older matches may be missing, and the answer says so.
    expect(json.partial).toBe(true);
  });

  it("partial: true on every page when a read or a limit was full; a search that read every match says nothing more", async () => {
    // 500 texts that say "barn" (all the text read takes) from 60 conversations.
    const people = Array.from({ length: 60 }, (_, i) => person(uuidOf(0xa000 + i), `Pat ${i}`));
    const sms = Array.from({ length: 500 }, (_, i) => text(`b${i}`, { contact_id: people[i % 60].id, body: `the barn ${i}`, created_at: S(i + 1) }));
    const { token, env } = await setup(callerCtx({ phone_level: "view" }), { contacts: people, sms });
    const first = await call(env, searchThreads(token, { q: "barn", scope: "team" }));
    expect(first.json.threads).toHaveLength(50);
    expect(first.json.partial).toBe(true);
    const second = await call(env, searchThreads(token, { q: "barn", scope: "team", cursor: first.json.cursor }));
    expect(second.json.threads).toHaveLength(10);
    expect(second.json.partial).toBe(true);

    const small = await setup(callerCtx({ phone_level: "view" }), world);
    const { json } = await call(small.env, searchThreads(small.token, { q: "lean-to", scope: "team" }));
    expect(json.threads.length).toBeGreaterThan(0);
    expect(json).not.toHaveProperty("partial");
  });

  it("never logs the term, a name, a number or a text, even when the database refuses the filter and quotes it back", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const SECRET = "zebrafence";
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }), {
      contacts: PEOPLE,
      sms: [text("z1", { contact_id: CONTACT_1, body: `about the ${SECRET} quote`, created_at: T(1) })],
    });
    const ok = await call(env, searchThreads(token, { q: SECRET, scope: "team" }));
    expect(keys(ok.json.threads)).toEqual([CONTACT_1]);
    // PostgREST's parse error repeats the filter, term and all.
    net.rest("GET", "sms_messages", (s) => jsonRes({ code: "PGRST100", message: `failed to parse logic tree (${s.url.searchParams.get("or")})`, details: s.url.search }, 400));
    const bad = await call(env, searchThreads(token, { q: SECRET, scope: "team" }));
    expect(bad.res.status).toBe(500);
    expect(bad.json.error.code).toBe("internal");
    const written = net.writes("app_errors").map((w) => w.body);
    expect(written.length).toBeGreaterThan(0);
    const said = [...written, ...log.mock.calls.flat(), ...warn.mock.calls.flat()].map(String).join("\n");
    for (const secret of [SECRET, "Jordan", "5555550142", CUSTOMER]) expect(said).not.toContain(secret);
    expect(said).toContain("PGRST100");
  });
});

// ── POST /calls/search ───────────────────────────────────────────────────────────────────────

describe("POST /calls/search", () => {
  const callRow = (id: string, over: Row = {}): Row => ({
    id, client_id: CLIENT, number_id: null, contact_id: null, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER,
    twilio_call_sid: null, client_call_sid: null, placed_by: null, answered_by: null, rang_user_ids: [], transferred_from: null,
    transfer_state: null, status: "completed", started_at: T(1), answered_at: null, ended_at: T(0.5), duration_s: 30, error_code: null,
    is_emergency: false, crm_contacts: null, phone_voicemails: null, phone_call_recordings: null, ...over,
  });
  const vm = (id: string, transcript: string | null, over: Row = {}): Row => ({ id, duration_s: 20, listened_at: null, deleted_at: null, transcript, ...over });
  const JORDAN = { name: "Jordan Demo", owner_user_id: USER_A };
  const CASEY = { name: "Casey Lean", owner_user_id: USER_B };
  const CALLS = [
    callRow("k1", { contact_id: CONTACT_1, crm_contacts: JORDAN, answered_by: USER_A, started_at: T(1) }),
    callRow("k2", { contact_id: CONTACT_2, crm_contacts: CASEY, direction: "out", from_e164: BUSINESS_NUMBER, to_e164: "+15555550143", placed_by: USER_B, started_at: T(2) }),
    callRow("k3", {
      from_e164: UNKNOWN, status: "voicemail", rang_user_ids: [USER_A], started_at: T(3),
      phone_voicemails: vm("v3", "Hi, it's about the lean-to estimate. Call me back when you can."),
    }),
    // Retention deleted this voicemail (and its words): never found, never on the Voicemail tab.
    // It rang B, not me.
    callRow("k4", { from_e164: "+15555550151", status: "voicemail", rang_user_ids: [USER_B], started_at: T(4), phone_voicemails: vm("v4", "lean-to too", { deleted_at: T(1) }) }),
    callRow("k5", { contact_id: CONTACT_1, crm_contacts: JORDAN, status: "voicemail", started_at: T(5), phone_voicemails: [vm("v5", "Jordan again")] }),
    // Another business's: never found.
    callRow("x1", { client_id: OTHER_TENANT, contact_id: CONTACT_1, crm_contacts: JORDAN, started_at: T(0.2), phone_voicemails: vm("vx", "lean-to") }),
  ];
  const world = { calls: CALLS };

  it("finds calls by the contact's name, as GET /calls rows plus why they matched, newest first", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    const { res, json } = await call(env, searchCalls(token, { q: "jordan", scope: "team" }));
    expect(res.status).toBe(200);
    expect(ids(json.calls)).toEqual(["k1", "k5"]);
    expect(json.calls[0]).toMatchObject({ id: "k1", e164: CUSTOMER, contact_id: CONTACT_1, contact_name: "Jordan Demo", status: "completed", match: { field: "name" } });
    // Every key a GET /calls row carries.
    for (const k of ["direction", "started_at", "duration_s", "answered_by", "voicemail", "handoff_state", "recording", "summary", "transcript_status", "error_code"]) {
      expect(json.calls[0]).toHaveProperty(k);
    }
    expect(json.calls[1]).toMatchObject({ voicemail: { id: "v5", transcript: "Jordan again" }, match: { field: "name" } });
    const byName = net.reads("phone_calls").find((r) => r.url.searchParams.has("crm_contacts.name"))!;
    expect(byName.url.searchParams.get("crm_contacts.name")).toBe("ilike.*jordan*");
    expect(byName.url.searchParams.get("select")).toContain("crm_contacts!inner(");
    for (const r of net.reads("phone_calls")) expect(r.url.searchParams.get("client_id")).toBe(`eq.${CLIENT}`);
  });

  it("finds by the customer's number however it is typed (\"I ever called this number\"), never by the business's own", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    for (const q of ["(555) 555-0143", "+1 555 555 0143", "5550143"]) {
      const { json } = await call(env, searchCalls(token, { q, scope: "team" }));
      expect(json.calls.map((c: { id: string; match: unknown }) => [c.id, c.match]), q).toEqual([["k2", { field: "number" }]]);
    }
    // Jordan's calls: the customer number on both, counted from the rows.
    const { json: jordan } = await call(env, searchCalls(token, { q: "555 555 0142", scope: "team" }));
    expect(ids(jordan.calls)).toEqual(["k1", "k5"]);
    expect(jordan.calls.map((c: { match: unknown }) => c.match)).toEqual([{ field: "number" }, { field: "number" }]);
    const { json: ours } = await call(env, searchCalls(token, { q: "555-555-0100", scope: "team" }));
    expect(ours.calls).toEqual([]);
  });

  it("finds by what the caller said in a voicemail (match transcript, with a snippet); a deleted voicemail's words are never searched", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    const { json } = await call(env, searchCalls(token, { q: "lean-to", scope: "team" }));
    expect(ids(json.calls)).toEqual(["k3"]);
    expect(json.calls[0].match).toEqual({ field: "transcript", snippet: "Hi, it's about the lean-to estimate. Call me back when you can." });
    const byWords = net.reads("phone_calls").find((r) => r.url.searchParams.has("phone_voicemails.transcript"))!;
    expect(byWords.url.searchParams.get("phone_voicemails.transcript")).toBe("ilike.*lean-to*");
    expect(byWords.url.searchParams.get("phone_voicemails.deleted_at")).toBe("is.null");
    expect(byWords.url.searchParams.get("select")).toContain("phone_voicemails!inner(");
  });

  it("voicemail: true (the Voicemail tab) finds only calls that left a voicemail that isn't deleted", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    const { json } = await call(env, searchCalls(token, { q: "jordan", scope: "team", voicemail: true }));
    expect(ids(json.calls)).toEqual(["k5"]);
    const { json: byNumber } = await call(env, searchCalls(token, { q: "555 555", scope: "team", voicemail: true }));
    expect(ids(byNumber.calls)).toEqual(["k3", "k5"]);
  });

  it("a call that matches more than one way comes back once, with the first reason (name, number, transcript)", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "view" }), {
      calls: [callRow("d1", { contact_id: CONTACT_1, crm_contacts: { name: "Pat 555", owner_user_id: null }, from_e164: "+15555550155", status: "voicemail", phone_voicemails: vm("vd", "call 555 back") })],
    });
    const { json } = await call(env, searchCalls(token, { q: "555", scope: "team" }));
    expect(json.calls.map((c: { id: string; match: unknown }) => [c.id, c.match])).toEqual([["d1", { field: "name" }]]);
  });

  it("My is GET /calls?scope=mine: mine, my customers' missed calls and voicemails; phone level own asking for Team gets My", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "own" }), world);
    const { json } = await call(env, searchCalls(token, { q: "555", scope: "team" }));
    // k2 was B's call to B's customer, k4 rang only B. k3 rang me (no owner). k5 is a voicemail on MY customer.
    expect(ids(json.calls)).toEqual(["k1", "k3", "k5"]);
    const view = await setup(callerCtx({ phone_level: "view" }), world);
    // Team: every call, k4 too (its voicemail was deleted; the call is still a call).
    const team = (await call(view.env, searchCalls(view.token, { q: "555", scope: "team" }))).json.calls;
    expect(ids(team)).toEqual(["k1", "k2", "k3", "k4", "k5"]);
    expect(team[3].voicemail).toBeNull();
    expect(ids((await call(view.env, searchCalls(view.token, { q: "555", scope: "mine" }))).json.calls)).toEqual(["k1", "k3", "k5"]);
  });

  it("drops calls about customers the caller can't see, and unknown numbers for own-scoped users unless they took part", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "view", contacts_level: "own", own_contacts_only: true }), world, [CONTACT_1]);
    const { json } = await call(env, searchCalls(token, { q: "555", scope: "team" }));
    // Casey's call is gone; of the unknown numbers, only the one that rang them (k3), not k4.
    expect(ids(json.calls)).toEqual(["k1", "k3", "k5"]);
    // Contacts none: no customer's call, and a name finds nothing without reading by name.
    const none = await setup(callerCtx({ phone_level: "view", contacts_level: "none" }), world);
    const { json: nothing } = await call(none.env, searchCalls(none.token, { q: "jordan", scope: "team" }));
    expect(nothing.calls).toEqual([]);
    expect(none.net.reads("phone_calls").some((r) => r.url.searchParams.has("crm_contacts.name"))).toBe(false);
  });

  it("pages like GET /calls: a full read hands back a cursor, and the next page continues below it, nothing twice", async () => {
    const many = Array.from({ length: 75 }, (_, i) => callRow(`p${i}`, { from_e164: "+15555550160", started_at: S(i + 1) }));
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }), { calls: many });
    const first = await call(env, searchCalls(token, { q: "555 555 0160", scope: "team" }));
    expect(first.json.calls).toHaveLength(50);
    expect(first.json.cursor).toBe(S(50));
    const second = await call(env, searchCalls(token, { q: "555 555 0160", scope: "team", cursor: first.json.cursor }));
    expect(ids(second.json.calls)).toEqual(Array.from({ length: 25 }, (_, i) => `p${50 + i}`));
    expect(second.json).not.toHaveProperty("cursor");
    expect(net.reads("phone_calls").at(-1)!.url.searchParams.get("started_at")).toBe(`lt.${S(50)}`);
  });

  it("reads short of a page each but more than a page together: every call, over the pages, once (Team and My)", async () => {
    // 30 calls found by name and 30 other calls found by what the caller said. No read is full,
    // and together they are more than a page: until 2026-10-13 the page kept 50, sent no cursor,
    // and the other 10 could never be reached.
    const calls = [
      ...Array.from({ length: 30 }, (_, i) => callRow(`n${i}`, { contact_id: CONTACT_1, crm_contacts: JORDAN, answered_by: USER_A, started_at: S(2 * i + 1) })),
      ...Array.from({ length: 30 }, (_, i) => callRow(`t${i}`, {
        from_e164: `+1555555${String(160 + i).padStart(4, "0")}`, status: "voicemail", rang_user_ids: [USER_A], started_at: S(2 * i + 2),
        phone_voicemails: vm(`vt${i}`, "Jordan here, about the barn"),
      })),
    ];
    const newestFirst = [...calls].sort((a, b) => (String(a.started_at) < String(b.started_at) ? 1 : -1)).map((r) => String(r.id));
    for (const [level, scope] of [["view", "team"], ["own", "mine"]] as const) {
      const { token, env } = await setup(callerCtx({ phone_level: level }), { calls });
      const { seen, pages } = await allPages(env, (cursor) => searchCalls(token, { q: "jordan", scope, ...(cursor ? { cursor } : {}) }));
      expect(seen, scope).toEqual(newestFirst);
      expect(pages, scope).toBe(2);
    }
  });

  it("My asks the database for MY calls, so a teammate's many calls to the same number don't push mine off the page", async () => {
    // B called the customer 60 times, all newer than my 2 calls to them.
    const TO = "+15555550188";
    const out = (id: string, by: string, sec: number) =>
      callRow(id, { direction: "out", from_e164: BUSINESS_NUMBER, to_e164: TO, placed_by: by, started_at: S(sec) });
    const calls = [...Array.from({ length: 60 }, (_, i) => out(`b${i}`, USER_B, i + 1)), out("me1", USER_A, 100), out("me2", USER_A, 101)];
    const { net, token, env } = await setup(callerCtx({ phone_level: "own" }), { calls });
    const { json } = await call(env, searchCalls(token, { q: "555-555-0188", scope: "mine" }));
    expect(ids(json.calls)).toEqual(["me1", "me2"]);
    expect(json).not.toHaveProperty("cursor");
    // Each way twice, as GET /calls reads My: the calls I took part in (one `or`; the number's has
    // mine inside it), and the unanswered calls on customers I own.
    const reads = net.reads("phone_calls");
    const mine = `placed_by.eq.${USER_A},answered_by.eq.${USER_A},transferred_from.eq.${USER_A},rang_user_ids.cs.{${USER_A}}`;
    const involved = reads.filter((r) => (r.url.searchParams.get("or") ?? "").includes(mine));
    const owned = reads.filter((r) => r.url.searchParams.get("crm_contacts.owner_user_id") === `eq.${USER_A}`);
    expect(involved).toHaveLength(3); // name, number, transcript
    expect(owned).toHaveLength(3);
    expect(reads).toHaveLength(6);
    for (const r of reads) expect(r.url.searchParams.getAll("or").length).toBeLessThanOrEqual(1);
    const byNumber = involved.find((r) => (r.url.searchParams.get("or") ?? "").includes("to_e164.like"))!;
    expect(byNumber.url.searchParams.get("or")).toBe(
      `(and(direction.eq.in,from_e164.like.*5555550188*,or(${mine})),and(direction.eq.out,to_e164.like.*5555550188*,or(${mine})))`,
    );
    for (const r of owned) {
      expect(r.url.searchParams.get("status")).toBe("in.(missed,voicemail,ringing)");
      expect(r.url.searchParams.get("select")).toContain("crm_contacts!inner(");
    }
    // Team: all 62, over two pages.
    const view = await setup(callerCtx({ phone_level: "view" }), { calls });
    const { seen } = await allPages(view.env, (cursor) => searchCalls(view.token, { q: "555-555-0188", scope: "team", ...(cursor ? { cursor } : {}) }));
    expect(seen).toHaveLength(62);
    expect(seen.slice(-2)).toEqual(["me1", "me2"]);
  });

  it("refuses a short term and a bad scope like the thread search", async () => {
    const { token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    expect((await call(env, searchCalls(token, { q: "x", scope: "team" }))).json.error).toEqual({ code: "bad_request", message: "Type at least 2 characters to search." });
    expect((await call(env, searchCalls(token, { q: "xyz", scope: "all" }))).res.status).toBe(400);
  });

  it("never logs the term or a transcript", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }), world);
    await call(env, searchCalls(token, { q: "estimate", scope: "team" }));
    net.rest("GET", "phone_calls", (s) => jsonRes({ code: "PGRST100", message: `failed to parse filter (${s.url.search})` }, 400));
    const bad = await call(env, searchCalls(token, { q: "estimate", scope: "team" }));
    expect(bad.res.status).toBe(500);
    const said = [...net.writes("app_errors").map((w) => w.body), ...log.mock.calls.flat(), ...warn.mock.calls.flat()].map(String).join("\n");
    expect(said).not.toContain("estimate");
    expect(said).not.toContain("lean-to");
  });
});

// ── GET /calls?voicemail=1 ───────────────────────────────────────────────────────────────────

describe("GET /calls?voicemail=1 (the Voicemail tab pages through every voicemail)", () => {
  const callRow = (id: string, over: Row = {}): Row => ({
    id, client_id: CLIENT, number_id: null, contact_id: null, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER,
    twilio_call_sid: null, client_call_sid: null, placed_by: null, answered_by: USER_A, rang_user_ids: [USER_A], transferred_from: null,
    transfer_state: null, status: "completed", started_at: T(1), answered_at: null, ended_at: T(0.5), duration_s: 30, error_code: null,
    is_emergency: false, crm_contacts: null, phone_voicemails: null, phone_call_recordings: null, ...over,
  });
  const vm = (id: string, over: Row = {}): Row => ({ id, duration_s: 20, listened_at: null, deleted_at: null, transcript: null, ...over });

  it("only calls with a voicemail that isn't deleted, 50 a page, read that way in the database", async () => {
    // 120 calls, a voicemail on every other one, one of those deleted: more than 50 calls stand
    // between the voicemails, which is what the old filter over the newest 50 lost.
    const calls = Array.from({ length: 120 }, (_, i) => callRow(`c${i}`, {
      started_at: S(i + 1),
      status: i % 2 ? "completed" : "voicemail",
      phone_voicemails: i % 2 ? null : vm(`v${i}`, i === 4 ? { deleted_at: T(1) } : {}),
    }));
    const { net, token, env } = await setup(callerCtx({ phone_level: "view" }), { calls });
    const first = await call(env, appRequest("GET", "/calls?scope=team&voicemail=1", token));
    expect(first.json.calls).toHaveLength(50);
    expect(first.json.calls.every((c: { voicemail: unknown }) => c.voicemail)).toBe(true);
    expect(ids(first.json.calls)).not.toContain("c4");
    expect(first.json.cursor).toBe(first.json.calls[49].started_at);
    const second = await call(env, appRequest("GET", `/calls?scope=team&voicemail=1&cursor=${encodeURIComponent(first.json.cursor)}`, token));
    expect(second.json.calls).toHaveLength(9); // 60 voicemails, one deleted
    expect(second.json).not.toHaveProperty("cursor");
    const q = net.reads("phone_calls")[0];
    expect(q.url.searchParams.get("select")).toContain("phone_voicemails!inner(");
    expect(q.url.searchParams.get("phone_voicemails.deleted_at")).toBe("is.null");
  });

  it("My: both of the list's reads keep to voicemails; without the param the list is as before", async () => {
    const { net, token, env } = await setup(callerCtx({ phone_level: "own" }), {
      calls: [
        callRow("a", { status: "voicemail", answered_by: null, phone_voicemails: vm("va"), started_at: T(1) }),
        callRow("b", { started_at: T(2) }),
        callRow("c", { status: "voicemail", answered_by: null, rang_user_ids: [USER_B], contact_id: CONTACT_1, crm_contacts: { name: "Jordan", owner_user_id: USER_A }, phone_voicemails: vm("vc"), started_at: T(3) }),
      ],
    });
    const { json } = await call(env, appRequest("GET", "/calls?voicemail=1", token));
    expect(ids(json.calls)).toEqual(["a", "c"]);
    for (const r of net.reads("phone_calls")) {
      expect(r.url.searchParams.get("select")).toContain("phone_voicemails!inner(");
      expect(r.url.searchParams.get("phone_voicemails.deleted_at")).toBe("is.null");
    }
    const before = net.reads("phone_calls").length;
    const { json: all } = await call(env, appRequest("GET", "/calls", token));
    expect(ids(all.calls)).toEqual(["a", "b", "c"]);
    for (const r of net.reads("phone_calls").slice(before)) {
      expect(r.url.searchParams.get("select")).not.toContain("!inner(id,duration_s");
      expect(r.url.searchParams.has("phone_voicemails.deleted_at")).toBe(false);
    }
  });

  it("My: two reads short of a page each but more than one together page through every voicemail, once", async () => {
    // 40 voicemails that rang me, and 40 on customers I own that rang a teammate. Each read holds
    // 40; together 80. Until 2026-10-13 the list stopped at 50 with no cursor.
    const calls = [
      ...Array.from({ length: 40 }, (_, i) => callRow(`r${i}`, { status: "voicemail", answered_by: null, phone_voicemails: vm(`vr${i}`), started_at: S(2 * i + 1) })),
      ...Array.from({ length: 40 }, (_, i) => callRow(`o${i}`, {
        status: "voicemail", answered_by: null, rang_user_ids: [USER_B], contact_id: CONTACT_1,
        crm_contacts: { name: "Jordan", owner_user_id: USER_A }, phone_voicemails: vm(`vo${i}`), started_at: S(2 * i + 2),
      })),
    ];
    const newestFirst = [...calls].sort((a, b) => (String(a.started_at) < String(b.started_at) ? 1 : -1)).map((r) => String(r.id));
    const { token, env } = await setup(callerCtx({ phone_level: "own" }), { calls });
    for (const path of ["/calls?voicemail=1", "/calls"]) {
      const join = path.includes("?") ? "&" : "?";
      const { seen, pages } = await allPages(env, (cursor) => appRequest("GET", `${path}${cursor ? `${join}cursor=${encodeURIComponent(cursor)}` : ""}`, token));
      expect(seen, path).toEqual(newestFirst);
      expect(pages, path).toBe(2);
    }
  });
});
