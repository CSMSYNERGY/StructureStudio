// callEvents.ts warmStateOf (how the latest warm transfer stands) and http.ts refusal bodies
// that carry facts beside `error` (hold and warm transfer's `held`).
import { describe, expect, it } from "vitest";
import { warmStateOf, type EventRow } from "../src/callEvents";
import { ApiError, errorResponse } from "../src/http";
import { USER_A, USER_B, USER_C } from "./helpers";

const CALL = "00000000-0000-4000-8000-0000000ca555";
const LEG = "CA" + "0".repeat(31) + "6";
const at = (s: number) => new Date(Date.UTC(2026, 8, 29, 15, 0, s)).toISOString();
const e = (type: string, data: Record<string, unknown> | null, s: number): EventRow => ({ call_id: CALL, type, at: at(s), data });

describe("warmStateOf", () => {
  it("null when the Worker never rang anyone into the call (an app's own mark is not a warm transfer)", () => {
    expect(warmStateOf([], USER_A)).toBeNull();
    expect(warmStateOf([e("warm_transfer", { to_user_id: USER_B, source: "app" }, 1)], USER_A)).toBeNull();
  });

  it("answered wins: the teammate it rang holds the call now", () => {
    const list = [e("warm_transfer", { to: USER_B, sid: LEG }, 1), e("warm_transfer_missed", { sid: LEG }, 2)];
    expect(warmStateOf(list, USER_B)?.state).toBe("answered");
  });

  it("without a CallSid on both, order decides: a missed event after it, not before", () => {
    expect(warmStateOf([e("warm_transfer", { to: USER_B }, 1), e("warm_transfer_missed", { user: USER_B }, 2)], USER_A)?.state).toBe("missed");
    expect(warmStateOf([e("warm_transfer_missed", { user: USER_B }, 1), e("warm_transfer", { to: USER_B }, 2)], USER_A)?.state).toBe("ringing");
  });

  it("with a CallSid on both, the leg decides whatever the order (a fast decline can be written first)", () => {
    expect(warmStateOf([e("warm_transfer_missed", { sid: LEG }, 1), e("warm_transfer", { to: USER_B, sid: LEG }, 2)], USER_A)?.state).toBe("missed");
    const other = "CA" + "0".repeat(31) + "7";
    expect(warmStateOf([e("warm_transfer", { to: USER_B, sid: LEG }, 1), e("warm_transfer_missed", { sid: other }, 2)], USER_A)?.state).toBe("ringing");
  });

  it("reads events in any order, and reports when the latest one was pressed", () => {
    const list = [e("warm_transfer", { to: USER_B, sid: LEG }, 9), e("warm_transfer", { to: USER_A, sid: "x" }, 3)];
    expect(warmStateOf(list, null)).toEqual({ to_user_id: USER_B, state: "ringing", at: at(9) });
  });

  describe("only the call's current conference counts (a cold transfer ended the one before)", () => {
    const took = e("warm_transfer", { from: USER_A, to: USER_B, sid: LEG }, 1);
    const coldToC = e("transfer", { from: USER_B, to: USER_C, dnd: false }, 20);

    it("B took a warm transfer, then cold-transferred to C, who holds the call now: nothing is ringing", () => {
      // Before: to B, answered_by C, so it read "ringing" in C's new conference.
      expect(warmStateOf([took, coldToC], USER_C)).toBeNull();
    });

    it("a miss before the cold transfer is not this conference's either", () => {
      expect(warmStateOf([took, e("warm_transfer_missed", { sid: LEG }, 2), coldToC], USER_C)).toBeNull();
    });

    it("a warm transfer after it is read on its own, even to the same teammate", () => {
      const again = "CA" + "0".repeat(31) + "8";
      const list = [took, e("warm_transfer_missed", { user: USER_B }, 2), coldToC, e("warm_transfer", { from: USER_C, to: USER_B, sid: again }, 30)];
      expect(warmStateOf(list, USER_C)).toEqual({ to_user_id: USER_B, state: "ringing", at: at(30) });
    });

    it("an app's own mark called 'transfer' is not a cold transfer", () => {
      const list = [took, e("warm_transfer_missed", { sid: LEG }, 2), e("transfer", { source: "app", user: USER_A }, 20)];
      expect(warmStateOf(list, USER_A)?.state).toBe("missed");
    });
  });
});

describe("refusal bodies", () => {
  it("carry extra facts beside error, which can never replace ok or error", async () => {
    const res = errorResponse(new ApiError("bad_request", "Not now.", undefined, { held: false, call_id: CALL, ok: true, error: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, held: false, call_id: CALL, error: { code: "bad_request", message: "Not now." } });
  });

  it("are unchanged without them", async () => {
    expect(await errorResponse(new ApiError("not_found")).json()).toEqual({ ok: false, error: { code: "not_found", message: "That wasn't found." } });
  });
});
