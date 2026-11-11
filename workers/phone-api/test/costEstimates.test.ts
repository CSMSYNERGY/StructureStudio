// The "about … a minute" figure builders see next to the recording and transcript switches
// (portal-billing meters[].aboutMicrosPerMinute) is OUR per-minute estimate × the markup. The
// estimate lives in supabase/functions/_shared/walletLedger.ts COST_PER_MINUTE_MICROS, a copy of
// the figures this Worker charges with. If either side changes alone, the card shows a price that
// isn't what the Worker takes: this fails first (2026-11-11, recording and transcripts charged).
import { describe, expect, it } from "vitest";
import { COST_PER_MINUTE_MICROS } from "../../../supabase/functions/_shared/walletLedger.ts";
import { RECORDING_MIN_MICROS } from "../src/cron/usageCharge";
import { NOVA3_CHANNELS_BILLED, NOVA3_MIN_MICROS } from "../src/cron/transcribe";

describe("the portal's 'about' figures are this Worker's own estimates", () => {
  it("call recording: Twilio's price a minute", () => {
    expect(COST_PER_MINUTE_MICROS.call_recording).toBe(RECORDING_MIN_MICROS);
  });
  it("call transcript: nova-3's price a minute, both channels billed (the summary comes on top)", () => {
    expect(COST_PER_MINUTE_MICROS.call_transcription).toBe(NOVA3_MIN_MICROS * NOVA3_CHANNELS_BILLED);
  });
});
