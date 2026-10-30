// The Support button's wiring (migration 340, 2026-10-27), pinned in the SHIPPED sources:
//
//   1. portal-feedback: a ticket never reaches Monday (it returns before the Monday leg, and
//      retry_push refuses to push one); bug and feature still go to the same boards they always did.
//   2. portal-feedback: a ticket's chat must be the CALLER's own, tenant AND person.
//   3. The portal: the per-builder switch (migration 346, useSupportOn) picks the top bar's Support
//      button or the old floating Feedback pill, never both; neither shows while viewing another
//      account; and support-agent is in SS_TENANT_SCOPED_FNS so a view-as call reaches the server
//      as one (and is refused there).
//   4. _shared/supportNotify.ts: who gets the alert comes only from the secret, and the alert names
//      the kind, the business and the title.
//   5. The Support board (Carolyn, 10-29 call; 2026-10-30): the board lookup skips archived boards; a
//      handed-off ticket's note holds the last 6 messages; the item's "Conversation" link column gets
//      a "Full chat" link (_shared/supportChatLink.ts, uuid only, fixed console host); and the alert
//      email says where that link is but never carries a console address (Reply-To is the builder).
//   6. The portal: the opened Projects card shows its own link cells, and the assistant's fallback
//      "Submit a ticket" carries the open chat when it has messages.
//
// Run with the _test_stubs import map (preflight does): deno test --allow-read --allow-env
//   --import-map=_shared/_test_stubs/import_map.json _shared/_test_stubs/supportTicketWiring_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { KIND_LABEL, supportAlertContent, supportRecipients } from "../supportNotify.ts";
import { SUPPORT_CHAT_ORIGIN, supportChatUrl } from "../supportChatLink.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url)).then((s) => s.replace(/\r/g, ""));

Deno.test("portal-feedback: a ticket returns before the Monday leg, and retry_push never pushes one", async () => {
  const src = await read("../../portal-feedback/index.ts");
  const submit = src.slice(src.indexOf('if (action === "submit") {'), src.indexOf('if (action === "retry_push") {'));
  assert(submit.length > 0, "submit block found");
  assert(/body\.kind === "ticket" \? "ticket"/.test(submit), "submit accepts kind ticket");
  const early = submit.indexOf('if (kind === "ticket") {');
  const monday = submit.indexOf('Deno.env.get("MONDAY_PUSH_DISABLED")');
  assert(early > 0 && monday > early, "the ticket return comes BEFORE the Monday switch and push");
  assert(/monday_board_id: kind === "ticket" \? null/.test(submit), "a ticket names no Monday board");
  const retry = src.slice(src.indexOf('if (action === "retry_push") {'), src.indexOf('if (action === "comment") {'));
  assert(/row\.kind === "ticket" \|\|/.test(retry), "retry_push treats a ticket as having no Monday leg");
  assert(/bug: \["bugs"\], feature: \["features"\], ticket: \["support", "bugs"\]/.test(src), "bug and feature boards unchanged; tickets prefer support");
});

Deno.test("portal-feedback: a ticket's chat must be the caller's own (tenant and person)", async () => {
  const src = await read("../../portal-feedback/index.ts");
  const i = src.indexOf('from("support_conversations").select("id")');
  assert(i > 0, "the chat lookup exists");
  const q = src.slice(i, i + 260);
  assert(q.includes('.eq("client_id", clientId)') && q.includes('.eq("user_id", user.id)'), "scoped to tenant AND user");
  assert(src.includes('"That chat does not belong to this account." }, 403'), "anything else is a 403");
});

