// _shared/twilioEventKey.ts — the idempotency key twilio-events stores in
// sms_registration_events.event_id.
//
// ⚠️ THE CLOUDEVENTS ID IS NOT PER OCCURRENCE. Twilio derives an A2P event's id from the
// campaign SID and the event TYPE alone (checked on every recorded campaign event across three
// campaigns: submitted, failure, deleted and approved each map to one fixed id per campaign).
// That was harmless while a rejected campaign was deleted and rebuilt, and stopped being
// harmless on 2026-09-03, when rejections started being fixed by editing the same campaign in
// place. From then on, every verdict after the first for a campaign carried the SAME id as the
// first, hit the unique index with 23505, and was thrown away as "already seen". Four
// campaign-failure verdicts in September never reached the row; builders only learned of them
// through portal-sms's poller and its reasons read.
//
// So the key is the id PLUS the occurrence stamp in the payload. A true redelivery repeats
// the payload, stamp included, and still collides; a new verdict on the same campaign does
// not. `timestamp` (epoch ms) is on every submitted/failure/approved event recorded so far.
// `updateddate` covers campaign-deleted, which carries no `timestamp`; it is NOT used first
// because an in-place edit leaves it unchanged (the 09-22 approval still carried the 09-02
// value). With neither, the key is the bare id, which is exactly the behaviour before this
// module. Twilio's own test event is one of those, and it keeps colliding as it always did.
//
// Nothing reads event_id back — portal-sms's own notes insert it null — so the format change
// needs no migration. A pre-change event redelivered under the new key is processed again; the
// settled-verdict guard only stops PENDING, so campaignVerdictPredatesResubmit (below) is what
// keeps a replayed APPROVED/FAILED from rewriting a newer state.
//
// ⚠️ Importers (redeploy together when this changes; _shared bundles PER function):
//      twilio-events/index.ts

/** The occurrence stamp of one event payload, or "" when it carries none. */
export function eventOccurrenceStamp(data: Record<string, unknown> | null | undefined): string {
  const d = data ?? {};
  for (const v of [d.timestamp, d.updateddate, d.updatedDate]) {
    if ((typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim())) {
      return String(v).trim();
    }
  }
  return "";
}

/** `${id}@${stamp}`; the bare id when there is no stamp; null when there is no id at all
 *  (a null event_id is outside the partial unique index, so it is never deduplicated). */
export function eventOccurrenceKey(
  eventId: unknown,
  data: Record<string, unknown> | null | undefined,
): string | null {
  const id = String(eventId ?? "").trim();
  if (!id) return null;
  const stamp = eventOccurrenceStamp(data);
  return stamp ? `${id}@${stamp}` : id;
}

// ⚠️ A NEW KEY ALSO LETS AN OLD VERDICT BACK IN. Rows stored before this module carry the bare
// id, so a late re-send of one of them (Twilio does re-send: a campaign-failure arrived again
// 3.7 h after the first on 2026-09-02, with no resubmit in between) no longer collides. Neither
// does any replay once the campaign has been edited. A replayed FAILED over an approved campaign
// would demote it and bring back errors the builder already fixed, so a campaign verdict older
// than the campaign's last copy write is ignored. `campaign_copy_updated_at` is written right
// before every createCampaign/updateCampaign, and copy cannot change while a campaign is under
// review, so every verdict about the current submission is stamped after it. Only the numeric
// `timestamp` counts: `updateddate` survives in-place edits, so it cannot date a verdict.
// The two stamps come from two clocks (ours and Twilio's) and Twilio's first event can land
// within a second of our copy write, so a verdict only counts as stale when it is more than
// STALE_MARGIN_MS older. The replays this exists for are hours old.
export const STALE_MARGIN_MS = 60_000;
/** True when the payload's `timestamp` (epoch ms) predates the last campaign copy write by
 *  more than STALE_MARGIN_MS. */
export function campaignVerdictPredatesResubmit(
  data: Record<string, unknown> | null | undefined,
  campaignCopyUpdatedAt: unknown,
): boolean {
  const ts = (data ?? {}).timestamp;
  const stamp = typeof ts === "number" ? ts : typeof ts === "string" && ts.trim() ? Number(ts) : NaN;
  if (!Number.isFinite(stamp)) return false;
  const copied = typeof campaignCopyUpdatedAt === "string" ? Date.parse(campaignCopyUpdatedAt) : NaN;
  if (!Number.isFinite(copied)) return false;
  return stamp < copied - STALE_MARGIN_MS;
}
