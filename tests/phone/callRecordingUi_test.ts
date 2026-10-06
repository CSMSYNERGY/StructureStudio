// My Synergy Phone — call recording in the portal (migration 263), tested against the SHIPPED
// source the way portalPhoneGaps_test.ts does (slice between stable anchors, fail loudly if they
// move):
//   * the contact timeline: crmFeed's recordingMeta and the phone_call_recordings embed (with its
//     fallback on a database before 263), and that a transcript never rides in the feed
//   * 01-core's audio and transcript fetches: the sign-in in the header, never in a URL
//   * Settings › Phone's Call recording card: its standard wording, keep lengths and wording
//     check are the server's own (portal-settings/phone.ts)
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/
//
// Every value here is an obviously fake fixture: this repo is public.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildCrmFeed, callFeedEvents, recordingMeta } from "../../supabase/functions/_shared/crmFeed.ts";
import {
  parseRecording, RECORDING_RETENTION_DAYS, STANDARD_NOTICE, STANDARD_NOTICE_TRANSCRIBED,
} from "../../supabase/functions/portal-settings/phone.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../portal/01-core.jsx");
const SALES = await read("../../portal/02-sales.jsx");
const SMS = await read("../../portal/11-sms.jsx");
const WORKER_READS = await read("../../workers/phone-api/src/routes/reads.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`callRecordingUi_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const REC = "5f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5";
const CALL = "11111111-2222-4333-8444-555555555555";
const CID = "11111111-1111-4111-8111-111111111111";
const TEAM = { level: "team" as const, userId: "00000000-0000-4000-8000-00000000000a" };
const SECRET_TRANSCRIPT = "Customer: my gate code is 4417.";

const call = (over: Record<string, unknown>) => ({
  id: CALL, direction: "in", status: "completed", from_e164: "+15555550100", to_e164: "+15555550199",
  started_at: "2026-10-04T15:00:00Z", answered_at: "2026-10-04T15:00:04Z", duration_s: 95,
  placed_by: null, answered_by: TEAM.userId, rang_user_ids: [TEAM.userId], transferred_from: null,
  phone_voicemails: null, ...over,
});
const recRow = (over: Record<string, unknown>) => ({
  id: REC, status: "completed", duration_s: 95, summary: null, transcript_status: "off", deleted_at: null, ...over,
});

// ── crmFeed: recordingMeta ───────────────────────────────────────────────────────────────────
Deno.test("recordingMeta says the Worker's words: live, paused, processing, ready, failed", () => {
  const state = (status: string, callStatus = "completed") =>
    recordingMeta(call({ status: callStatus, phone_call_recordings: recRow({ status }) }))?.recordingState;
  assertEquals(state("recording", "in_progress"), "live");
  assertEquals(state("starting", "in_progress"), "live");
  assertEquals(state("paused", "in_progress"), "paused");
  assertEquals(state("recording"), "processing", "the call ended and Twilio is finishing the file");
  assertEquals(state("completed"), "ready");
  assertEquals(state("failed"), "failed");
  assertEquals(state("absent"), "failed");
  // The same five words as the Worker's GET /calls (routes/reads.ts RecordingState), so the
  // portal and the apps say the same thing about one call.
  assert(WORKER_READS.includes('export type RecordingState = "live" | "paused" | "processing" | "ready" | "failed";'),
    "the Worker's recording states changed; update crmFeed recordingMeta and SsCallRecording");
});

Deno.test("recordingMeta: Play only when ready, Show transcript only when done, and the summary outlives the audio", () => {
  const ready = recordingMeta(call({ phone_call_recordings: recRow({ transcript_status: "done", summary: "  Wants a quote.  " }) }))!;
  assertEquals(ready, {
    recordingId: REC, recordingReady: true, recordingState: "ready", recordingDurationS: 95,
    recordingDeleted: false, summary: "Wants a quote.", hasTranscript: true, transcriptPending: false,
  });
  const pending = recordingMeta(call({ phone_call_recordings: [recRow({ transcript_status: "working" })] }))!;
  assertEquals([pending.hasTranscript, pending.transcriptPending], [false, true], "an array embed is read too");
  const live = recordingMeta(call({ status: "in_progress", phone_call_recordings: recRow({ status: "recording", duration_s: null }) }))!;
  assertEquals([live.recordingReady, live.recordingDurationS], [false, null]);
  // Retention deleted the audio and the transcript: nothing to play or read, the summary stays.
  const gone = recordingMeta(call({ phone_call_recordings: recRow({ deleted_at: "2027-10-04T09:00:00Z", transcript_status: "done", summary: "Wants a quote." }) }))!;
  assertEquals(gone, {
    recordingId: null, recordingReady: false, recordingState: null, recordingDurationS: null,
    recordingDeleted: true, summary: "Wants a quote.", hasTranscript: false, transcriptPending: false,
  });
  // No recording (or a database before 263, where the embed was never read): nothing at all.
  assertEquals(recordingMeta(call({})), null);
  assertEquals(recordingMeta(call({ phone_call_recordings: null })), null);
  assertEquals(recordingMeta(call({ phone_call_recordings: [] })), null);
});

Deno.test("callFeedEvents puts the recording on the call's line, and a call that wasn't recorded gains nothing", () => {
  const [recorded, plain] = callFeedEvents([
    call({ phone_call_recordings: recRow({ transcript_status: "done", summary: "Wants a quote." }) }),
    call({ id: "22222222-2222-4222-8222-222222222222" }),
  ], () => "Alex Example");
  assertEquals(recorded.meta?.recordingId, REC);
  assertEquals(recorded.meta?.summary, "Wants a quote.");
  assertEquals(recorded.meta?.callId, CALL);
  assert(!("recordingId" in (plain.meta ?? {})), "an unrecorded call's meta is what it was before 263");
});

// ── crmFeed: the read ────────────────────────────────────────────────────────────────────────
// A PostgREST stand-in that records every select and refuses the recordings embed when told to,
// the way a database before 263 does (PGRST200: no such relationship).
function stubAdmin(tables: Record<string, unknown[]>, selects: string[], refuseEmbed: string | null) {
  const builder = (table: string) => {
    let cols = "";
    const b: Record<string, unknown> = {};
    b.select = (c: string) => { cols = c; selects.push(`${table}: ${c}`); return b; };
    for (const m of ["eq", "in", "or", "is", "order", "limit"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      const refused = table === "phone_calls" && refuseEmbed && cols.includes("phone_call_recordings");
      const result = refused
        ? { data: null, error: { code: refuseEmbed, message: "Could not find a relationship" } }
        : { data: tables[table] ?? [], error: null };
      return Promise.resolve(result).then(res, rej);
    };
    return b;
  };
  return { from: builder, storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) } };
}

