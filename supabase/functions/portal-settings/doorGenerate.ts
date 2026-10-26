// Settings → Options → Doors → "Make a 3D look from a photo" (plan "Door looks from a photo",
// 2026-10-24, phase P4): generate_door_look, the only door-look action that can charge, and
// generate_door_look_recover, which hands a draft back after a dropped stream. index.ts names both in
// GATES (settings_options, edit) and answers generate_door_look behind the heartbeat (doorDraftAnswer).
//
// WHAT RUNS WHERE. The press's model work (Stage A, the close-ups, the agreement check, Stage B, the
// $3.00 ceiling) is _shared/doorGenerate.ts's runDoorDraft; the prompt is _shared/doorLookPrompt.ts; the
// maths on the reads is _shared/doorLook.ts (P1). This file is the press around them: the gates, the
// ledger (ai_door_calls, 337), the money (wallet_hold on the door_look_generation meter), the photos,
// the Draft look row, and the answers in the builder's words.
//
// THE ORDER OF CHECKS IN generate_door_look (section 4), every refusal before step 9 costing nothing:
//   1. the kill switch DOOR_LOOK_AI_ENABLED (unset is off) and the tenant flag door_looks_beta. Both fail closed.
//   2. 3D access on the server: usableFeatureSet(['view_3d']), grants and payments, internal and
//      billing-exempt accounts counted. A throw refuses.
//   3. the request: photo paths of the exact shape for this tenant (the body never carries a URL), the
//      door's size, single or double, the press's key.
//   4. the API key.
//   5. no door generation of this tenant's still running (a ledger row under 6 minutes old).
//   6. the daily cap, counted as distinct keys over 24 hours leaving this press's own key out, and FAILING
//      CLOSED (buildings fail open; doors do not). A key owns at most two rows (the try and its lean
//      retry); a key that already drafted is refused; a retry with under 150 s of the press clock left is
//      refused as the timeout it is. Then the photos are read and their headers checked.
//   7. the ledger row (idem_key is NOT unique: 337). A failed insert refuses.
//   8. the recount with the row in: the cap again, and more than one running row is a 409. On either
//      refusal this press's own row is deleted first.
//   9. wallet_hold on every press, as buildings do: meter_inactive goes ahead free, hold_replayed is a 409
//      already_charged with this press's row deleted and no hold, capture or release.
//  10. the model work, inside the press clock and the ceiling. On a draft: the Draft door_looks row, THEN
//      wallet_capture, THEN the ledger row done. On every other end: the hold released, the row failed.
//
// THE PRESS CLOCK is 8 minutes from the key's FIRST ledger row; every call of the press's work ends 15 s
// before it (doorPressLeftMs). Tenants and users in the tests are made up; the repo is public.

import { usableFeatureSet } from "../_shared/featureCheck.ts";
import { logEdgeError } from "../_shared/logError.ts";
import { runAutoTopup } from "../_shared/walletAutoTopup.ts";
import { cutCloseUps, imageLibrary, loadImageLibrary, untilAborted } from "../_shared/closeUp.ts";
import { type RGB, samplePatch, type XY } from "../_shared/doorLook.ts";
import { type DraftRecoverMoneyRow, draftIdemKey, draftMoneyState, type DraftMoney } from "../_shared/styleD3.ts";
import {
  DOOR_DEFAULT_DAILY_CAP,
  DOOR_FAILURE_TEXT,
  DOOR_KEY_MAX_ROWS,
  DOOR_LEAN_MIN_LEFT_MS,
  DOOR_PRESS_CLOCK_MS,
  DOOR_PRESS_WARNINGS,
  DOOR_RECOVER_COLUMNS,
  DOOR_RUNNING_FRESH_MS,
  DoorCeiling,
  type DoorDraftResult,
  doorLedgerCore,
  doorLedgerFields,
  doorPressSpentCents,
  doorPressStartOf,
  type DoorRecoverRow,
  imageHeadOf,
  pickDoorRecoverRow,
  recoverDoorAnswer,
  runDoorDraft,
  doorWorkDeadline,
} from "../_shared/doorGenerate.ts";
import { type DoorCloseUpKind, type DoorImageSource, DOOR_PHOTO_MAX_BYTES, doorPhotoFits } from "../_shared/doorLookPrompt.ts";
import { DOOR_LOOK_NAME_MAX, DOOR_LOOKS_OFF, DOOR_LOOKS_UNAVAILABLE, doorRefPathOk, readDoorLooksFlag, type Refusal } from "./doorLooks.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
type Rec = Record<string, unknown>;
export type DoorGenCtx = {
  admin: Db;
  req: Request;
  clientId: string;
  userId: string | null;
  payload: Rec;
  json: (b: unknown, s?: number) => Response;
  // Marks an answer whose app_errors row was already written here, so the error wrapper adds no copy.
  filed: (res: Response) => Response;
  requestStartMs: number;
  workerBornMs: number;
};

