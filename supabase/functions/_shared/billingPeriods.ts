// Calendar arithmetic for subscription periods. Shared by portal-billing (entitlement /
// cancelled-but-paid math) and admin-catalog (operator billing overview's renewal dates).
// Extracted verbatim from portal-billing on 2026-08-24 — behaviour must not drift, because
// portal-billing uses it to decide whether a cancelled tenant still has access.
//
// Calendar arithmetic with END-OF-MONTH CLAMPING. A bare setUTCMonth(+1) overflows — Aug 31
// becomes Oct 1 and Jan 31 becomes Mar 3 — which would hand out a bonus period whose size
// depends on the anchor day. Clamping gives the conventional, predictable answer instead
// (Aug 31 → Sep 30, Jan 31 → Feb 28/29, Feb 29 → Feb 28 on a non-leap year).
export const addInterval = (ms: number, interval: string): number => {
  const d = new Date(ms);
  const yearly = /^(year|annual)/.test(String(interval).toLowerCase());
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(
    d.getUTCFullYear() + (yearly ? 1 : 0),
    d.getUTCMonth() + (yearly ? 0 : 1),
    1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  ));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
};

// How far a subscription has actually PAID through. The stored current_period_end cannot be
// trusted on its own: only checkout ever writes it (the FIRST renewal date), and
// billing-webhook's periodEnd is dead data — NMI sends next_charge_date '1970-01-01' on every
// observed live event, which gets filtered to null. So after the gateway's first renewal the
// column still holds period 1's end. Roll the stored boundary forward by whole billing
// intervals instead; the roll STOPS at cancellation, because that is when the gateway stopped
// charging — so this credits every period that was paid and not one more. Returns NaN for a
// legacy bill-in-arrears row with no stored boundary (nothing prepaid).
export const paidThroughOf = (
  s: { current_period_end?: string | null; canceled_at?: string | null } | null | undefined,
  interval: string,
): number => {
  const stored = s?.current_period_end ? Date.parse(s.current_period_end) : NaN;
  if (!Number.isFinite(stored)) return NaN;          // legacy bill-in-arrears row: nothing prepaid
  // The gateway charged periods until cancellation (or until now, if somehow not cancelled).
  const chargedUntil = s?.canceled_at ? Date.parse(s.canceled_at) : Date.now();
  if (!Number.isFinite(chargedUntil)) return stored;
  let end = stored;
  // Bounded: 1 extra iteration per elapsed interval, capped so a bad date cannot spin.
  for (let i = 0; i < 240 && end <= chargedUntil; i++) end = addInterval(end, interval);
  return end;
};