Deno.test("portal: the switch picks Support or the old pill, never both, never in view-as; support-agent is tenant-scoped", async () => {
  const shell = await read("../../../../portal/12-shell.jsx");
  const orders = await read("../../../../portal/04-orders.jsx");
  const core = await read("../../../../portal/01-core.jsx");
  const hook = shell.indexOf("const supportOn = useSupportOn(");
  assert(hook > 0 && hook < shell.indexOf("if (tenant === null) {"), "the shell asks the switch above its early returns (React #310)");
  assert(/sb\.functions\.invoke\("support-agent", \{ body: \{ action: "enabled" \} \}\)/.test(orders), "useSupportOn asks support-agent's enabled");
  assert((shell.match(/<FeedbackWidget/g) || []).length === 1 && /\{!viewing && !supportOn && \(\s*<FeedbackWidget/.test(shell), "the old pill renders only with the switch off, never in view-as");
  assert(/function FeedbackWidget\(/.test(orders), "and still exists for those builders");
  const top = shell.slice(shell.indexOf('<div className="ss-topbar">'), shell.indexOf('<div className="ss-body">'));
  assert(/\{!viewing && supportOn && \(\s*<SupportMenu /.test(top), "SupportMenu is in the top bar, only with the switch on, behind !viewing");
  assert(/const SS_TENANT_SCOPED_FNS = \[[^\]]*"support-agent"/.test(core), "support-agent is in SS_TENANT_SCOPED_FNS");
  for (const label of ["Ask the assistant", "Report a problem", "Request a feature", "Submit a ticket", "My requests", "What's new"]) {
    assert(orders.includes(`"${label}"`), `the menu has ${label}`);
  }
  assert(orders.includes("You are chatting with an AI assistant. Chats are saved so our team can follow up."), "the disclosure line");
});

Deno.test("supportNotify: recipients only from the secret; the alert names kind, business and title", () => {
  assertEquals(supportRecipients(undefined), []);
  assertEquals(supportRecipients("a@example.test, b@example.test;bad, A@example.test"), ["a@example.test", "b@example.test"]);
  assertEquals(supportRecipients("1@x.test,2@x.test,3@x.test,4@x.test,5@x.test,6@x.test").length, 5, "at most five");
  const c = supportAlertContent({
    kind: "ticket", title: "Help\nwith link", detail: "<b>x</b>", severity: null, clientId: "demo-builder", businessName: "Demo Sheds",
    submitterName: "Pat", submitterEmail: "pat@example.test", submissionId: "00000000-0000-4000-8000-000000000001", chatMessages: 4,
  });
  assert(c.subject.startsWith("New ticket from Demo Sheds (demo-builder): Help with link"), c.subject);
  assert(!c.subject.includes("\n"), "one-line subject");
  assert(c.text.includes("last 4 chat messages"), "says the chat is on the item");
  assert(c.html.includes("&lt;b&gt;x&lt;/b&gt;") && !c.html.includes("<b>x</b>"), "builder text is escaped in the HTML");
  assertEquals(KIND_LABEL.bug, "problem report");
});

Deno.test("portal-feedback: live boards only; last 6 messages; a Support ticket gets its Full chat link", async () => {
  const src = await read("../../portal-feedback/index.ts");
  const mirror = src.slice(src.indexOf("async function mirrorToProjects("), src.indexOf("// Creates the Monday item"));
  assert(mirror.length > 0, "mirrorToProjects found");
  assert(/from\("pm_boards"\)\.select\("id, slug"\)\.in\("slug", slugs\)\.is\("archived_at", null\)/.test(mirror), "an archived board never receives an item");
  assert(mirror.includes('c.type === "link" && c.name === "Conversation"'), "the Conversation link column is matched by type and name");
  assert(/const url = supportChatUrl\(row\.support_conversation_id\);\s*if \(url\) values\[c\.id\] = \{ url, text: "Full chat" \};/.test(mirror), "the cell is {url, text} from the helper, and only for a real chat id");
  const i = src.indexOf('from("support_messages")');
  assert(i > 0, "the chat note reads support_messages");
  const q = src.slice(i, i + 220);
  assert(q.includes(".limit(6)") && !q.includes(".limit(10)"), "the note holds the last 6 messages");
  assert(!/last 10/.test(src), "no comment still says 10");
});

Deno.test("supportChatLink: a uuid becomes the console address; anything else is refused", () => {
  assertEquals(SUPPORT_CHAT_ORIGIN, "https://beta.structurestudiosuite.com");
  assertEquals(
    supportChatUrl("00000000-0000-4000-8000-000000000002"),
    "https://beta.structurestudiosuite.com/console/chats?chat=00000000-0000-4000-8000-000000000002",
  );
  assertEquals(supportChatUrl("00000000-0000-4000-8000-00000000000A"), "https://beta.structurestudiosuite.com/console/chats?chat=00000000-0000-4000-8000-00000000000a", "lowercased");
  for (const bad of [null, undefined, "", "../x", "x?chat=y", "00000000-0000-4000-8000-000000000002&x=1", " 00000000-0000-4000-8000-000000000002", 42]) {
    assertEquals(supportChatUrl(bad), null, `refuses ${JSON.stringify(bad)}`);
  }
});

Deno.test("supportNotify: the alert claims only what is on the item, and carries no console address", () => {
  const base = {
    kind: "ticket", title: "Prices", detail: "d", severity: null, clientId: "demo-builder", businessName: null,
    submitterName: "Pat", submitterEmail: "pat@example.test", submissionId: "00000000-0000-4000-8000-000000000001", chatMessages: 4,
  };
  const linked = supportAlertContent({ ...base, chatLinked: true });
  assert(linked.text.includes("the last 4 chat messages and a link to the full chat are on the Projects item."), linked.text);
  const unlinked = supportAlertContent(base);   // the Bugs fallback: a note, no link column
  assert(unlinked.text.includes("the last 4 chat messages are on the Projects item.") && !unlinked.text.includes("link to the full chat"), unlinked.text);
  assert(!supportAlertContent({ ...base, chatMessages: 0, chatLinked: true }).text.includes("Handed off"), "no note written, no hand-off line");
  for (const c of [linked, unlinked]) {
    for (const body of [c.text, c.html]) {
      assert(!body.includes("/console/") && !body.includes("structurestudiosuite.com"), "no console address in the email");
    }
  }
});

Deno.test("portal-feedback: the alert's chat claims come from the item, not from the read", async () => {
  const src = await read("../../portal-feedback/index.ts");
  const hand = src.slice(src.indexOf("let chatLinked = false;"), src.indexOf("// Tell the support inbox"));
  assert(hand.length > 0, "the hand-off block found");
  assert(/chatLinked = !!\(item && chatUrl && Object\.values\(item\.values \|\| \{\}\)\.some\(/.test(hand), "linked only when the item holds the chat's link");
  assert(/if \(!noteErr\) chatMessages = lines\.length;/.test(hand), "the count only when the note was written");
  assert(!/^\s*chatMessages = lines\.length;/m.test(hand), "never straight from the read");
  assert(src.includes("submissionId: row.id, chatMessages, chatLinked,"), "both reach the alert");
});

Deno.test("portal: the opened card shows its link cells; the fallback ticket keeps the chat", async () => {
  const projects = await read("../../../../portal/10-projects.jsx");
  const orders = await read("../../../../portal/04-orders.jsx");
  const mount = projects.slice(projects.indexOf("<PMItemPanel key={openItem.id}"), projects.indexOf("{moving && data && ("));
  assert(mount.includes("columns={data.columns}"), "the drawer mount passes the board's columns");
  const panel = projects.slice(projects.indexOf("function PMItemPanel("), projects.indexOf("<PMDrawer onClose={onClose} labelledBy=\"pm-item-title\">"));
  assert(/function PMItemPanel\(\{ item, columns = \[\],/.test(panel), "PMItemPanel takes columns, default empty");
  assert(panel.includes('c.type === "link"') && /\^https\?:/.test(panel), "link columns with http(s) values only");
  assert(/\{links\.map\(\(\{ c, v \}\) => \([\s\S]{0,300}target="_blank" rel="noreferrer"/.test(projects), "rendered as the grid's anchor");
  assert(orders.includes("onClick={() => onTicket(null, messages.length ? convId : null)}"), "the fallback Submit a ticket carries a chat that has messages");
  assert(!orders.includes("onTicket(null, null)"), "and no ticket button drops the chat");
});

Deno.test("supportNotify: the source holds no inbox address (the repo is public)", async () => {
  const src = await read("../supportNotify.ts");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(code.replace(/EMAIL = \/[^\n]+/, "")), "no address in code");
});
