// My Synergy Phone — call recording's settings in portal-settings (migration 263): parseRecording
// and recordingView (phone.ts), and that phone_recording_save is the owner's alone and gated.
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/
//
// Every value here is an obviously fake fixture: this repo is public.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  DEFAULT_RECORDING_RETENTION_DAYS, NOTICE_MAX, NOTICE_MIN, parseRecording, RECORDING_RETENTION_DAYS, recordingServerOn, recordingView,
  STANDARD_NOTICE, STANDARD_NOTICE_TRANSCRIBED,
} from "../../supabase/functions/portal-settings/phone.ts";

const refused = (p: Record<string, unknown>): string => {
  const r = parseRecording(p);
  assert(!r.ok, `accepted ${JSON.stringify(p)}`);
  return (r as { error: string }).error;
};

Deno.test("recording: the defaults are announcement on, transcripts on, 365 days, the standard wording", () => {
  const r = parseRecording({ on: true });
  assert(r.ok);
  assertEquals(r.ok && r.row, {
    phone_record_calls: true, phone_recording_notice: true, phone_recording_notice_text: null,
    phone_transcribe_calls: true, phone_recording_retention_days: 365,
  });
  assertEquals(DEFAULT_RECORDING_RETENTION_DAYS, 365);
  const off = parseRecording({ on: false, transcribe: false, retentionDays: 30 });
  assert(off.ok);
  assertEquals(off.ok && off.row.phone_record_calls, false);
  assertEquals(off.ok && off.row.phone_transcribe_calls, false);
});