Deno.test("buildCrmFeed embeds the recording's status and summary, never its transcript", async () => {
  const selects: string[] = [];
  const rows = [call({ phone_call_recordings: recRow({ transcript_status: "done", summary: "Wants a quote.", transcript: SECRET_TRANSCRIPT }) })];
  const feed = await buildCrmFeed(stubAdmin({ phone_calls: rows }, selects, null), "demo-tenant", { codes: [], contactId: CID, phone: TEAM });
  const sel = selects.filter((s) => s.startsWith("phone_calls: "));
  assertEquals(sel.length, 1, "one read when the embed is there");
  assert(sel[0].includes("phone_call_recordings(id, status, duration_s, summary, transcript_status, deleted_at)"), sel[0]);
  assert(!/phone_call_recordings\([^)]*\btranscript\b(?!_status)/.test(sel[0]), "the transcript is fetched from the Worker on a press, never read into the feed");
  const line = feed.find((e) => e.id === `pc:${CALL}`)!;
  assertEquals([line.meta?.recordingId, line.meta?.summary, line.meta?.hasTranscript], [REC, "Wants a quote.", true]);
  // Even a row that somehow carried the text does not put it in the feed.
  assert(!JSON.stringify(feed).includes(SECRET_TRANSCRIPT));
});

Deno.test("before 263 the embed is refused, and the calls still show, read again without it", async () => {
  for (const code of ["PGRST200", "42P01", "42703"]) {
    const selects: string[] = [];
    const feed = await buildCrmFeed(stubAdmin({ phone_calls: [call({})] }, selects, code), "demo-tenant", { codes: [], contactId: CID, phone: TEAM });
    const sel = selects.filter((s) => s.startsWith("phone_calls: "));
    assertEquals(sel.length, 2, `${code}: tried with the embed, then without`);
    assert(!sel[1].includes("phone_call_recordings"));
    assert(feed.some((e) => e.id === `pc:${CALL}`), `${code}: the call is still on the timeline`);
  }
  // Any other refusal is not retried: the calls read simply comes back empty, as q() does.
  const selects: string[] = [];
  const feed = await buildCrmFeed(stubAdmin({ phone_calls: [call({})] }, selects, "57014"), "demo-tenant", { codes: [], contactId: CID, phone: TEAM });
  assertEquals(selects.filter((s) => s.startsWith("phone_calls: ")).length, 1);
  assert(!feed.some((e) => e.id === `pc:${CALL}`));
});

