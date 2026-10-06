// The Conversations page's portal half, pinned against the SHIPPED sources (the record-gate and
// card-order tests' technique: slice the real block between stable anchors, run it).
//
// What can drift silently, and is pinned here:
//   • a row opens the record on a History chip that must EXIST and must hold that channel's
//     events (CRM_INBOX_CHIP → CRM_CHIPS); a chip key nobody has opens on All with nothing said;
//   • the page's filters are the four the server knows (crmInbox.ts parseInboxRequest);
//   • the email kinds that make a conversation are the phone-api Worker's (LIST_EMAIL_KINDS), so
//     the portal and My Synergy Phone list the same people;
//   • the shell: the page is routable, needs the contacts area, sits under Contacts only with
//     the CRM, and hands the record its chip; the record starts on it;
//   • the server gate is contacts:view, so contacts:'own' reaches it and is narrowed in the branch;
//   • the list helpers: pages joined without repeats, and the time said the way a message list
//     says it.

import { assert, assertEquals } from "jsr:@std/assert";
import { parseInboxRequest, INBOX_EMAIL_KINDS } from "../crmInbox.ts";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SALES = await read("../../../../portal/02-sales.jsx");
const CORE = await read("../../../../portal/01-core.jsx");
const SHELL = await read("../../../../portal/12-shell.jsx");
const SETTINGS = await read("../../portal-settings/index.ts");
const WORKER_EMAIL = await read("../../../../workers/phone-api/src/emailThread.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) {
    throw new Error(`crmInboxPortal_test: could not find ${what} (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  return src.slice(i, j);
};

type Chip = { key: string; types: string[] | null };
const { CRM_CHIPS } = new Function(
  `${slice(SALES, "const CRM_CHIPS = [", "// WHAT HAPPENED TO ONE OF OUR EMAILS", "CRM_CHIPS")}; return { CRM_CHIPS };`,
)() as { CRM_CHIPS: Chip[] };
type Filter = { slug: string | null; channel: string; label: string };
const INBOX = new Function(
  `const ACCENT = "#3D3672"; ${slice(SALES, "const SS_INBOX_FILTERS = [", "const SS_INBOX_MINE_KEY", "the inbox helpers")};
   return { SS_INBOX_FILTERS, CRM_INBOX_CHIP, ssInboxWhen, ssInboxJoin, SS_INBOX_CHANNEL, SS_INBOX_DIRECTION };`,
)() as {
  SS_INBOX_FILTERS: Filter[];
  CRM_INBOX_CHIP: Record<string, string>;
  ssInboxWhen: (iso: string) => string;
  ssInboxJoin: (list: { contactId: string }[], more: { contactId: string }[]) => { contactId: string }[];
  SS_INBOX_CHANNEL: Record<string, { label: string }>;
  SS_INBOX_DIRECTION: Record<string, Record<string, string>>;
};

Deno.test("a row opens the record on a chip that exists and holds that channel's events", () => {
  const want: Record<string, string[]> = { email: ["email", "email_in"], sms: ["sms", "sms_in"], calls: ["call", "call_missed", "voicemail"] };
  for (const [channel, types] of Object.entries(want)) {
    const key = INBOX.CRM_INBOX_CHIP[channel];
    const chip = CRM_CHIPS.find((c) => c.key === key);
    assert(chip, `${channel} opens on "${key}", which is not a History chip`);
    for (const t of types) assert((chip.types ?? []).includes(t), `the ${key} chip does not hold ${t}`);
  }
  assertEquals(Object.keys(INBOX.CRM_INBOX_CHIP).sort(), ["calls", "email", "sms"]);
});

Deno.test("the page's filters are the server's, and every channel has its words", () => {
  assertEquals(INBOX.SS_INBOX_FILTERS.map((f) => f.channel), ["all", "email", "sms", "calls"]);
  assertEquals(INBOX.SS_INBOX_FILTERS.map((f) => f.slug), [null, "email", "texts", "calls"]);
  for (const f of INBOX.SS_INBOX_FILTERS) assert(!("error" in parseInboxRequest({ channel: f.channel })), `the server refuses ${f.channel}`);
  for (const ch of ["email", "sms", "calls"]) {
    assert(INBOX.SS_INBOX_CHANNEL[ch]?.label, `no label for ${ch}`);
    assert(INBOX.SS_INBOX_DIRECTION.in[ch] && INBOX.SS_INBOX_DIRECTION.out[ch], `no direction words for ${ch}`);
  }
});

Deno.test("the email kinds that make a conversation are My Synergy Phone's", () => {
  const m = WORKER_EMAIL.match(/export const LIST_EMAIL_KINDS = \[([^\]]*)\]/);
  assert(m, "LIST_EMAIL_KINDS moved in workers/phone-api/src/emailThread.ts");
  const worker = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assertEquals(INBOX_EMAIL_KINDS, worker);
});

Deno.test("pages are joined without repeating anyone", () => {
  const got = INBOX.ssInboxJoin([{ contactId: "a" }, { contactId: "b" }], [{ contactId: "b" }, { contactId: "c" }, { contactId: "c" }]);
  assertEquals(got.map((r) => r.contactId), ["a", "b", "c"]);
});

Deno.test("the time, as a message list says it", () => {
  const now = new Date();
  const ago = (days: number, h = 0) => { const d = new Date(now); d.setDate(d.getDate() - days); d.setHours(h, 5, 0, 0); return d.toISOString(); };
  assert(/^\d{1,2}:05 [AP]M$/.test(INBOX.ssInboxWhen(ago(0, 1))), INBOX.ssInboxWhen(ago(0, 1)));
  assertEquals(INBOX.ssInboxWhen(ago(1, 12)), "Yesterday");
  assert(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(INBOX.ssInboxWhen(ago(3, 12))), INBOX.ssInboxWhen(ago(3, 12)));
  assertEquals(INBOX.ssInboxWhen("2024-03-04T12:00:00.000000Z"), "Mar 4, 2024");
  assertEquals(INBOX.ssInboxWhen("not a date"), "");
});

Deno.test("the shell: routable, the contacts area, under Contacts only with the CRM, and the chip handed over", () => {
  assert(/\n {2}conversations: \["Conversations", "[^"]+"\],/.test(CORE), "TAB_META has no conversations page");
  assert(/\n {2}conversations: "contacts",/.test(slice(CORE, "const TAB_AREA = {", "};", "TAB_AREA")), "conversations does not need the contacts area");
  assert(/const NONADMIN_TABS = \[[^\]]*"conversations"/.test(CORE), "the pre-100 access shape can't reach conversations");
  const nav = slice(SHELL, '{navItem("contacts", "Contacts")}', '{navItem("designs", "Pipeline")}', "the nav under Contacts");
  assert(nav.includes('{crmUnlocked && navItem("conversations", "Conversations")}'), "the nav item is not right under Contacts, behind the CRM");
  assert(/initialChip=\{recordCtx && recordCtx\.sub === sub \? \(recordCtx\.chip \|\| null\) : null\}/.test(SHELL), "the record mount does not pass the chip");
  // One navigate, carrying the chip for the row's channel and a Back to the filter left; it rides
  // in the history entry, so the browser's Back onto the record keeps both.
  assert(/onOpen=\{\(contactId, channel\) => navigate\("contacts", "c-" \+ contactId, false, \{\s*chip: CRM_INBOX_CHIP\[channel\] \|\| "all",\s*from: \{ page: "conversations", pageSub: sub \|\| null \},\s*\}\)\}/.test(SHELL),
    "a row does not open the record on its channel's chip, with a Back to this filter");
  assert(SHELL.includes("recordCtx && recordCtx.sub === sub && recordCtx.from"), "the record's Back does not return to Conversations");
  assert(/initialChip = null \}\) \{/.test(SALES) && SALES.includes('useState(initialChip || "all")'), "CrmRecord does not start on initialChip");
});

Deno.test("the server gate is contacts:view and the branch exists", () => {
  assert(/\n {2}crm_inbox: +\{ area: "contacts", level: "view" \},/.test(SETTINGS), "crm_inbox is not gated contacts:view");
  assert(SETTINGS.includes('if (action === "crm_inbox") {'), "no crm_inbox branch");
});
