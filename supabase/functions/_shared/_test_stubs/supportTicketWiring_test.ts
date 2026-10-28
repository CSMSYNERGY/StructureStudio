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
//
// Run with the _test_stubs import map (preflight does): deno test --allow-read --allow-env
//   --import-map=_shared/_test_stubs/import_map.json _shared/_test_stubs/supportTicketWiring_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { KIND_LABEL, supportAlertContent, supportRecipients } from "../supportNotify.ts";

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

Deno.test("supportNotify: the source holds no inbox address (the repo is public)", async () => {
  const src = await read("../supportNotify.ts");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(code.replace(/EMAIL = \/[^\n]+/, "")), "no address in code");
});
