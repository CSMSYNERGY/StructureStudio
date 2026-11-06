// "Send it to a webhook", an automation action (migration 370): what the call carries, how it is
// signed, and the one POST. The tick (crm-rules-tick) is the only caller.
//
// The address is a builder's (a Zapier or Make catch hook, their own server), so it is treated as
// a stranger's URL, the same as the SMS compliance check treats a policy page: safeFetchText's guard
// decides whether we open it at all, and a redirect is never followed. A 3xx is a refusal, because
// following one is how an allowed address hands us to one the guard would have refused.
//
// ⚠️ THE ANSWER'S BODY IS NEVER READ. Only the status code is used, and it is all the run log gets.
// That keeps safeFetchText's exfiltration invariant: nothing a fetched address says reaches a row,
// a log line or a browser.
//
// Pure apart from the fetch it is handed and the clock, so ruleWebhook.test.ts runs offline.

import { guardUrl } from "./safeFetchText.ts";

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_USER_AGENT = "StructureStudio-Automations/1";

export type WebhookContact = {
  id: string; name: string | null; email: string | null; phone: string | null;
  company: string | null; labels: string[] | null;
};
export type WebhookCard = { id: string; title: string | null; short_code: string | null; value_cents: number | null };
export type WebhookRule = {
  id: string; name: string | null; trigger_kind: string | null; trigger_event: string | null;
  elapsed_anchor: string | null; elapsed_days: number | null; schedule: { freq?: string } | null;
};

/**
 * What the receiving system gets. Kept small and stable: who the rule is about, which rule, and
 * when. `id` is the same on every try of one delivery, so a receiver that saw it already can drop
 * the repeat (a try whose answer we never heard is tried again).
 */
export function webhookPayload(f: {
  deliveryId: string; firedAt: string; business: string;
  rule: WebhookRule; contact: WebhookContact | null; card: WebhookCard | null;
}) {
  const r = f.rule;
  const trigger = r.trigger_kind === "event" ? { kind: "event", event: r.trigger_event }
    : r.trigger_kind === "elapsed" ? { kind: "elapsed", anchor: r.elapsed_anchor, days: r.elapsed_days }
    : r.trigger_kind === "schedule" ? { kind: "schedule", freq: r.schedule?.freq ?? null }
    : { kind: r.trigger_kind };
  const c = f.contact;
  const name = String(c?.name ?? "").trim();
  return {
    type: "automation.fired",
    id: f.deliveryId,
    firedAt: f.firedAt,
    rule: { id: r.id, name: r.name ?? null, trigger },
    contact: c ? {
      id: c.id,
      name: name || null,
      firstName: name ? name.split(/\s+/)[0] : null,
      email: c.email || null,
      phone: c.phone || null,
      company: c.company || null,
      tags: Array.isArray(c.labels) ? c.labels : [],
    } : null,
    card: f.card ? { id: f.card.id, title: f.card.title || null, code: f.card.short_code || null, valueCents: f.card.value_cents ?? null } : null,
    business: { name: f.business || null },
  };
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * `X-SS-Signature: t=<unix seconds>,v1=<hex>`, where hex is HMAC-SHA256 over `<t>.<raw body>` keyed
 * with the secret AS TYPED (its 64 characters, not the bytes they spell). The editor tells a
 * receiver exactly this, so it is pinned by a known-answer test.
 */
export async function webhookSignature(secret: string, timestamp: number, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`));
  return `t=${timestamp},v1=${hex(mac)}`;
}

export type WebhookOutcome =
  | { ok: true; status: number }
  | { ok: false; status: number | null; retry: boolean; error: string };

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export async function postWebhook(
  fetchFn: FetchFn, rawUrl: string, secret: string | null, payload: unknown, deliveryId: string, now = Date.now(),
): Promise<WebhookOutcome> {
  // Again here, not only at save: a stored address is a row, and rows can be edited by hand.
  const g = guardUrl(rawUrl);
  if (!g.ok) return { ok: false, status: null, retry: false, error: g.reason };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": WEBHOOK_USER_AGENT,
    "X-SS-Delivery": deliveryId,
  };
  if (secret) headers["X-SS-Signature"] = await webhookSignature(secret, Math.floor(now / 1000), body);
  let res: Response;
  try {
    res = await fetchFn(g.url.toString(), {
      method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (e) {
    const n = (e as Error)?.name;
    return { ok: false, status: null, retry: true,
      error: n === "TimeoutError" || n === "AbortError" ? "That address took too long to answer." : "We could not reach that address." };
  }
  try { await res.body?.cancel(); } catch { /* nothing to free */ }
  const st = res.status;
  if (st >= 200 && st < 300) return { ok: true, status: st };
  if (res.type === "opaqueredirect" || (st >= 300 && st < 400)) {
    return { ok: false, status: st || null, retry: false, error: "That address forwards somewhere else. Use the address it forwards to." };
  }
  if (st === 408 || st === 429 || st >= 500) {
    return { ok: false, status: st, retry: true, error: `The receiving system was busy or down (HTTP ${st}).` };
  }
  return { ok: false, status: st, retry: false, error: `The receiving system refused it (HTTP ${st}).` };
}
