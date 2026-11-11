// How the two webhooks let Amazon SES in (email-inbound and postmark-events), pinned on the
// SHIPPED sources.
//
// WHY THIS EXISTS. Both files call Deno.serve at the top level, so their handlers cannot be
// imported, and the SES pieces they call are tested on their own (sesInbound, sesEvents,
// snsVerify). What is left is the ORDER the handlers do things in, and each line here is a
// property someone could undo with a tidy-up and never see fail:
//   • the URL key is checked before anything about SNS runs, so a stranger without it never makes
//     us fetch a signing certificate;
//   • the SNS branch runs before the body is parsed as JSON (the signature is over the raw text);
//   • the SES path never runs Resend's "fetch the body" call, and still goes through the one
//     Stage A that reads the envelope;
//   • the new thread lookup is scoped to the tenant Stage A chose;
//   • on the SES path a failed insert answers 5xx (SNS retries), on Resend's it stays 200;
//   • events adopt a row by its tag only after the id matched nothing, and only through the
//     database function, never by writing email_sends directly.
//
// Dependency-free. The gate runs _shared tests with --allow-read on the repo.

function assert(cond: unknown, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const INBOUND = await read("../email-inbound/index.ts");
const EVENTS = await read("../postmark-events/index.ts");
const at = (src: string, needle: string, what: string) => {
  const i = src.indexOf(needle);
  assert(i >= 0, `${what} is gone: ${needle}`);
  return i;
};

Deno.test("email-inbound: the key first, then the SNS branch, then JSON", () => {
  const key = at(INBOUND, `if (!keyOk) return json({ error: "unauthorized" }, 401);`, "the key check");
  const reader = at(INBOUND, "const read = await readSesInbound(await req.text());", "the SES reader");
  const jsonRead = at(INBOUND, "try { payload = await req.json(); }", "the Resend body read");
  assert(key < reader && reader < jsonRead, "key, then the raw text for SNS, and only otherwise req.json()");
  assert(INBOUND.includes("if (read.kind === \"answer\") {"), "an answer for SNS returns before any filing");
});

Deno.test("both webhooks: the SNS key opens ONLY the SNS path, and no key at all still refuses everything", () => {
  // The original key opens both paths. The second key needs the SNS header beside it, so it can
  // never be used to post an unsigned, Resend-shaped body. Each half also needs its secret to be
  // SET: an unset secret compared with an empty ?key= must not read as a match.
  at(INBOUND, `const keyOk = (!!secret && timingSafeEqual(key, secret)) || (viaSes && !!sesSecret && timingSafeEqual(key, sesSecret));`, "email-inbound's key rule");
  at(EVENTS, `const keyOk = (!!secret && timingSafeEqual(key, secret)) || (viaSns && !!sesSecret && timingSafeEqual(key, sesSecret));`, "postmark-events' key rule");
  for (const [src, flag] of [[INBOUND, "viaSes"], [EVENTS, "viaSns"]] as const) {
    at(src, `const ${flag} = Boolean(req.headers.get("x-amz-sns-message-type"));`, `${flag}`);
    assert(src.includes(`Deno.env.get("SES_WEBHOOK_SECRET")`), "the second key is its own secret");
  }
});

Deno.test("email-inbound: the SES path skips Resend's body fetch and shares Stage A and the insert", () => {
  at(INBOUND, "if (!viaSes && looksMetadataOnly && receivedId && resendConfigured()) {", "the guard on Resend's fetch");
  const stageA = at(INBOUND, "const envelope = envelopeRecipients(payload, m);", "Stage A's envelope read");
  // Calls only (an argument list, not the bare `envelopeRecipients()` the comments write).
  assert((INBOUND.match(/envelopeRecipients\([a-z]/g) ?? []).length === 1, "there is ONE envelope read, shared by both providers");
  assert((INBOUND.match(/from\("email_inbound"\)\.insert\(/g) ?? []).length === 1, "and one insert");
  assert(stageA > at(INBOUND, "payload = read.payload;", "the SES payload hand-over"), "the SES payload is in place before Stage A reads it");
});

Deno.test("email-inbound: the SES thread lookup stays inside the tenant, after the address token and our own ids", () => {
  const b1 = at(INBOUND, "const token = parseReplyToken(matchedRecipient);", "B1");
  const b2 = at(INBOUND, "const t = parseThreadMessageId(cand);", "B2");
  const b2b = at(INBOUND, `.eq("client_id", clientId).in("provider_message_id", [...new Set(sesIds)]).limit(20);`, "B2b's tenant-scoped ledger read");
  const b3 = at(INBOUND, `.eq("client_id", clientId).eq("email_lower", from.email).is("merged_into", null)`, "B3");
  assert(b1 < b2 && b2 < b2b && b2b < b3, "token, our id, SES's id, then the sender's address");
  const block = INBOUND.slice(INBOUND.lastIndexOf("if (!shortCode && !contactId && clientId) {", b2b), b3);
  assert(block.includes(".map((id) => sesMessageIdOf(id))"), "only ids on an SES host are looked up");
  assert(block.includes(`.eq("short_code", sent.short_code).eq("client_id", clientId).maybeSingle();`), "the design is re-checked against the tenant");
  assert(block.includes("await liveContact(String(sent.contact_id))"), "and a contact goes through the tenant-scoped merge follow");
});

Deno.test("email-inbound: a failed insert is a 503 for SNS and still a 200 for Resend", () => {
  const fail = at(INBOUND, `code: "inbound_insert_failed"`, "the insert-failure log");
  const tail = INBOUND.slice(fail, fail + 1500);
  const ses = tail.indexOf("if (viaSes) {");
  const five = tail.indexOf("json({ ok: false, stored: false }, 503)");
  const two = tail.indexOf("return json({ ok: true, stored: false });");
  assert(ses > 0 && five > ses && two > five, "viaSes answers 503; the line after it is Resend's 200");
  assert(INBOUND.trimEnd().endsWith("}, { alreadyFiled: (res) => filedAtReturnSite.has(res) }));"), "and the wrapper does not log the 503 a second time");
});

Deno.test("postmark-events: the key first, then the SNS branch, then Resend's JSON", () => {
  const key = at(EVENTS, "if (!keyOk) {", "the key check");
  const sns = at(EVENTS, "if (viaSns) return await sesEvent(req);", "the SNS branch");
  const jsonRead = at(EVENTS, "body = await req.json();", "the Resend body read");
  assert(key < sns && sns < jsonRead, "key, then SNS, then req.json()");
});

Deno.test("postmark-events: a row is adopted by its tag only when the id matched nothing, through the database function alone", () => {
  const fn = EVENTS.slice(at(EVENTS, "async function sesEvent(req: Request): Promise<Response> {", "sesEvent"), at(EVENTS, "async function handler(req: Request): Promise<Response> {", "handler"));
  const first = fn.indexOf("let { data, error } = await record();");
  const adopt = fn.indexOf(`if (!error && data === "unknown" && event.sendId) {`);
  const rpc = fn.indexOf(`admin.rpc("adopt_email_send", { p_send_id: event.sendId, p_provider_message_id: event.messageId })`);
  const again = fn.indexOf("({ data, error } = await record());");
  assert(first > 0 && adopt > first && rpc > adopt && again > rpc, "record, then adopt on 'unknown', then record again");
  assert(fn.includes("} else if (adopt.data === true) {"), "the second record runs only when a row really took the id");
  assert(fn.includes("p_event_id: eventId,"), "the SNS MessageId is the idempotency key");
  assert(!/from\("email_sends"\)/.test(EVENTS), "no direct table write anywhere in the file");
  assert(fn.includes(`const res = json({ ok: false, error: "update failed" }, 500);`), "a database error is a 500, so SNS delivers the event again");
});
