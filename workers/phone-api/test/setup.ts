import { afterEach, beforeEach, vi } from "vitest";
import { resetJwksCache } from "../src/jwt";
import { resetLogThrottle } from "../src/log";
import { _resetTwilioAccountCaches } from "../../../supabase/functions/_shared/twilioAccount.ts";
import { _resetWorkerTwilioCache } from "../src/twilioAccount";
import { _resetPlanCaches } from "../src/plan";

beforeEach(() => {
  resetJwksCache();
  resetLogThrottle();
  // The shared Twilio account resolver keeps a per-isolate cache (Workstream 2); start every test cold.
  _resetTwilioAccountCaches();
  _resetWorkerTwilioCache();
  // Plans as data (src/plan.ts): who is named, each company's answer and what was reported are
  // kept per isolate too.
  _resetPlanCaches();
  // The Worker logs refusals and faults with console.warn; keep test output readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});