Deno.test("recording: on/off must be said; the announcement cannot be turned off", () => {
  assert(/Say whether calls should be recorded/.test(refused({})));
  assert(/Say whether calls should be recorded/.test(refused({ on: "yes" })));
  assert(/announcement can't be turned off/.test(refused({ on: true, notice: false })));
  assert(parseRecording({ on: true, notice: true }).ok);
});

Deno.test("recording: retention is one of the five lengths, and nothing else", () => {
  assertEquals([...RECORDING_RETENTION_DAYS], [30, 90, 180, 365, 730]);
  for (const d of RECORDING_RETENTION_DAYS) {
    const r = parseRecording({ on: true, retentionDays: d });
    assert(r.ok && r.row.phone_recording_retention_days === d);
  }
  assert(parseRecording({ on: true, retentionDays: "90" }).ok); // a select's value arrives as text
  for (const bad of [0, 7, 60, 366, 1000, "forever", -30]) assert(/how long recordings are kept/.test(refused({ on: true, retentionDays: bad })));
});

Deno.test("recording: the wording is tidied, 10-300 characters, one line, and must say the call is recorded", () => {
  const ok = parseRecording({ on: true, noticeText: "  This call   may be recorded\nfor training.  " });
  assert(ok.ok);
  assertEquals(ok.ok && ok.row.phone_recording_notice_text, "This call may be recorded for training.");
  // Blank or either standard sentence is the standard wording (NULL), so it follows the transcripts switch.
  for (const std of ["", "   ", STANDARD_NOTICE, STANDARD_NOTICE_TRANSCRIBED, null]) {
    const r = parseRecording({ on: true, noticeText: std });
    assert(r.ok && r.row.phone_recording_notice_text === null, String(std));
  }
  assert(/at least 10/.test(refused({ on: true, noticeText: "Recorded." })));
  assert(parseRecording({ on: true, noticeText: "Recorded!!" }).ok); // exactly NOTICE_MIN
  assertEquals(NOTICE_MIN, 10);
  assert(/at most 300/.test(refused({ on: true, noticeText: `Recorded ${"x".repeat(NOTICE_MAX)}` })));
  assert(parseRecording({ on: true, noticeText: `Recorded ${"x".repeat(NOTICE_MAX - 9)}` }).ok);
  assert(/has to tell callers the call is recorded/.test(refused({ on: true, noticeText: "Thanks for calling Demo Sheds." })));
  // It has to SAY it: not deny it, and not merely contain the letters.
  for (const bad of [
    "Calls on this line are not recorded.", "This call isn't being recorded.", "We will never record this call.",
    "No recording happens on this line.", "Thanks for calling Demo Sheds, the record-setting builder!",
  ]) assert(/has to tell callers the call is recorded/.test(refused({ on: true, noticeText: bad })), bad);
  for (const good of [
    "We record calls to serve you better.", "Calls are recorded. Do not share card numbers.", "This call may be recorded for training.",
    "Recordings of calls help us train our team.",
  ]) assert(parseRecording({ on: true, noticeText: good }).ok, good);
  assert(/shape we recognise/.test(refused({ on: true, noticeText: 42 })));
  assert(/Say whether recorded calls should be transcribed/.test(refused({ on: true, transcribe: "no" })));
});

Deno.test("recording view: what the card shows, with the defaults for a business that never saved it", () => {
  assertEquals(recordingView(null), {
    on: false, serverOn: false, notice: true, noticeText: null, standardText: STANDARD_NOTICE_TRANSCRIBED, transcribe: true,
    retentionDays: 365, retentionChoices: [30, 90, 180, 365, 730], updatedAt: null, updatedBy: null,
  });
  const v = recordingView({
    phone_record_calls: true, phone_recording_notice_text: "Calls are recorded for training.", phone_transcribe_calls: false,
    phone_recording_retention_days: 90, phone_recording_updated_at: "2026-10-04T12:00:00Z", phone_recording_updated_by: "00000000-0000-4000-8000-000000000001",
  });
  assertEquals(v.on, true);
  assertEquals(v.standardText, STANDARD_NOTICE);
  assertEquals(v.retentionDays, 90);
  assertEquals(v.noticeText, "Calls are recorded for training.");
  assertEquals(v.serverOn, false, "the server's switch is off unless said");
  assertEquals(recordingView({ phone_record_calls: true }, true).serverOn, true);
});

Deno.test("the server's switch is the Worker's CALL_RECORDING rail, exactly 'on'", () => {
  const env = (v: string | undefined) => (k: string) => (k === "CALL_RECORDING" ? v : undefined);
  assertEquals(recordingServerOn(env("on")), true);
  for (const v of [undefined, "", "off", "ON", "on ", "true", "1"]) assertEquals(recordingServerOn(env(v)), false, String(v));
});

// ── portal-settings itself: the source, as phoneBillingGate_test reads admin-catalog ─────────
const code = (s: string) => s.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
const SRC = code(await Deno.readTextFile(new URL("../../supabase/functions/portal-settings/index.ts", import.meta.url)));

Deno.test("phone_recording_save is on the gate table at phone edit", () => {
  assert(/phone_recording_save:\s*\{\s*area:\s*"phone",\s*level:\s*"edit"\s*\}/.test(SRC));
});

Deno.test("phone_recording_save refuses anyone but the owner BEFORE it parses or writes, and stamps who and when", () => {
  const branch = SRC.slice(SRC.indexOf('if (action === "phone_recording_save")'));
  assert(branch.length > 0 && SRC.includes('if (action === "phone_recording_save")'), "the branch is gone");
  const end = branch.indexOf("\n  }\n");
  const body = branch.slice(0, end);
  const owner = body.indexOf('if (role !== "owner")');
  const parse = body.indexOf("parseRecording(");
  const write = body.indexOf('.from("client_settings")');
  assert(owner > 0 && parse > owner && write > parse, "the owner check must come first, then the parse, then the write");
  assert(body.includes("phone_recording_updated_by: userId"));
  assert(body.includes("phone_recording_updated_at:"));
  assert(body.includes('.eq("client_id", clientId)'), "the write is scoped to the caller's tenant");
});

Deno.test("phone_settings_get hands an own-level caller only whether calls are recorded", () => {
  const get = SRC.slice(SRC.indexOf('if (action === "phone_settings_get")'));
  const own = get.slice(get.indexOf("if (ownPhoneOnly(access))"), get.indexOf("const [teamOut, routeRes"));
  assert(own.includes("recording: recording ? { on: recording.on, serverOn: recording.serverOn } : null"));
  // The card can only tell the truth if both reads and the save carry the server's switch.
  assert(get.includes("recordingView(recRes.data as Record<string, unknown> | null, recordingServerOn((k) => Deno.env.get(k)))"));
  const save = SRC.slice(SRC.indexOf('if (action === "phone_recording_save")'));
  assert(save.slice(0, save.indexOf("\n  }\n")).includes("recordingView(data[0] as Record<string, unknown>, recordingServerOn((k) => Deno.env.get(k)))"));
  assert(get.includes('canChangeRecording: !!recording && canEdit("phone") && role === "owner"'));
});
