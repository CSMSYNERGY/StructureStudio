import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { smsConsentSentence } from "../_shared/smsConsentText.ts";

/**
 * The public opt-in disclosure page — the thing a carrier reviewer can actually open.
 *
 * ⚠️ THIS EXISTS BECAUSE THE CONSENT BOX IS INVISIBLE TO EVERYONE WHO MATTERS. Twilio error
 * 30896 ("rejected because of provided Opt-in information") landed on 2026-09-03 for exactly
 * that reason: our `MessageFlow` told the reviewer customers tick a box on the quote form,
 * they went to look, and `GET /?client=<id>` answered `<title>Loading…</title>` with ZERO
 * occurrences of the consent sentence. The box is real and its wording is good — but it is
 * React-rendered from a compiled bundle, it only mounts once a visitor works the 2D canvas,
 * and `localStorage["ss_gate_<clientId>"]` suppresses it forever afterwards. A reviewer with
 * a browser sees nothing; a reviewer with curl sees less.
 *
 * Twilio's own remediation for 30924 asks for "a public URL or hosted screenshot showing the
 * complete consent language as it appears to the consumer". This is that URL.
 *
 * ⚠️ PLAIN TEXT, AND NOT BY PREFERENCE — MEASURED. The Supabase functions gateway REWRITES
 * the response type on this origin: a `text/html` body comes back as `Content-Type:
 * text/plain` with `content-security-policy: default-src 'none'; sandbox` injected over
 * whatever we set. Verified against the live deploy on 2026-09-03. So an HTML version of this
 * page renders in a reviewer's browser as raw markup — worse than useless, because a
 * screenshot of source code reads as a broken site. A clean text document renders natively
 * everywhere, screenshots fine, and is trivially machine-readable.
 * **Do not "improve" this into HTML** unless the page has moved to a custom domain, and then
 * check the served `Content-Type` before believing it worked.
 *
 * DESIGN RULES, all of them load-bearing:
 *  1. **No JavaScript, no gate, no cookie.** The whole point is that a plain fetch sees the
 *     words. `verify_jwt = false`; a reviewer opens it cold, once, from an unknown network.
 *  2. **Public-safe fields ONLY.** The registered business name, the tenant's own campaign
 *     wording, their policy links. Never the EIN, the representative's name, phone or email,
 *     any Twilio SID, or anything out of `client_settings`. This page belongs to the internet.
 *  3. **The consent sentence comes from `_shared/smsConsentText.ts`**, the same generator the
 *     designer mirrors, so the page cannot claim wording the customer never saw.
 */

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

function page(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Short, so a builder who fixes a policy link is not shown a stale page by a proxy —
      // but not zero, because a reviewer loads it a few times while writing up their notes.
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

const RULE = "-".repeat(66);
const heading = (t: string) => `\n${t.toUpperCase()}\n${RULE}\n`;

/** Wrap at 78 columns so the document reads as a document in a browser, a terminal and a
 *  screenshot. Tenant text arrives as one long line otherwise. */
function wrap(s: string, width = 78): string {
  const words = String(s ?? "").replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line.length) line = w;
    else if (line.length + 1 + w.length <= width) line += " " + w;
    else { lines.push(line); line = w; }
  }
  if (line.length) lines.push(line);
  return lines.join("\n");
}

Deno.serve(withErrorLog("sms-optin-disclosure", async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (url.searchParams.get("warm") === "1") return new Response("ok", { status: 200 });

  const clientId = String(url.searchParams.get("client") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(clientId)) {
    return page("Not found.\n\nThis link needs a business to show.\n", 404);
  }

  // ⚠️ THE REGISTRATION ROW MAY NOT EXIST YET, AND THAT IS A SUPPORTED CASE. A builder needs
  // this URL BEFORE they submit — it is what their opt-in description points at — so the page
  // renders from whatever is there and names what is still missing rather than 404ing.
  const [{ data: cfg }, { data: reg }] = await Promise.all([
    admin.from("client_configs").select("company_name").eq("client_id", clientId).maybeSingle(),
    admin.from("sms_registrations")
      .select("legal_business_name, campaign_description, privacy_policy_url, terms_url, campaign_message_samples")
      .eq("client_id", clientId).maybeSingle(),
  ]);
  if (!cfg) return page("Not found.\n\nWe could not find that business.\n", 404);

  const brandName = String(cfg.company_name || "").trim();
  const legalName = String(reg?.legal_business_name || "").trim();
  const name = brandName || legalName || clientId;
  const consent = smsConsentSentence(brandName);
  const about = String(reg?.campaign_description || "").trim();
  const privacy = String(reg?.privacy_policy_url || "").trim();
  const terms = String(reg?.terms_url || "").trim();
  const samples = Array.isArray(reg?.campaign_message_samples)
    ? reg!.campaign_message_samples.map((s: unknown) => String(s ?? "").trim()).filter(Boolean).slice(0, 5)
    : [];

  const out: string[] = [];
  out.push(`${name.toUpperCase()} — TEXT MESSAGE PROGRAM`);
  out.push("=".repeat(66));
  out.push("");
  out.push(wrap(
    `This page shows exactly how ${name} asks its customers for permission to send them ` +
    `text messages, and what those messages are about.`,
  ));
  // A DBA is not a discrepancy — but only if the page says so. A reviewer is matching this
  // against a brand registration filed under the legal name.
  if (legalName && legalName.toLowerCase() !== name.toLowerCase()) {
    out.push("");
    out.push(wrap(`Registered business name: ${legalName}`));
  }

  out.push(heading("What we text about"));
  out.push(wrap(about || (
    `We text customers who have asked us for a quote, about their quote, their invoice, and ` +
    `the build and delivery of the building they ordered.`
  )));

  out.push(heading("How customers agree to be texted"));
  out.push(wrap(
    `Customers give permission on our online quote form, before they send us their details. ` +
    `The box below appears on that form. It is not ticked for them, and they can use the ` +
    `form without ticking it.`,
  ));
  out.push("");
  out.push("    [ ] " + wrap(consent, 72).split("\n").join("\n        "));

  out.push(heading("The terms of these messages"));
  out.push("  * Message frequency varies.");
  out.push("  * Message and data rates may apply.");
  out.push("  * Reply STOP at any time to stop receiving messages.");
  out.push("  * Reply HELP for help.");
  out.push("  * " + wrap(
    "Mobile numbers and texting permission are never shared or sold to anyone else for " +
    "marketing or promotional purposes.", 74,
  ).split("\n").join("\n    "));

  if (samples.length) {
    out.push(heading("Examples of what we send"));
    for (const s of samples) out.push("  * " + wrap(s, 74).split("\n").join("\n    "));
  }

  out.push(heading("Our policies"));
  out.push("  Privacy policy: " + (privacy || "not published yet"));
  out.push("  Terms:          " + (terms || "not published yet"));

  out.push("");
  out.push(RULE);
  out.push(wrap(
    `Published by ${legalName || name} for its own customers. Messages are sent only to ` +
    `people who asked ${name} for a quote and agreed to be texted.`,
  ));
  out.push("");

  return page(out.join("\n"));
}));
