// GET /media/:messageId/:index: one photo (or other file) that came IN with a text, streamed
// from Twilio with the Worker's API key after the same scope check GET /threads/:key makes.
// Like /voicemails/:id/audio, Twilio requires a login for media and the apps never hold
// Twilio credentials. Unlike it, the login is the Authorization header ONLY (SPEC section 3,
// "Bearer only"): every client fetches photos with the header, and a login token in a URL ends
// up in logs and history.
//
// `:messageId` is the sms_messages id; `:index` counts from 0 up to num_media - 1.
//
// WHERE THE MEDIA SID COMES FROM
//   1. sms_messages.media (jsonb), when that column exists: an array in MediaUrl{N} order of
//      {sid:"ME...", content_type}. Proposed for sms-inbound (DEVIATIONS 36); not in 254.
//   2. Otherwise (the column is absent, empty, or short) Twilio's own list of the message's
//      media, fetched with provider_sid. That list's order is Twilio's, which may not be the
//      order the customer attached them in; for one photo, the usual case, it cannot differ.
// The Twilio URL is built here from SIDs alone. A stored URL is never fetched as-is, so a
// stored value can never point our credentials at another host.
//
// SENDING photos is not here: the shared sendTenantSms has no media parameter (DEVIATIONS 36).

import type { Env } from "../env";
import { requireCaller } from "../context";
import { DbError, must, type Admin } from "../db";
import { ApiError, UUID_RE } from "../http";
import { mayReadUnknownNumbers, visibleContactIds } from "../scope";
import { listMessageMedia, messageMediaContent } from "../twilioRest";

const MESSAGE_SID_RE = /^(MM|SM)[0-9a-f]{32}$/;
const MEDIA_SID_RE = /^ME[0-9a-f]{32}$/;
/** Twilio allows at most 10 media on one message. */
const MAX_MEDIA = 10;
/** PostgREST / Postgres "no such column". */
const MISSING_COLUMN = new Set(["42703", "PGRST204"]);

/** What may be shown inline. Anything else is sent as a download, never rendered here. */
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp|heic|heif|bmp)|video\/(mp4|3gpp|quicktime)|audio\/(mpeg|mp4|amr|ogg|wav|3gpp))$/i;

interface MediaMessage {
  id: string;
  contact_id: string | null;
  direction: string;
  provider_sid: string | null;
  num_media: number | null;
  media?: unknown;
}

/** The media SID at `index` from a stored sms_messages.media value, or null. */
export function storedMediaSid(media: unknown, index: number): { sid: string; contentType: string | null } | null {
  if (!Array.isArray(media)) return null;
  const item = media[index] as unknown;
  let sid: string | null = null;
  let contentType: string | null = null;
  if (typeof item === "string") {
    sid = /\/Media\/(ME[0-9a-f]{32})(?:[/?.]|$)/.exec(item)?.[1] ?? null;
  } else if (item && typeof item === "object") {
    const o = item as { sid?: unknown; url?: unknown; content_type?: unknown };
    if (typeof o.sid === "string") sid = o.sid;
    else if (typeof o.url === "string") sid = /\/Media\/(ME[0-9a-f]{32})(?:[/?.]|$)/.exec(o.url)?.[1] ?? null;
    if (typeof o.content_type === "string") contentType = o.content_type;
  }
  return sid && MEDIA_SID_RE.test(sid) ? { sid, contentType } : null;
}

async function readMessage(admin: Admin, clientId: string, id: string): Promise<MediaMessage | null> {
  const cols = "id, contact_id, direction, provider_sid, num_media";
  const withMedia = await admin.from("sms_messages").select(`${cols}, media`).eq("client_id", clientId).eq("id", id).maybeSingle();
  if (!withMedia.error) return withMedia.data as MediaMessage | null;
  // The media column is a proposal (DEVIATIONS 36): until it exists, read without it.
  if (!MISSING_COLUMN.has(String(withMedia.error.code ?? ""))) {
    throw new DbError("read text for media", withMedia.error.message ?? "unknown", withMedia.error.code ?? null);
  }
  return must(
    await admin.from("sms_messages").select(cols).eq("client_id", clientId).eq("id", id).maybeSingle(),
    "read text for media",
  ) as MediaMessage | null;
}

export async function mediaFile(env: Env, req: Request, messageId: string, indexRaw: string): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  const notFound = () => new ApiError("not_found", "That photo wasn't found.");
  if (!UUID_RE.test(messageId) || !/^\d{1,2}$/.test(indexRaw)) throw notFound();
  const index = Number(indexRaw);
  if (index >= MAX_MEDIA) throw notFound();
  if (c.ctx.contacts_level === "none") throw notFound();

  const msg = await readMessage(c.admin, c.ctx.client_id, messageId);
  // Only texts that came IN carry media we can fetch (the apps cannot send photos yet).
  if (!msg || msg.direction !== "in") throw notFound();

  // The thread scope, exactly as GET /threads/:key applies it.
  if (msg.contact_id) {
    const seen = await visibleContactIds(c, [msg.contact_id]);
    if (!seen.has(msg.contact_id)) throw notFound();
  } else if (!mayReadUnknownNumbers(c.ctx)) {
    throw notFound();
  }

  const stored = storedMediaSid(msg.media, index);
  const count = Number(msg.num_media ?? 0) || 0;
  if (!stored && index >= count) throw notFound();
  const messageSid = String(msg.provider_sid ?? "");
  if (!MESSAGE_SID_RE.test(messageSid)) throw notFound();

  let media = stored;
  if (!media) {
    let list;
    try {
      list = await listMessageMedia(env, messageSid);
    } catch {
      throw new ApiError("twilio_error", "The photo couldn't be loaded. Please try again.");
    }
    const item = list[index];
    media = item && MEDIA_SID_RE.test(item.sid) ? { sid: item.sid, contentType: item.content_type ?? null } : null;
  }
  if (!media) throw new ApiError("not_found", "That photo is no longer available.");

  let res: Response;
  try {
    res = await messageMediaContent(env, messageSid, media.sid);
  } catch {
    throw new ApiError("twilio_error", "The photo couldn't be loaded. Please try again.");
  }
  if (res.status === 404) throw new ApiError("not_found", "That photo is no longer available.");
  if (!res.ok) throw new ApiError("twilio_error", "The photo couldn't be loaded. Please try again.");

  const declared = (media.contentType || res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const inline = INLINE_TYPES.test(declared);
  const headers = new Headers({
    "content-type": inline ? declared : "application/octet-stream",
    "content-disposition": inline ? "inline" : `attachment; filename="text-${messageId.slice(0, 8)}-${index}"`,
    "cache-control": "private, no-store",
    // Served from the Worker's own origin: never sniffed, never scripted.
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  const len = res.headers.get("content-length");
  if (len) headers.set("content-length", len);
  return new Response(res.body, { status: 200, headers });
}
