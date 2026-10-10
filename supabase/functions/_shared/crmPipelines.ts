// Sales pipelines in the built-in CRM (migration 301): the request shapes, parsed and refused here
// so every rule runs in a unit test (crmPipelines.test.ts) without a database. portal-settings owns
// the gates, the contact scope and the database; this file owns "what did the browser ask for".
//
// Carolyn 2026-10-09: reps cold-calling shed manufacturers work those prospects in a pipeline
// inside Structure Studio, and each one lands in the CRM's contacts. Built for every CRM builder.
//
// A DEAL HAS NO OWNER OF ITS OWN (Carolyn 2026-09-04: "we do not ever assign deals. We only assign
// contacts and followers"). Nothing here accepts one; who sees a deal is who sees its contact.
//
// Self-contained on purpose (no jsr:/npm: imports): preflight runs `_shared/*.test.ts` offline.

export type Parsed<T> = ({ ok: true } & T) | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuidLike = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** The stage kinds automation keys on. Names are the tenant's to edit; kinds are not. */
export const STAGE_KINDS = ["open", "won", "lost"] as const;
export type StageKind = typeof STAGE_KINDS[number];

/** Caps that match the CHECKs in 301, so a long value gets a sentence rather than a 23514. */
export const PIPELINE_NAME_MAX = 80;
export const STAGE_NAME_MAX = 60;
export const DEAL_TITLE_MAX = 200;
export const LOST_REASON_MAX = 200;
export const LOST_REASONS_MAX = 30;
/** One import call. The portal sends bigger files in pages of this size. */
export const IMPORT_PAGE_MAX = 200;

const str = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Money from a person: "$12,500", "12500.50", 12500 → cents. "" / null → null (no value).
 * undefined → undefined (not being edited). Anything else that is not a non-negative amount is
 * refused rather than guessed at.
 */
export function parseMoneyCents(v: unknown): number | null | undefined | "bad" {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const s = typeof v === "number" ? String(v) : String(v).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return "bad";
  const cents = Math.round(Number(s) * 100);
  return Number.isSafeInteger(cents) ? cents : "bad";
}

/** A yyyy-mm-dd date or "" (clear). undefined = not being edited. */
export function parseDay(v: unknown): string | null | undefined | "bad" {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s + "T00:00:00Z"))) return "bad";
  return s;
}

/** An instant (ISO string) or "" (clear). undefined = not being edited. */
export function parseInstant(v: unknown): string | null | undefined | "bad" {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "bad";
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Digits a phone must carry to be worth dialling (crm_phone_key keeps 10 for a US number). */
const phoneDigits = (p: string) => p.replace(/\D/g, "");

// ── A new lead (crm_create_lead) ─────────────────────────────────────────────────────────
export type LeadIn = {
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  ownerUserId: string | null;
  stageId: string | null;
  title: string | null;
  valueCents: number | null;
};

/** One lead from "+ Add lead", an import row, or a booking. Same rules for all three. */
export function parseLead(b: Record<string, unknown>): Parsed<LeadIn> {
  const name = str(b.name, 200);
  const company = str(b.company, 200);
  const phone = str(b.phone, 40);
  const email = str(b.email, 320);
  if (!name && !company) return { ok: false, error: "Give the lead a name or a company." };
  if (!phone && !email) return { ok: false, error: "A lead needs a phone number or an email so someone can reach them." };
  if (phone && phoneDigits(phone).length < 7) return { ok: false, error: "That phone number is too short to dial." };
  if (email && !EMAIL.test(email)) return { ok: false, error: "That doesn't look like an email address." };
  const owner = str(b.ownerUserId, 64);
  if (owner && !isUuidLike(owner)) return { ok: false, error: "Pick the owner from the list — that isn't a team member." };
  const stage = str(b.stageId, 64);
  if (stage && !isUuidLike(stage)) return { ok: false, error: "Pick a stage from the list." };
  const money = parseMoneyCents(b.value);
  if (money === "bad") return { ok: false, error: "The deal value should be an amount, like 2500 or $2,500." };
  return {
    ok: true, name, company, phone, email,
    ownerUserId: owner ? owner.toLowerCase() : null,
    stageId: stage ? stage.toLowerCase() : null,
    title: str(b.title, DEAL_TITLE_MAX),
    valueCents: money ?? null,
  };
}

// ── Editing a deal (crm_deal_update) ─────────────────────────────────────────────────────
export type DealPatch = {
  title?: string | null;
  value_cents?: number | null;
  expected_close_date?: string | null;
  next_follow_up_at?: string | null;
};

/** Only the fields present are changed; "" clears one. Nothing to change is refused. */
export function parseDealPatch(b: Record<string, unknown>): Parsed<{ patch: DealPatch }> {
  const patch: DealPatch = {};
  if (b.title !== undefined) patch.title = str(b.title, DEAL_TITLE_MAX);
  const money = parseMoneyCents(b.value);
  if (money === "bad") return { ok: false, error: "The deal value should be an amount, like 2500 or $2,500." };
  if (money !== undefined) patch.value_cents = money;
  const close = parseDay(b.expectedCloseDate);
  if (close === "bad") return { ok: false, error: "That close date isn't a date we can read." };
  if (close !== undefined) patch.expected_close_date = close;
  const follow = parseInstant(b.nextFollowUpAt);
  if (follow === "bad") return { ok: false, error: "That follow-up date isn't a date we can read." };
  if (follow !== undefined) patch.next_follow_up_at = follow;
  if (!Object.keys(patch).length) return { ok: false, error: "Nothing to change." };
  return { ok: true, patch };
}

// ── Pipelines and stages (Settings → CRM → Pipelines) ────────────────────────────────────
export type PipelineIn = { id: string | null; name: string | null; lostReasons: string[] | null; archive: boolean };

export function parsePipelineSave(b: Record<string, unknown>): Parsed<PipelineIn> {
  const id = str(b.id, 64);
  if (id && !isUuidLike(id)) return { ok: false, error: "That pipeline wasn't found." };
  const name = str(b.name, PIPELINE_NAME_MAX + 1);
  if (name && name.length > PIPELINE_NAME_MAX) return { ok: false, error: `Keep the pipeline name under ${PIPELINE_NAME_MAX} characters.` };
  if (!id && !name) return { ok: false, error: "Name the new pipeline." };
  let lostReasons: string[] | null = null;
  if (b.lostReasons !== undefined) {
    if (!Array.isArray(b.lostReasons)) return { ok: false, error: "Lost reasons should be a list." };
    const seen = new Set<string>();
    lostReasons = [];
    for (const r of b.lostReasons) {
      const v = str(r, LOST_REASON_MAX);
      if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); lostReasons.push(v); }
    }
    if (lostReasons.length > LOST_REASONS_MAX) return { ok: false, error: `Keep it to ${LOST_REASONS_MAX} lost reasons.` };
  }
  return { ok: true, id: id ? id.toLowerCase() : null, name, lostReasons, archive: b.archive === true };
}

