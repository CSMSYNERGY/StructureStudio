// jack-agent: the one way to Claude, and what a call cost. Handed its fetch so the tests never touch the
// network. A direct HTTP call rather than the SDK, the same as support-agent and doorGenerate: the edge
// functions keep no npm dependencies, and every Claude call here is testable through that one stub.

export const CHAT_MODEL = "claude-sonnet-5-5";
/** Ahsan, 11-03: Opus reads price lists, Sonnet does the everyday chat. To be compared on real sheets. */
export const READ_MODEL = "claude-opus-5-5";

/** List prices in micros (millionths of a dollar) per token: input, output, 5-minute cache write, cache read. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-sonnet-5-5": [2, 10, 2.5, 0.2],
  "claude-sonnet-5": [2, 10, 2.5, 0.2],
  "claude-opus-5-5": [4, 20, 5, 0.2],
  "claude-opus-5": [5, 25, 6.25, 0.5],
  "claude-opus-4-8": [5, 25, 6.25, 0.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.125, 0.01],
};
/** An unknown model is priced high rather than free, so the ceiling still bites. */
const UNKNOWN_PRICE: [number, number, number, number] = [10, 50, 12.5, 1];
/** Models that accept `fallbacks: "default"`. Anything else would 400 on the field. */
const FALLBACK_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1"]);

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costMicros: number;
}
export const zeroTotals = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0 });

const nz = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** One response's usage, priced by the model that really answered (a fallback may differ). */
export function addUsage(t: Totals, usage: unknown, model: string): Totals {
  const u = (usage ?? {}) as Record<string, unknown>;
  const [pin, pout, pcw, pcr] = PRICES[model] ?? UNKNOWN_PRICE;
  const input = nz(u.input_tokens), output = nz(u.output_tokens);
  const cw = nz(u.cache_creation_input_tokens), cr = nz(u.cache_read_input_tokens);
  return {
    input: t.input + input,
    output: t.output + output,
    cacheWrite: t.cacheWrite + cw,
    cacheRead: t.cacheRead + cr,
    costMicros: t.costMicros + Math.round(input * pin + output * pout + cw * pcw + cr * pcr),
  };
}

export type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown };
export interface ClaudeBody { stop_reason?: string; content?: Block[]; usage?: unknown; model?: string; stop_details?: { category?: string | null } | null }
export type Ask = { ok: true; body: ClaudeBody } | { ok: false; why: "timeout" | "unreachable" | "http" | "limit" | "parse"; status?: number; retryAfterSec?: number; detail?: string };

/** The API's own reason for a refused request (`error.type: error.message`), for the log only. A 4xx
 *  describes the REQUEST (a field, a schema, a limit), which is what makes a 400 fixable; the first real
 *  call on beta (11-09) failed with nothing to go on. Anything shaped like an email or a long number is
 *  masked, control characters go, and it's capped, so a message that ever echoed a customer's words
 *  still can't carry their details into app_errors. Never shown to the person. */
export function apiReason(text: string): string {
  let t = "";
  try {
    const e = (JSON.parse(text) as { error?: { type?: unknown; message?: unknown } })?.error;
    t = [typeof e?.type === "string" ? e.type : "", typeof e?.message === "string" ? e.message : ""].filter(Boolean).join(": ");
  } catch {
    return "";
  }
  return Array.from(t, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("")
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[number]")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const RETRY_DELAYS_MS = [1500, 4000];
const TRANSIENT = new Set([429, 500, 502, 503, 529]);

/** Asks, and asks again after a blip Anthropic says is temporary. The timeout is one deadline across
 *  every attempt, so a read's budget doesn't grow. A timeout, an unreachable host or a body that won't
 *  parse is never re-sent, because that call may already have been billed. Tools run outside this
 *  function, so a retry can't make a second proposal. */
export async function askClaude(f: Fetcher, apiKey: string, body: Record<string, unknown>, timeoutMs: number): Promise<Ask> {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; ; i++) {
    const r = await askOnce(f, apiKey, body, deadline - Date.now());
    if (r.ok || r.why !== "http" || !TRANSIENT.has(r.status ?? 0) || i >= RETRY_DELAYS_MS.length) return r;
    const wait = Math.max(RETRY_DELAYS_MS[i] + Math.random() * 400, (r.retryAfterSec ?? 0) * 1000);
    if (deadline - Date.now() - wait < 15_000) return r;
    await new Promise((done) => setTimeout(done, wait));
  }
}

async function askOnce(f: Fetcher, apiKey: string, body: Record<string, unknown>, timeoutMs: number): Promise<Ask> {
  if (timeoutMs <= 1000) return { ok: false, why: "timeout" };
  const ac = new AbortController();
  // Armed until the body has been read: headers can arrive and the body stall.
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const fallback = FALLBACK_MODELS.has(String(body.model));
  try {
    const res = await f("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // A request the model's safeguards decline in a category the fallback covers is re-run on the
        // model Anthropic picks for it, instead of a refusal.
        ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(fallback ? { ...body, fallbacks: "default" } : body),
      signal: ac.signal,
    });
    if (!res.ok) {
      // A console spend limit answers 400 "You have reached your specified ... API usage limits": told
      // apart here. Any other 4xx keeps the API's reason, masked (apiReason), for the log only.
      const text = await res.text().catch(() => "");
      if (res.status === 400 && /API usage limits/i.test(text)) return { ok: false, why: "limit", status: 400 };
      const after = Number(res.headers.get("retry-after"));
      const detail = res.status >= 400 && res.status < 500 ? apiReason(text) : "";
      return { ok: false, why: "http", status: res.status, ...(Number.isFinite(after) && after > 0 ? { retryAfterSec: after } : {}), ...(detail ? { detail } : {}) };
    }
    try {
      return { ok: true, body: await res.json() as ClaudeBody };
    } catch {
      return { ok: false, why: ac.signal.aborted ? "timeout" : "parse" };
    }
  } catch {
    return { ok: false, why: ac.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** The text of a response, for the two calls whose whole answer is one JSON object. */
export function jsonFrom(body: ClaudeBody): unknown | null {
  const text = (body.content ?? []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
