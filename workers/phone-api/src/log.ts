// Worker faults → app_errors, through the SAME logEdgeError every edge function uses, so the
// rows land with source `edge:phone-api` and the after-deploy triage query already covers them.
//
// Severity follows the table's split: `error` is a fault someone must look at; `info` is the
// product correctly refusing (a bad webhook signature, a blocked 911 attempt). Refusals that a
// stranger can trigger at will are rate-limited per isolate so they cannot flood the table.

import { logEdgeError } from "../../../supabase/functions/_shared/logError.ts";

export const FN = "phone-api";

type Severity = "error" | "warn" | "info";

const lastLogged = new Map<string, number>();
const loggedOnce = new Set<string>();

export function logFault(input: {
  code: string;
  message: string;
  req?: Request | null;
  clientId?: string | null;
  context?: Record<string, unknown> | null;
  severity?: Severity;
  /** Minimum ms between two rows with this code from one isolate (0 = always write). */
  throttleMs?: number;
  /** Write this code at most once for the life of the isolate. */
  once?: boolean;
}): Promise<void> {
  if (input.once) {
    if (loggedOnce.has(input.code)) return Promise.resolve();
    loggedOnce.add(input.code);
  }
  const throttle = input.throttleMs ?? 0;
  if (throttle > 0) {
    const now = Date.now();
    const prev = lastLogged.get(input.code) ?? 0;
    if (now - prev < throttle) return Promise.resolve();
    lastLogged.set(input.code, now);
  }
  console.warn(`[phone-api] ${input.severity ?? "error"} ${input.code}: ${input.message}`);
  return logEdgeError({
    fn: FN,
    code: input.code,
    message: input.message,
    req: input.req ?? null,
    clientId: input.clientId ?? null,
    context: input.context ?? null,
    severity: input.severity ?? "error",
  }).catch(() => {});
}

/** Tests only. */
export function resetLogThrottle(): void {
  lastLogged.clear();
  loggedOnce.clear();
}