// The image library and the clock, as the press reaches them: a field, so a wiring test can hand in a
// stand-in library (the real one loads its WebAssembly from the network, which the gate never allows).
export const doorGenHooks: { loadImageLibrary: typeof loadImageLibrary } = { loadImageLibrary };

// The meter, and the wallet key a press's hold is filed under: its own namespace, so a door press's key
// can never meet a building press's in wallet_transactions' one-key-per-tenant index.
export const DOOR_METER = "door_look_generation";
export const doorWalletKey = (idemKey: string) => `door:${idemKey}`;
export const DOOR_REFS_BUCKET = "door-refs";
// The model reads the photos through signed URLs this short (section 7).
export const DOOR_SIGNED_URL_S = 600;
// How long the photo's decode may take before the press goes on without colours and close-ups.
const DOOR_DECODE_MS = 20_000;
const DOOR_DEFAULT_NAME = "Door look from a photo";
// The door's real size, in inches: generous bounds, only there to refuse nonsense before any money.
const WIDTH_IN = [12, 240] as const;
const HEIGHT_IN = [24, 192] as const;
const MIN_PHOTO_SIDE = 200;

// ── The kill switch ───────────────────────────────────────────────────────────────────────────
// DOOR_LOOK_AI_ENABLED gates the two actions that call the model (generate_door_look here, and P5's
// door_look_check). Unset, empty or anything but "1" / "true" is OFF.
export function doorAiEnabled(): boolean {
  const v = (Deno.env.get("DOOR_LOOK_AI_ENABLED") ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}
export const DOOR_AI_OFF: Refusal = { status: 403, code: "door_looks_ai_off", error: "Making door looks from photos is turned off right now." };
export const DOOR_NO_3D: Refusal = { status: 403, code: "ai_door_no_3d", error: "Making door looks from photos needs 3D on your account." };
const BUSY: Refusal = { status: 409, code: "door_look_busy", error: "A door look is already being made. Wait for it to finish." };
const UNAVAILABLE = (code: string): Refusal => ({ status: 503, code, error: DOOR_FAILURE_TEXT.unavailable });
const CAP_UNREAD: Refusal = { status: 503, code: "ai_door_cap_unread", error: "We couldn't check today's count. Try again in a few minutes." };
const capReached = (cap: number): Refusal => ({
  status: 429, code: "ai_door_daily_cap",
  error: `You've pressed Generate ${cap} times in the last 24 hours, which is your limit. You can press again once your oldest press is 24 hours old.`,
});

// ── The request ───────────────────────────────────────────────────────────────────────────────
export type DoorGenInput = {
  widthIn: number;
  heightIn: number;
  leaves: 1 | 2;
  name: string;
  idemKey: string;
  lean: boolean;
  paths: { front: string } & Partial<Record<DoorCloseUpKind, string>>;
};
const bad = (code: string, error: string): { ok: false; refuse: Refusal } => ({ ok: false, refuse: { status: 400, code, error } });
export function parseDoorGenerate(p: Rec, clientId: string): { ok: true; v: DoorGenInput } | { ok: false; refuse: Refusal } {
  const idemKey = draftIdemKey(p.idempotencyKey);
  if (!idemKey) return bad("door_look_key", "That press is missing its key. Reload the page and try again.");
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  const widthIn = num(p.widthIn), heightIn = num(p.heightIn);
  if (!(widthIn >= WIDTH_IN[0] && widthIn <= WIDTH_IN[1]) || !(heightIn >= HEIGHT_IN[0] && heightIn <= HEIGHT_IN[1])) {
    return bad("door_look_size", "Type the door's width and height in inches.");
  }
  if (p.leaves !== 1 && p.leaves !== 2) return bad("door_look_leaves", "Pick single or double.");
  const leaves = p.leaves as 1 | 2;
  const name = typeof p.name === "string" ? p.name.trim().replace(/\s+/g, " ") : "";
  if (name.length > DOOR_LOOK_NAME_MAX) return bad("door_look_name", `Keep the name to ${DOOR_LOOK_NAME_MAX} characters or fewer.`);
  // The photos: paths door_ref_upload_url handed out to THIS tenant, of the exact shape (a prefix check
  // is beaten by `..`), each once. Never a URL: the server signs its own.
  const photos = p.photos && typeof p.photos === "object" && !Array.isArray(p.photos) ? p.photos as Rec : {};
  const front = photos.front;
  if (!doorRefPathOk(clientId, front)) return bad("door_look_photo", "Upload the door's photo again, then press Generate.");
  const paths: DoorGenInput["paths"] = { front };
  for (const k of ["hinge", "handle", "meet"] as const) {
    const v = photos[k];
    if (v === undefined || v === null || v === "") continue;
    if (!doorRefPathOk(clientId, v)) return bad("door_look_photo", "Upload your close-ups again, then press Generate.");
    if (k === "meet" && leaves !== 2) continue; // a single door has no meeting edge
    paths[k] = v;
  }
  const all = Object.values(paths);
  if (new Set(all).size !== all.length) return bad("door_look_photo", "Each photo can be used once. Upload them again.");
  for (const k of Object.keys(photos)) if (!["front", "hinge", "handle", "meet"].includes(k)) return bad("door_look_photo", "Upload your photos again, then press Generate.");
  return { ok: true, v: { widthIn, heightIn, leaves, name: name || DOOR_DEFAULT_NAME, idemKey, lean: p.lean === true, paths } };
}

// Whether generate_door_look answers behind the heartbeat: the new shell's `stream: true`, on the first
// try and on the lean retry alike (both can need more than the gateway's 150 s of silence).
export function wantsStreamedDoorDraft(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Rec).stream === true;
}

