// knowledge.ts is generated from kb.md and faq.md (scripts/support-kb.mjs). This fails when the
// embedded string drifts from the two files, so an edited FAQ cannot ship without regenerating, and
// when the knowledge carries anything the public repo must not: an email address or our own consoles.
//
// Run: deno test --allow-env --allow-read --node-modules-dir=none support-agent/   (from supabase/functions)

import { KNOWLEDGE } from "./knowledge.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("knowledge.ts is exactly kb.md + faq.md (rerun scripts/support-kb.mjs after editing either)", async () => {
  const read = async (f: string) => (await Deno.readTextFile(new URL(f, import.meta.url))).replace(/\r/g, "");
  const want = `${(await read("./kb.md")).trimEnd()}\n\n${(await read("./faq.md")).trimEnd()}\n`;
  assert(KNOWLEDGE === want, "knowledge.ts is stale: run node scripts/support-kb.mjs");
});

Deno.test("the knowledge names no inbox and none of our own consoles", () => {
  assert(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(KNOWLEDGE), "no email address");
  for (const internal of ["(/accounts)", "(/admin)", "(/projects)", "(/advanced)", "Operator console"]) {
    assert(!KNOWLEDGE.includes(internal), `no ${internal}`);
  }
  assert(KNOWLEDGE.includes("24 hours"), "the reply promise is in the FAQ");
});

/** One FAQ answer's non-empty lines, heading to the next heading of any level. */
async function faqLines(question: string): Promise<string[]> {
  const faq = (await Deno.readTextFile(new URL("./faq.md", import.meta.url))).replace(/\r/g, "");
  const i = faq.indexOf(`### ${question}\n`);
  assert(i >= 0, `faq.md has "### ${question}"`);
  const body = faq.slice(faq.indexOf("\n", i) + 1);
  const j = body.search(/\n#+ /);
  return (j < 0 ? body : body.slice(0, j)).split("\n").filter((l) => l.trim());
}

/** One FAQ answer on one line. */
async function faqAnswer(question: string): Promise<string> {
  return (await faqLines(question)).join(" ").replace(/\s+/g, " ").trim();
}

// FAQ answers run two to six lines of faq.md. The prices answer is the one that keeps growing as the
// table gains controls (it reached nine lines once), so it is held to that here.
Deno.test("the prices answer fits in six lines of faq.md", async () => {
  const n = (await faqLines("How do I set my prices?")).length;
  assert(n >= 2 && n <= 6, `the prices answer is ${n} lines: keep it to 2-6`);
});

// The table adds sizes itself now (Pricing Table phase 4a, 2026-10-31): its band button, quoted exactly
// as PgStyleBand in portal/03-catalog.jsx draws it, is the first way the answer gives, and a new row in
// the Excel template the alternative, after both Excel buttons. Real-Time Pricing locks the table's
// Price column (PgHeader) and migration 350 refuses a price while it is on, so the answer must not
// leave "type each size's price" unqualified.
Deno.test("the prices answer adds a size with the table's button first, Excel's new row after it, and says RealTime Pricing locks the Price column", async () => {
  const a = await faqAnswer("How do I set my prices?");
  const portal = await Deno.readTextFile(new URL("../../../portal/03-catalog.jsx", import.meta.url));
  assert(portal.includes(`aria-expanded={open}>＋ Add sizes</button>`), "the button the answer quotes is drawn with these exact words");
  const button = a.indexOf(`press "＋ Add sizes" on the style`);
  const excel = a.indexOf("Prefer Excel?");
  const row = a.search(/a row with a new width and length \(in feet\) adds a size/);
  assert(button > 0, "how to add a size in the table, quoting its button");
  assert(excel > button && row > excel, "the Excel row comes after the table, as the alternative");
  assert(a.includes(`"⬇ Download Excel template"`) && a.includes(`"⬆ Upload filled sheet"`), "both Excel buttons, as drawn");
  assert(/RealTime Pricing live, the Price column is locked/.test(a), "the Real-Time Pricing lock");
});

// The hand-run 20-question pass (tests/harness/supportAgent20.js) judges each answer by plain rules.
// The prices rule must pass an answer that follows this FAQ, which now starts at the table: the
// answer's first sentence names Sheds and the table and no Excel word. The harness runs here with
// its browser globals stubbed and every answer canned; nothing leaves the process.
Deno.test("the 20-question harness passes a prices answer that names only the table", async () => {
  const src = await Deno.readTextFile(new URL("../../../tests/harness/supportAgent20.js", import.meta.url));
  const Q = "How do I set my prices for each building size?";
  const judge = async (reply: string) => {
    const win: Record<string, unknown> = {};
    const storage = { "sb-test-auth-token": JSON.stringify({ access_token: "t" }), getItem(k: string) { return (this as any)[k] ?? null; } };
    const fetchStub = (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const out = body.action === "send" ? { messages: [{ body: body.text }, { body: body.text === Q ? reply : "" }], tools: [] } : {};
      return Promise.resolve({ status: 200, json: () => Promise.resolve(out) });
    };
    new Function("window", "localStorage", "fetch", "performance", src)(win, storage, fetchStub, performance);
    const rows = await (win.__ssSupport20 as (o: unknown) => Promise<{ q: string; pass: boolean }[]>)({});
    const row = rows.find((r) => r.q === Q);
    assert(row, "the harness still asks the prices question");
    return row!.pass;
  };
  const first = (await faqAnswer("How do I set my prices?")).split(/\.\s/)[0];
  assert(/table/.test(first) && !/(template|spreadsheet|excel|upload)/i.test(first), `the answer's first sentence is table-only: ${first}`);
  assert(await judge(first), `a table-only answer passes: ${first}`);
  assert(await judge("Settings > Sheds: download the Excel template, fill it in and upload it."), "an Excel answer still passes");
  assert(!(await judge("Settings > Sheds.")), "an answer naming neither the table nor Excel fails");
});