// ── 01-core: fetching a recording and a transcript ──────────────────────────────────────────
const PHONE_BLOCK = slice(CORE, "function ssOwnPhoneOnly(", "// ── The Settings sub-pages", "MY SYNERGY PHONE helpers");
type Win = Record<string, unknown> & { location: { href: string } };
function core(win: Win = { location: { href: "" } }) {
  return new Function("window", "navigator", "ssIsBetaHost", `${PHONE_BLOCK};
    return { ssPhoneRecordingAudioUrl, ssPhoneFetchRecording, ssPhoneFetchTranscript };`)(win, { userAgent: "Mozilla/5.0 Chrome/140" }, () => false) as {
    ssPhoneRecordingAudioUrl: (id: unknown) => string;
    ssPhoneFetchRecording: (id: unknown, token: unknown, f?: typeof fetch) => Promise<string>;
    ssPhoneFetchTranscript: (id: unknown, token: unknown, f?: typeof fetch) => Promise<{ transcript: string; summary: string | null }>;
  };
}
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.session.sig";
const fails = async (p: Promise<unknown>, re: RegExp) => {
  await p.then(() => { throw new Error("should refuse"); }, (e) => assert(re.test(e.message), e.message));
};

Deno.test("a recording is fetched with the token in the Authorization header, never in the URL, and played from a blob", async () => {
  const h = core();
  const seen: { url: string; init: RequestInit }[] = [];
  const f = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(new Response(new Blob([new Uint8Array([0x49, 0x44, 0x33])], { type: "audio/mpeg" }), { status: 200 }));
  }) as unknown as typeof fetch;
  const src = await h.ssPhoneFetchRecording(REC, TOKEN, f);
  assert(src.startsWith("blob:"), src);
  URL.revokeObjectURL(src);
  assertEquals(seen[0].url, `https://phone.structurestudiosuite.com/recordings/${REC}/audio`);
  assert(!seen[0].url.includes(TOKEN) && !/access_token/.test(seen[0].url));
  assertEquals((seen[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assertEquals([seen[0].init.credentials, seen[0].init.cache], ["omit", "no-store"]);
});

Deno.test("ssPhoneFetchRecording asks for nothing it can't be sure of, and shows the Worker's own sentence on a 404", async () => {
  const h = core();
  let calls = 0;
  const said = (status: number, message?: string) => ((_u: string, _i: RequestInit) => {
    calls++;
    return Promise.resolve(new Response(JSON.stringify(message ? { ok: false, error: { code: "not_found", message } } : {}), { status }));
  }) as unknown as typeof fetch;
  assertEquals(h.ssPhoneRecordingAudioUrl("not-an-id"), "");
  await fails(h.ssPhoneFetchRecording("not-an-id", TOKEN, said(404)), /isn't available/);
  await fails(h.ssPhoneFetchRecording(REC, "", said(404)), /Sign in again/);
  assertEquals(calls, 0, "no request without an id and a token");
  await fails(h.ssPhoneFetchRecording(REC, TOKEN, said(404, "The recording isn't ready yet. Try again in a minute.")), /isn't ready yet/);
  await fails(h.ssPhoneFetchRecording(REC, TOKEN, said(404)), /isn't available any more/);
  await fails(h.ssPhoneFetchRecording(REC, TOKEN, said(401)), /Sign in again/);
  await fails(h.ssPhoneFetchRecording(REC, TOKEN, said(502)), /couldn't be loaded/);
  await fails(h.ssPhoneFetchRecording(REC, TOKEN, (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch), /Check your connection/);
});

Deno.test("the whole transcript is read from the Worker on the press, with the header", async () => {
  const h = core();
  const seen: { url: string; init: RequestInit }[] = [];
  const ok = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, call_id: CALL, recording_id: REC, transcript: "Customer: Hi.\nTeam: Hello.", summary: null }), { status: 200 }));
  }) as unknown as typeof fetch;
  assertEquals(await h.ssPhoneFetchTranscript(CALL, TOKEN, ok), { transcript: "Customer: Hi.\nTeam: Hello.", summary: null });
  assertEquals(seen[0].url, `https://phone.structurestudiosuite.com/calls/${CALL}/transcript`);
  assertEquals((seen[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert(!seen[0].url.includes(TOKEN));
  const status = (s: number) => (() => Promise.resolve(new Response("{}", { status: s }))) as unknown as typeof fetch;
  await fails(h.ssPhoneFetchTranscript("nope", TOKEN, status(200)), /isn't available/);
  await fails(h.ssPhoneFetchTranscript(CALL, "", status(200)), /Sign in again/);
  await fails(h.ssPhoneFetchTranscript(CALL, TOKEN, status(404)), /isn't available any more/);
  await fails(h.ssPhoneFetchTranscript(CALL, TOKEN, status(200)), /couldn't be loaded/);
});

Deno.test("the timeline offers Play and Show transcript on the voicemail player's rule, and the summary to anyone who sees the call", () => {
  const block = slice(SALES, "MY SYNERGY PHONE, CALL RECORDING (migration 263): a recorded call's\n", "</div>", "timeline recording block");
  assert(block.includes("canListen={!!(ctx.canCall && ctx.phone.on && !ctx.viewing)}"), "the same rule as SsVoicemailPlayer's line");
  const comp = slice(SALES, "function SsCallRecording(", "\n}\n", "SsCallRecording");
  assert(/meta\.recordingReady && meta\.recordingId && canListen/.test(comp), "Play needs a ready recording and the rule");
  assert(/meta\.hasTranscript && canListen/.test(comp), "Show transcript needs a transcript and the rule");
  assert(/\{meta\.summary && \(/.test(comp), "the summary needs neither");
  assert(comp.includes("ssPhoneFetchTranscript(callId, token)"), "the transcript is fetched on the press");
});

// ── Settings › Phone: the Call recording card ───────────────────────────────────────────────
const REC_BLOCK = slice(SMS, "const PHONE_REC_STANDARD = ", "function PhoneSettingsView(", "the Call recording helpers");
const card = new Function(`${REC_BLOCK}; return { PHONE_REC_STANDARD, PHONE_REC_STANDARD_TRANSCRIBED, PHONE_REC_KEEP_WORDS, phoneRecFormFrom, phoneRecNoticeProblem };`)() as {
  PHONE_REC_STANDARD: string;
  PHONE_REC_STANDARD_TRANSCRIBED: string;
  PHONE_REC_KEEP_WORDS: Record<string, string>;
  phoneRecFormFrom: (r: unknown) => { on: boolean; noticeText: string; transcribe: boolean; retentionDays: number };
  phoneRecNoticeProblem: (t: unknown) => string | null;
};

Deno.test("the card shows the server's standard wording and every keep length the server takes", () => {
  assertEquals(card.PHONE_REC_STANDARD, STANDARD_NOTICE);
  assertEquals(card.PHONE_REC_STANDARD_TRANSCRIBED, STANDARD_NOTICE_TRANSCRIBED);
  assertEquals(Object.keys(card.PHONE_REC_KEEP_WORDS).map(Number), [...RECORDING_RETENTION_DAYS]);
});

Deno.test("the card's wording check agrees with parseRecording, sentence for sentence", () => {
  const cases = [
    "", "   ", STANDARD_NOTICE, STANDARD_NOTICE_TRANSCRIBED, "Recorded.", "This call may be recorded for training.",
    "Hello and welcome to our shop.", "x".repeat(293) + " record", "x".repeat(294) + " record", "  This   call is\nrecorded.  ",
    "This call is recorded.\u0007", "Calls on this line are not recorded.", "This call isn't being recorded.",
    "Thanks for calling Demo Sheds, the record-setting builder!", "We record calls. Do not share card numbers.",
    "Recordings of calls help us train our team.", "x".repeat(294) + "record",
  ];
  for (const text of cases) {
    const server = parseRecording({ on: true, noticeText: text });
    const mine = card.phoneRecNoticeProblem(text);
    assertEquals(mine, server.ok ? null : (server as { error: string }).error, JSON.stringify(text));
  }
});

Deno.test("the card's two wording patterns are _shared/recordingNotice.ts's, word for word", async () => {
  const shared = await read("../../supabase/functions/_shared/recordingNotice.ts");
  for (const name of ["SAYS", "DENIES"]) {
    const m = new RegExp(`const ${name} = (/.+/i);`).exec(shared);
    assert(m, `recordingNotice.ts has no ${name}`);
    assert(SMS.includes(`const PHONE_REC_${name} = ${m![1]};`), `the card's PHONE_REC_${name} differs from the server's`);
  }
});

Deno.test("the form starts from the server's view: off, standard wording, transcripts on, a year", () => {
  assertEquals(card.phoneRecFormFrom({ on: false, noticeText: null, transcribe: true, retentionDays: 365 }), { on: false, noticeText: "", transcribe: true, retentionDays: 365 });
  assertEquals(card.phoneRecFormFrom({ on: true, noticeText: "We record calls.", transcribe: false, retentionDays: 90 }), { on: true, noticeText: "We record calls.", transcribe: false, retentionDays: 90 });
  assertEquals(card.phoneRecFormFrom(null), { on: false, noticeText: "", transcribe: true, retentionDays: 365 });
});

Deno.test("the card saves through phone_recording_save on its own, owner-only, with the announcement locked on", () => {
  const view = slice(SMS, "const rec = data.recording || null;", "// Someone with their OWN calls only", "the Call recording card");
  assert(view.includes('phoneAction("phone_recording_save"'), "its own action");
  assert(!/phoneAction\("phone_settings_save"/.test(view), "never the routing form's save");
  assert(view.includes("const recEdit = !!data.canChangeRecording && canEdit && !!recForm;"), "the server's owner rule decides who may change it");
  assert(/check\(true, true, \(\) => \{\}, "Announce it to callers"/.test(view), "the announcement is shown on and can't be unticked");
  assert(!/notice:\s*false/.test(view), "the card never asks to turn the announcement off");
});

Deno.test("the card says calls are recorded only while the owner's switch AND the server's are on", () => {
  const view = slice(SMS, "const rec = data.recording || null;", "// Someone with their OWN calls only", "the Call recording card");
  assert(view.includes("const recLive = !!(rec && rec.on && rec.serverOn);"), "live is both switches");
  assert(view.includes('{recLive ? "Calls are recorded" : rec.on ? "On, not started yet" : "Off"}'), "the pill follows live, not the owner's switch alone");
  assert(/rec\.serverOn\s*\n?\s*\? `Record calls\? From your next call on/.test(view), "'from your next call on' only once the server records");
  assert(view.includes("Calls will be announced and recorded once call recording starts on this account."), "the save says when it starts");
  const own = slice(SMS, "// Someone with their OWN calls only", "{installCard}", "the own-level view");
  assert(own.includes("data.recording && data.recording.on && data.recording.serverOn &&"), "the own-level line only when calls really are recorded");
});
