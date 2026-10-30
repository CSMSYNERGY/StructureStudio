// Admin → Support chats (2026-10-30), its wiring pinned in the SHIPPED sources:
//
//   1. admin-catalog sends both chat actions to supportChats.ts, and both are reads
//      (READ_ONLY_ACTIONS), on no money grant.
//   2. supportChats.ts refuses everything but the operator path before it reads anything, and
//      never selects a column the chats do not need (no token counts, no stop reasons).
//   3. The portal: a platform-wide "Support chats" tab whose card mounts only on that tab, asks only
//      admin-catalog, never names the chat tables, and takes ?chat= off the address once read.
//
// The behaviour itself is admin-catalog/supportChats_test.ts (the server) and
// tests/harness/supportChats.mjs (the compiled page).
//
// Run with the _test_stubs import map (preflight does): deno test --allow-read --allow-env
//   --import-map=_shared/_test_stubs/import_map.json _shared/_test_stubs/supportChatsWiring_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url)).then((s) => s.replace(/\r/g, ""));
const setOf = (src: string, name: string): string[] => {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`).exec(src);
  assert(m, `${name} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};
const ACTIONS = ["support_chats_list", "support_chat_get"];

Deno.test("admin-catalog: both chat actions reach supportChats.ts, as reads, on no money grant", async () => {
  const src = await read("../../admin-catalog/index.ts");
  assert(src.includes('import { handleSupportChatsAction } from "./supportChats.ts";'), "the handler is imported");
  const route = /case "support_chats_list":\s*case "support_chat_get":\s*return await handleSupportChatsAction\(/.test(src);
  assert(route, "both cases return the handler's answer");
  const reads = setOf(src, "READ_ONLY_ACTIONS");
  for (const a of ACTIONS) assert(reads.includes(a), `${a} is a read`);
  for (const money of ["PHONE_BILLING_ACTIONS", "TAX_BILLING_ACTIONS", "PASSWORD_REQUIRED"]) {
    for (const a of ACTIONS) assert(!setOf(src, money).includes(a), `${a} is not on ${money}`);
  }
});

Deno.test("supportChats.ts: the operator gate comes before any read, and the selects stay narrow", async () => {
  const src = await read("../../admin-catalog/supportChats.ts");
  const fn = src.slice(src.indexOf("export async function handleSupportChatsAction("));
  const gate = fn.indexOf('if (identity.via !== "operator") {');
  const first = Math.min(...['return await listChats(', 'return await getChat('].map((s) => fn.indexOf(s)));
  assert(gate > 0 && first > gate, "the operator check runs before either action");
  assertEquals(SUPPORT_CHAT_ACTIONS_IN(src), ACTIONS);
  for (const col of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "stop_reason", "user_id, role"]) {
    assert(!/const MSG_COLS = "[^"]*"/.exec(src)![0].includes(col), `messages are read without ${col}`);
  }
  assert(!/\bconsole\.(log|error|warn)\(/.test(src), "nothing here logs; a chat's words never reach a log");
});
function SUPPORT_CHAT_ACTIONS_IN(src: string): string[] {
  const m = /export const SUPPORT_CHAT_ACTIONS: readonly string\[\] = \[([^\]]*)\]/.exec(src);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

Deno.test("portal: a platform-wide Support chats tab that asks only admin-catalog", async () => {
  const admin = await read("../../../../portal/07-admin.jsx");
  assert(/\["chats",\s+"Support chats",\s+"[^"]+",\s+"global"\],/.test(admin), "ADM_TABS has the global chats tab");
  assert(admin.includes('{sub === "chats" && <AdmSupportChats '), "the card mounts only on its own tab");
  assert(admin.includes('adminApi("support_chats_list"') && admin.includes('adminApi("support_chat_get"'), "both reads go through admin-catalog");
  // The deep link: read once, then off the address (ssPagePath would carry it onto the next page).
  const card = admin.slice(admin.indexOf("function AdmSupportChats("), admin.indexOf("// ── Clients (global)"));
  assert(card.includes('qs.delete("chat");') && card.includes("window.history.replaceState("), "?chat= is taken off the address");
  assert(card.includes("SS_UUID_RE.test(id)"), "only a well-formed chat id is asked for");
  // No hook below an early return (React #310): the one early return comes after every hook.
  const ret = card.indexOf("if (hidden) return null;");
  assert(ret > 0, "the early return is found");
  assert(!/\buse(State|Effect|Ref|Callback|Memo|LayoutEffect)\(/.test(card.slice(ret)), "no hook after the early return");
  for (const f of ["01-core.jsx", "02-sales.jsx", "03-catalog.jsx", "04-orders.jsx", "05-schedule.jsx", "06-3d.jsx", "07-admin.jsx", "08-integrations.jsx", "09-table-engine.jsx", "10-projects.jsx", "11-sms.jsx", "12-shell.jsx"]) {
    const s = await read(`../../../../portal/${f}`);
    assert(!/from\(\s*["']support_(messages|conversations)["']/.test(s), `${f} never reads the chat tables itself`);
  }
});
