import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { unsubscribeTokenOk } from "../_shared/unsubscribe.ts";

// UNSUBSCRIBE (migration 366, Carolyn 2026-11-05) — where the link in every automated email lands.
//
// PUBLIC (verify_jwt = false): the person clicking is a builder's customer, with no login. The
// link is signed per (builder, customer) by _shared/unsubscribe.ts, so it can turn email off for
// that one customer and nobody else, and it reveals nothing (no name, no email in the URL).
//
// ⚠️ A GET NEVER UNSUBSCRIBES. Mail scanners and link previewers open every link in an email; if a
// visit did it, customers would be unsubscribed by their own spam filter. GET shows a page with a
// button; the button POSTs. The one exception is the RFC 8058 one-click POST that Gmail and Apple
// Mail send from their own "Unsubscribe" button (List-Unsubscribe-Post in the email's headers),
// which is a deliberate press, not a scan.
//
// What it sets is the customer's Email box in their Do Not Disturb panel, marked as THEIR doing
// (dnd_email_source 'customer'), so the builder sees "They unsubscribed on …" — and every
// automated email checks it before sending (crm-rules-tick).

const page = (title: string, body: string, form = "") => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#F8FAFC;color:#1E293B}
main{max-width:440px;margin:12vh auto;padding:28px 24px;background:#FFF;border:1px solid #E2E8F0;border-radius:12px}
h1{font-size:20px;margin:0 0 10px}p{margin:0 0 16px;color:#475569}
button{font:inherit;font-weight:700;padding:10px 18px;border:0;border-radius:8px;background:#1E293B;color:#FFF;cursor:pointer}</style>
</head><body><main><h1>${title}</h1><p>${body}</p>${form}</main></body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

Deno.serve(withErrorLog("unsubscribe", async (req: Request) => {
  const url = new URL(req.url);
  const clientId = String(url.searchParams.get("c") ?? "").slice(0, 120);
  const contactId = String(url.searchParams.get("k") ?? "").toLowerCase().slice(0, 64);
  const token = String(url.searchParams.get("t") ?? "").slice(0, 64);
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!clientId || !/^[0-9a-f-]{36}$/.test(contactId) || !key
      || !(await unsubscribeTokenOk(key, clientId, contactId, token))) {
    return page("This link has expired", "It may be from an old email. If you still get emails you don't want, reply to one and ask to be taken off.");
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, key);
  const { data: who } = await admin.from("client_settings").select("business_name").eq("client_id", clientId).maybeSingle();
  const business = esc(String(who?.business_name ?? "this business"));

  if (req.method === "GET") {
    return page(`Stop emails from ${business}?`, `You'll stop getting automatic emails from ${business}. They can still reply if you write to them.`,
      `<form method="post"><button type="submit">Unsubscribe</button></form>`);
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Already off stays as it was (and keeps whoever turned it off first). Never un-merges a
  // merged contact: the row is matched by id and tenant, nothing else.
  const now = new Date().toISOString();
  const { data: hit, error } = await admin.from("crm_contacts")
    .update({ dnd_email_at: now, dnd_email_source: "customer", updated_at: now })
    .eq("client_id", clientId).eq("id", contactId).is("dnd_email_at", null).select("id");
  if (error) throw error;
  if (hit && hit.length) {
    // A line on their record, so the team can see when and how it happened.
    await admin.from("crm_notes").insert({ client_id: clientId, contact_id: contactId, body: "Unsubscribed from automatic emails using the link in an email." });
  }
  return page("You're unsubscribed", `You won't get any more automatic emails from ${business}.`);
}));