export type StageIn = {
  id: string | null; pipelineId: string | null; name: string | null;
  color: string | null; kind: StageKind | null; archive: boolean;
};

export function parseStageSave(b: Record<string, unknown>): Parsed<StageIn> {
  const id = str(b.id, 64);
  if (id && !isUuidLike(id)) return { ok: false, error: "That stage wasn't found." };
  const pipelineId = str(b.pipelineId, 64);
  if (!id && !isUuidLike(pipelineId)) return { ok: false, error: "Pick the pipeline the stage belongs to." };
  const name = str(b.name, STAGE_NAME_MAX + 1);
  if (name && name.length > STAGE_NAME_MAX) return { ok: false, error: `Keep the stage name under ${STAGE_NAME_MAX} characters.` };
  if (!id && !name) return { ok: false, error: "Name the new stage." };
  const color = str(b.color, 7);
  if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) return { ok: false, error: "Pick a colour from the list." };
  const kindRaw = str(b.kind, 8);
  if (kindRaw && !(STAGE_KINDS as readonly string[]).includes(kindRaw)) return { ok: false, error: "A stage is open, won or lost." };
  return {
    ok: true, id: id ? id.toLowerCase() : null, pipelineId: pipelineId ? pipelineId.toLowerCase() : null,
    name, color, kind: (kindRaw as StageKind) ?? null, archive: b.archive === true,
  };
}

/** A full ordering of one pipeline's stages: every id exactly once. */
export function parseStageOrder(b: Record<string, unknown>): Parsed<{ pipelineId: string; ids: string[] }> {
  const pipelineId = str(b.pipelineId, 64);
  if (!isUuidLike(pipelineId)) return { ok: false, error: "Pick the pipeline to reorder." };
  if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 50) return { ok: false, error: "Send the stages in their new order." };
  const ids = b.ids.map((v) => String(v).toLowerCase());
  if (ids.some((v) => !isUuidLike(v)) || new Set(ids).size !== ids.length) return { ok: false, error: "Send each stage once." };
  return { ok: true, pipelineId: pipelineId.toLowerCase(), ids };
}

/**
 * The rule a pipeline's stage list must keep after any change: at least one OPEN stage, because
 * a new lead has to start somewhere. Won and lost stages are optional (a pipeline used as a
 * call list may have neither). Returns the sentence to refuse with, or null.
 */
export function stageSetRefusal(kinds: StageKind[]): string | null {
  if (!kinds.includes("open")) return "A pipeline needs at least one open stage for new leads to start in.";
  return null;
}