// ── generate_door_look ────────────────────────────────────────────────────────────────────────
export async function handleGenerateDoorLook(x: DoorGenCtx, streamed: boolean): Promise<Response> {
  const { admin, req, clientId, json } = x;
  const userId = x.userId ?? null;
  const refuse = (r: Refusal, extra: Rec = {}) => json({ error: r.error, code: r.code, ...extra }, r.status);
  const log = (code: string, message: string, context?: Rec, severity?: "error" | "info") =>
    logEdgeError({ fn: "portal-settings", req, clientId, code, message, ...(context ? { context } : {}), ...(severity ? { severity } : {}) });
  const loggedRefusal = async (r: Refusal, message: string, context?: Rec) => {
    await log(r.code, message, context);
    return x.filed(refuse(r));
  };

  // 1. The kill switch, then the tenant flag. Both fail closed.
  if (!doorAiEnabled()) return refuse(DOOR_AI_OFF);
  const flag = await readDoorLooksFlag(admin, clientId);
  if (flag.error) return await loggedRefusal(UNAVAILABLE("door_looks_flag_unread"), `Could not read door_looks_beta: ${String((flag.error as { message?: string })?.message ?? flag.error)}`);
  if (!flag.ready) return refuse(DOOR_LOOKS_UNAVAILABLE);
  if (!flag.on) return refuse(DOOR_LOOKS_OFF);

  // 2. 3D access, on the server. A grant or a payment, or an internal or billing-exempt account (which
  // the check treats as having every feature). A check that throws refuses: this is a paid action.
  let has3d = false;
  try {
    has3d = (await usableFeatureSet(admin, clientId, ["view_3d"])).has("view_3d");
  } catch (e) {
    return await loggedRefusal(DOOR_NO_3D, `The 3D check failed, refusing the door generation: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
  }
  if (!has3d) return refuse(DOOR_NO_3D);

  // 3. The request.
  const parsed = parseDoorGenerate(x.payload, clientId);
  if (!parsed.ok) return refuse(parsed.refuse);
  const v = parsed.v;

  // 4. The API key.
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return await loggedRefusal(UNAVAILABLE("ai_door_unconfigured"), "ANTHROPIC_API_KEY is unset; a door generation was refused.");

  // 5. Nothing else of this tenant's running.
  const nowMs = Date.now();
  const fresh = new Date(nowMs - DOOR_RUNNING_FRESH_MS).toISOString();
  const running = await admin.from("ai_door_calls").select("id").eq("client_id", clientId).eq("status", "running").gt("created_at", fresh).limit(2);
  if (running.error) return await loggedRefusal(UNAVAILABLE("ai_door_ledger_unread"), `Could not read the door ledger: ${running.error.message}`);
  if ((running.data ?? []).length) return refuse(BUSY);

  // 6. The daily cap (fails CLOSED), and this key's own rows.
  const capRow = await admin.from("client_settings").select("ai_door_daily_cap").eq("client_id", clientId).maybeSingle();
  if (capRow.error) return await loggedRefusal(CAP_UNREAD, `Could not read ai_door_daily_cap: ${capRow.error.message}`);
  const rawCap = capRow.data?.ai_door_daily_cap;
  const cap = typeof rawCap === "number" && Number.isInteger(rawCap) && rawCap >= 0 ? rawCap : DOOR_DEFAULT_DAILY_CAP;
  const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const keysIn24h = async (): Promise<{ keys: Set<string> } | { error: string }> => {
    const r = await admin.from("ai_door_calls").select("idem_key").eq("client_id", clientId).gt("created_at", since).limit(10_000);
    if (r.error) return { error: r.error.message };
    return { keys: new Set((r.data ?? []).map((row: Rec) => String(row.idem_key ?? "")).filter(Boolean)) };
  };
  if (cap > 0) {
    const k = await keysIn24h();
    if ("error" in k) return await loggedRefusal(CAP_UNREAD, `Could not count door generations: ${k.error}`);
    k.keys.delete(v.idemKey);
    if (k.keys.size >= cap) return refuse(capReached(cap));
  }
  const own = await admin.from("ai_door_calls").select("id, created_at, status, tokens, self_check_rounds, dims")
    .eq("client_id", clientId).eq("idem_key", v.idemKey).order("created_at", { ascending: true }).limit(DOOR_KEY_MAX_ROWS + 3);
  if (own.error) return await loggedRefusal(UNAVAILABLE("ai_door_ledger_unread"), `Could not read the press's rows: ${own.error.message}`);
  const ownRows: Rec[] = own.data ?? [];
  if (ownRows.some((r) => r.status === "done")) {
    return refuse({ status: 409, code: "door_look_already_made", error: "This door look is already made. It's in your Door looks list." });
  }
  if (ownRows.length >= DOOR_KEY_MAX_ROWS) return refuse(BUSY);
  // A second row under the key is the ONE lean retry, and the server, not the browser, says when one is
  // due: only after a first try that failed retryably, recorded with what it spent (so the retry can
  // never start with a fresh $3.00).
  if (ownRows.length) {
    const t = ownRows[0].tokens && typeof ownRows[0].tokens === "object" ? ownRows[0].tokens as Rec : {};
    const failure = t.failure && typeof t.failure === "object" ? t.failure as Rec : null;
    const due = v.lean && ownRows[0].status === "failed" && failure?.retryable === true && typeof t.ceilingCents === "number";
    if (!due) return refuse({ status: 409, code: "door_look_key_used", error: "This press is finished. Press Generate again to start a new one." });
  }
  // The press clock runs from the first try's request (kept on its row), never from a later write.
  const firstMs = ownRows.length ? doorPressStartOf(ownRows[0]) : NaN;
  // A retry under the key starts only with 150 s of the press clock left (section 4, Retries).
  if (ownRows.length && Number.isFinite(firstMs) && firstMs + DOOR_PRESS_CLOCK_MS - nowMs < DOOR_LEAN_MIN_LEFT_MS) {
    await log("ai_door_timeout", "A lean retry came with under 150 s of the press clock left and was refused without a model call.", { pressLeftMs: firstMs + DOOR_PRESS_CLOCK_MS - nowMs, lean: v.lean }, "info");
    return x.filed(json({ error: DOOR_FAILURE_TEXT.timeout, code: "ai_door_timeout" }, 504));
  }

  // The photos: read back from the private bucket, their type and size checked from the header before
  // anything is held. The front photo is also decoded (best effort) for the colour patches; the
  // close-ups are cut from the same bytes.
  const kinds = (["front", "hinge", "handle", "meet"] as const).filter((k) => v.paths[k]);
  const bytes: Partial<Record<(typeof kinds)[number], Uint8Array>> = {};
  for (const k of kinds) {
    const dl = await admin.storage.from(DOOR_REFS_BUCKET).download(v.paths[k]!);
    if (dl.error || !dl.data) return refuse({ status: 400, code: "door_photo_missing", error: "We couldn't find that photo. Upload it again, then press Generate." });
    const b = new Uint8Array(await dl.data.arrayBuffer());
    if (b.length > DOOR_PHOTO_MAX_BYTES) return refuse({ status: 400, code: "door_photo_too_big", error: "That photo is too big. Use one under 5 MB." });
    const head = imageHeadOf(b);
    if (!head) return refuse({ status: 400, code: "door_photo_type", error: "Door photos must be JPG, PNG or WebP." });
    // Every photo inside the limits (section 8), close-ups too: the ceiling prices each image at most
    // DOOR_IMAGE_TOKENS, which only holds for an image the API does not have to shrink.
    if (!doorPhotoFits([head.width, head.height])) return refuse({ status: 400, code: "door_photo_too_big", error: "This photo is bigger than we can read. Straighten it again, then press Generate." });
    if (Math.min(head.width, head.height) < MIN_PHOTO_SIDE) return refuse({ status: 400, code: "door_photo_small", error: "This photo is too small. Use one where the door fills most of the picture." });
    bytes[k] = b;
  }
  const frontBytes = bytes.front!;
  const frontHead = imageHeadOf(frontBytes)!;
  const photo: XY = [frontHead.width, frontHead.height];
  let colorAt: ((p: XY) => RGB | null) | undefined;
  let decodeError: string | null = null;
  try {
    // closeUp.ts's once-per-worker load: two imports of the library at once fail (closeUp.ts has why).
    const lib = await untilAborted(imageLibrary(doorGenHooks.loadImageLibrary), AbortSignal.timeout(DOOR_DECODE_MS));
    const img = await untilAborted(lib.decode(frontBytes), AbortSignal.timeout(DOOR_DECODE_MS));
    if (img instanceof lib.Image && img.width === photo[0] && img.height === photo[1]) {
      const rgba = img.bitmap, [w, h] = photo;
      colorAt = (p: XY) => samplePatch(rgba, w, h, p);
    } else decodeError = "the photo did not decode to its header's size";
  } catch (e) {
    decodeError = String(e instanceof Error ? e.message : e).slice(0, 200);
  }

  // 7. The ledger row: this press's try. The press clock started at the first try's request, which every
  // row of the key carries (dims.pressStartedAt), so the server's 8 minutes never end after the browser's.
  const pressStartMs = Number.isFinite(firstMs) ? Math.min(firstMs, x.requestStartMs) : x.requestStartMs;
  const pressStartedAt = new Date(pressStartMs).toISOString();
  const ins = await admin.from("ai_door_calls").insert({
    client_id: clientId, user_id: userId, idem_key: v.idemKey, status: "running",
    dims: { widthIn: v.widthIn, heightIn: v.heightIn, leaves: v.leaves, photo, pressStartedAt }, photo_paths: kinds.map((k) => v.paths[k]!),
    effort: v.lean ? "low" : "high", streamed,
  }).select("id, created_at").single();
  if (ins.error || !ins.data?.id) return await loggedRefusal(UNAVAILABLE("ai_door_ledger_failed"), `Could not write the door ledger row: ${ins.error?.message ?? "no row"}`);
  const rowId = String(ins.data.id);
  const dropRow = () => admin.from("ai_door_calls").delete().eq("client_id", clientId).eq("id", rowId);

  // 8. The recount, this row in: presses sent together all passed the reads above.
  if (cap > 0) {
    const k = await keysIn24h();
    if ("error" in k) {
      await dropRow();
      return await loggedRefusal(CAP_UNREAD, `Could not recount door generations: ${k.error}`);
    }
    if (k.keys.size > cap) {
      await dropRow();
      return refuse(capReached(cap));
    }
  }
  const again = await admin.from("ai_door_calls").select("id").eq("client_id", clientId).eq("status", "running").gt("created_at", fresh).limit(10);
  if (again.error || (again.data ?? []).length > 1) {
    await dropRow();
    if (again.error) return await loggedRefusal(UNAVAILABLE("ai_door_ledger_unread"), `Could not recount running door generations: ${again.error.message}`);
    return refuse(BUSY);
  }

  // 9. The money: wallet_hold on every press. While the meter is inactive this is free and holds nothing.
  let holdId: number | null = null;
  let priceCents: number | null = null;
  const hold = await admin.rpc("wallet_hold", { p_client_id: clientId, p_kind: DOOR_METER, p_idem: doorWalletKey(v.idemKey), p_user: userId }).maybeSingle();
  const holdErr = hold.error ? null : (hold.data?.err ?? null);
  if (hold.error) {
    await dropRow();
    return await loggedRefusal(UNAVAILABLE("ai_door_hold_failed"), `Wallet hold failed, refusing the door generation: ${hold.error.message}`);
  }
  if (holdErr === "insufficient_funds") {
    await dropRow();
    const price = hold.data?.price_cents ?? null, bal = hold.data?.balance_after ?? null;
    return refuse({
      status: 402, code: "insufficient_funds",
      error: `A door look costs $${((price ?? 0) / 100).toFixed(2)} and your wallet has $${((bal ?? 0) / 100).toFixed(2)}. Add funds in Settings → Billing, then try again.`,
    }, { priceCents: price, balanceCents: bal });
  }
  if (holdErr === "hold_in_flight") {
    await dropRow();
    return refuse(BUSY);
  }
  if (holdErr === "hold_replayed") {
    // Paid already, under this very key: no second hold, no capture, no release. The draft that press
    // paid for is already a Draft row in the list (the server writes it before it captures).
    await dropRow();
    await log("wallet_hold_replayed", "A door generation was pressed again under the key of one already charged; no second hold was taken.", { ledgerRow: rowId }, "info");
    return x.filed(json({ error: "We've already charged for this door look, and its draft is in your Door looks list. This press took no money.", code: "already_charged" }, 409));
  }
  if (holdErr === "meter_unknown") {
    await dropRow();
    return await loggedRefusal(UNAVAILABLE("ai_door_meter_missing"), `usage_prices has no ${DOOR_METER} row`);
  }
  if (holdErr && holdErr !== "meter_inactive") {
    await dropRow();
    return await loggedRefusal(UNAVAILABLE("ai_door_hold_failed"), `Wallet hold answered ${String(holdErr).slice(0, 60)}`);
  }
  if (!holdErr) {
    holdId = hold.data?.hold_id ?? null;
    priceCents = hold.data?.price_cents ?? null;
    // The balance just dropped: the one moment it can newly fall below the auto-recharge threshold
    // (buildings do the same; it never throws).
    if (holdId !== null) await runAutoTopup(admin, clientId, req, { fn: "portal-settings" });
  }

  // From here every exit captures (a draft) or releases (anything else). `settled`: that has happened.
  let settled = false;
  const releaseHold = async (reason: string) => {
    settled = true;
    if (holdId === null) return;
    const { error } = await admin.rpc("wallet_release", { p_hold_id: holdId, p_reason: reason.slice(0, 200) });
    if (error) await log("wallet_release_failed", `Could not release door hold ${holdId}: ${error.message}`);
  };
  const writeRow = async (fields: Rec) => {
    try {
      const { error } = await admin.from("ai_door_calls").update(fields).eq("client_id", clientId).eq("id", rowId);
      if (!error) return;
      await log("ai_door_ledger_write_failed", `Could not record the door generation, retrying with its outcome, spec and spend alone: ${error.message}`);
      await admin.from("ai_door_calls").update(doorLedgerCore(fields)).eq("client_id", clientId).eq("id", rowId);
    } catch (e) {
      await log("ai_door_ledger_write_failed", `The door ledger write threw: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    }
  };
  const failNow = async (code: string, message: string, status: number, reason: string) => {
    await releaseHold(reason);
    await writeRow({ status: "failed", draft_ms: Date.now() - nowMs, tokens: { failure: { code, message }, outcome: "failed" } });
    return await loggedRefusal({ status, code, error: message }, reason);
  };

  // A throw from here on (a bug, an unexpected rejection) must not leave the hold held and the row
  // running until the stale sweeps: it releases, marks the row failed, and rethrows for the error wrapper.
  try {
    // 10. The model work. The photos as 10-minute signed URLs from the private bucket.
    const signed: Partial<Record<(typeof kinds)[number], DoorImageSource>> = {};
    for (const k of kinds) {
      const s = await admin.storage.from(DOOR_REFS_BUCKET).createSignedUrl(v.paths[k]!, DOOR_SIGNED_URL_S);
      if (s.error || !s.data?.signedUrl) return await failNow("ai_door_sign_failed", DOOR_FAILURE_TEXT.unavailable, 503, `Could not sign a door photo for the model: ${s.error?.message ?? "no URL"}`);
      signed[k] = { url: String(s.data.signedUrl) };
    }
    const t0 = Date.now();
    const deadlineAt = doorWorkDeadline({ t0, requestStartMs: x.requestStartMs, workerBornMs: x.workerBornMs, streamed, pressStartMs });
    const lib = doorGenHooks.loadImageLibrary;
    const result: DoorDraftResult = await runDoorDraft({
      fetch: (url, init) => fetch(url, init),
      apiKey,
      ...(colorAt ? { colorAt } : {}),
      cut: (windows, zoom, signal) => cutCloseUps(frontBytes, () => windows, zoom, signal, lib).then((r) => r.closeUps.map((c) => c.base64)),
    }, {
      widthIn: v.widthIn, heightIn: v.heightIn, leaves: v.leaves, photo,
      front: signed.front!,
      builder: { ...(signed.hinge ? { hinge: signed.hinge } : {}), ...(signed.handle ? { handle: signed.handle } : {}), ...(signed.meet ? { meet: signed.meet } : {}) },
      lean: v.lean, deadlineAt, ceiling: new DoorCeiling(doorPressSpentCents(ownRows)),
    });
    const pressLeftAtEnd = pressStartMs + DOOR_PRESS_CLOCK_MS - Date.now();
    const context: Rec = {
      ms: result.ms, lean: v.lean, streamed, pressLeftMs: pressLeftAtEnd, budgetMs: deadlineAt - t0, costCents: result.costCents,
      reads: result.reads.map((r) => ({ status: r.status, threw: r.threw, aborted: r.aborted, stop: r.stop, attempts: r.attempts, ms: r.ms })),
      ...(decodeError ? { decodeError } : {}),
    };

    if (result.outcome !== "draft") {
      await releaseHold(result.outcome === "refused" ? "model refused the photo" : `door draft failed: ${result.failure?.kind ?? "unknown"}`);
      let status = 502, code: string, message: string, retryable = false;
      if (result.outcome === "refused" && result.refuse) {
        status = 422;
        code = result.refuse.code;
        message = result.refuse.text;
      } else {
        const f = result.failure!;
        // One automatic lean retry, and only with 150 s of the press clock left for it. Otherwise the press
        // ends here, said as the timeout it is when time was the reason.
        const clockOk = pressLeftAtEnd >= DOOR_LEAN_MIN_LEFT_MS;
        retryable = f.retryable && !v.lean && clockOk;
        if (f.retryable && !v.lean && !clockOk) result.skipped.leanRetryClock = true;
        code = f.code;
        message = f.kind === "timeout" || (f.retryable && !v.lean && !clockOk) ? DOOR_FAILURE_TEXT.timeout : f.message;
        if (f.kind === "timeout") code = "ai_door_timeout";
        status = f.kind === "timeout" ? 504 : f.kind === "ceiling" ? 503 : f.kind === "upstream" && f.message === DOOR_FAILURE_TEXT.busy ? 503 : 502;
        f.retryable = retryable;
        f.message = message;
        f.code = code;
      }
      await writeRow({ ...doorLedgerFields(result), status: "failed" });
      await log(code, result.outcome === "refused" ? `The door photo was refused (${result.refuse?.reason}).` : `The door draft failed: ${result.failure?.detail ?? result.failure?.kind}`,
        { ...context, ...(result.refuse ? { reason: result.refuse.reason } : {}), retryable }, result.outcome === "refused" ? "info" : "error");
      return x.filed(json({ error: message, code, ...(retryable ? { retryable: true } : {}), ...(result.refuse ? { reason: result.refuse.reason } : {}), pressStartedAt }, status));
    }

    // A draft. The Draft row first, so the press's look is in the builder's list before any money moves;
    // then the capture; then the ledger row done.
    const spec = result.spec!;
    const draftRow = await admin.from("door_looks").insert({
      client_id: clientId, name: v.name, base: spec.base, spec, spec_version: spec.v, status: "draft", ai_call_id: rowId, created_by: userId,
    }).select("id, name, base, status, version").single();
    let lookId: string | null = null;
    let look: Rec | null = null;
    let balanceCents: number | null = null;
    let charged: number | null = null;
    if (draftRow.error || !draftRow.data?.id) {
      // The draft still goes back to the builder, who can save it free (save_door_look with no id). No
      // look in the list means no charge for it.
      result.warnings.push({ code: "draft_unsaved", text: DOOR_PRESS_WARNINGS.draft_unsaved });
      await releaseHold("draft row not written");
      await log("ai_door_draft_write_failed", `Could not write the Draft door look: ${draftRow.error?.message ?? "no row"}`, context);
    } else {
      lookId = String(draftRow.data.id);
      look = draftRow.data;
      settled = true;
      if (holdId !== null) {
        const cap2 = await admin.rpc("wallet_capture", {
          p_hold_id: holdId, p_cost_cents: Math.round(result.costCents), p_usage: { model: result.model, input_tokens: result.usage.input, output_tokens: result.usage.output }, p_ref_id: rowId,
        });
        if (cap2.error) {
          // The builder has their draft; the hold ages out and auto-releases, the safe direction for them.
          await log("wallet_capture_failed", `Door hold ${holdId} not captured after a successful generation: ${cap2.error.message}`);
        } else {
          balanceCents = typeof cap2.data === "number" ? cap2.data : null;
          charged = priceCents;
        }
      }
    }
    await writeRow({ ...doorLedgerFields(result), status: "done", ...(charged !== null ? { charged_cents: charged, wallet_tx_id: holdId } : {}) });
    if (result.baseSplit) await log("ai_door_split", "The door reads disagreed on the base; the draft carries a warning.", context, "info");
    for (const gap of result.vocabGaps) {
      // The phrase is the MODEL's (filtered to plain words by doorPhrases): data about a photo, never an instruction.
      await log("ai_door_vocab_gap", `A door the vocabulary can't say yet (model-written phrase): ${gap}`, { phrase: gap, ledgerRow: rowId, modelWritten: true }, "info");
    }
    return json({
      ok: true, lookId, look, spec, warnings: result.warnings, checkId: rowId,
      pressStartedAt, lean: v.lean, balanceCents,
    });
  } catch (e) {
    if (!settled) {
      await releaseHold("the door press threw");
      await writeRow({ status: "failed", draft_ms: Date.now() - nowMs, tokens: { failure: { code: "ai_door_failed", message: DOOR_FAILURE_TEXT.unavailable }, outcome: "failed" } });
    }
    throw e;
  }
}

// ── generate_door_look_recover ────────────────────────────────────────────────────────────────
// A streamed door draft whose answer never reached the browser, picked up by the press's own key from
// the newest ledger row under it. Only the caller's own rows: the RESOLVED tenant and user, never the
// body's. No model call and no money; the kill switch does not gate it (the flag does).
export async function handleDoorLookRecover(x: DoorGenCtx): Promise<Response> {
  const { admin, req, clientId, json } = x;
  const flag = await readDoorLooksFlag(admin, clientId);
  if (flag.error) return x.filed(json({ error: "We could not check on your door look just now.", code: "ai_door_recover_failed" }, 503));
  if (!flag.ready) return json({ error: DOOR_LOOKS_UNAVAILABLE.error, code: DOOR_LOOKS_UNAVAILABLE.code }, DOOR_LOOKS_UNAVAILABLE.status);
  if (!flag.on) return json({ error: DOOR_LOOKS_OFF.error, code: DOOR_LOOKS_OFF.code }, DOOR_LOOKS_OFF.status);
  const idemKey = draftIdemKey(x.payload.idempotencyKey);
  if (!idemKey) return json({ error: "idempotencyKey (the press's own key) is required.", code: "door_look_key" }, 400);
  if (!x.userId) return json({ error: "Sign in again to pick your door look up." }, 401);
  const unreadable = async (what: string, message: string) => {
    await logEdgeError({ fn: "portal-settings", req, clientId, code: "ai_door_recover_failed", message: `Could not read ${what} to pick a door look up: ${message}` });
    return x.filed(json({ error: "We could not check on your door look just now.", code: "ai_door_recover_failed" }, 503));
  };
  const rows = await admin.from("ai_door_calls").select(DOOR_RECOVER_COLUMNS)
    .eq("client_id", clientId).eq("user_id", x.userId).eq("idem_key", idemKey)
    .order("created_at", { ascending: false }).limit(DOOR_KEY_MAX_ROWS + 3);
  if (rows.error) return await unreadable("the door ledger", rows.error.message);
  const row = pickDoorRecoverRow(rows.data as DoorRecoverRow[] | null);
  let lookId: string | null = null;
  // The money is read for every row, so no answer about money is ever a guess; the Draft look only where
  // a draft was made.
  if (row && row.status === "done") {
    const l = await admin.from("door_looks").select("id").eq("client_id", clientId).eq("ai_call_id", row.id).limit(1).maybeSingle();
    if (l.error) return await unreadable("the door looks", l.error.message);
    lookId = l.data?.id ? String(l.data.id) : null;
  }
  const tx = await admin.from("wallet_transactions").select("state, posted_at")
    .eq("client_id", clientId).eq("idempotency_key", doorWalletKey(idemKey)).eq("actor_user_id", x.userId)
    .eq("meter_kind", DOOR_METER).eq("kind", "debit");
  if (tx.error) return await unreadable("the wallet", tx.error.message);
  const money: DraftMoney = draftMoneyState(tx.data as DraftRecoverMoneyRow[] | null);
  const out = recoverDoorAnswer(row, money, Date.now(), lookId);
  if (out.kind === "draft") {
    await logEdgeError({ fn: "portal-settings", req, clientId, code: out.code, severity: out.severity, message: "A door draft whose answer never reached the browser was picked up from the ledger.", context: { ledgerRow: row?.id ?? null, lookId } });
  } else if (out.kind === "lost") {
    await logEdgeError({ fn: "portal-settings", req, clientId, code: out.code, severity: out.severity, message: `A door draft could not be picked up (${out.why}).`, context: { why: out.why, money: money.kind, ledgerRow: row?.id ?? null } });
  }
  return json(out.body);
}
