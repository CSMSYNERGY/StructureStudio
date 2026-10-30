// An in-memory copy of migration 349's two refund steps (payment_refund_open, payment_refund_close)
// and its ledger, for the tests that drive portal-payments through supabase_stub.ts (stubRpc).
//
// It follows the SQL rule for rule, in the same order: the payment is found by tenant and id, a
// repeated key is a replay (key_reused when it names another payment or amount), one refund in flight
// per payment, voided refuses, card network vs by hand, the amount up to what is left, a by-hand
// refund is done in one call, done moves the money once (amount down, refunded up, voided with the
// total at zero, a note line) and `short` when less was left, failed and unknown only mark the
// refund. tests/sql/migration349.test.cjs holds the SQL itself to those rules; this file is only
// what lets a handler test see them.
//
// Tenants, ids and order ids are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any

export type LedgerRefund = {
  id: number;
  client_id: string;
  payment_id: string;
  order_id: string;
  amount_cents: number;
  kind: "gateway" | "manual";
  state: "pending" | "unknown" | "done" | "failed";
  request_key: string;
  method: string | null;
  reference: string | null;
  reason: string | null;
  gateway_orderid: string | null;
  gateway_retref: string | null;
  gateway_respcode: string | null;
  gateway_resptext: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
};

export type RefundLedger = {
  refunds: LedgerRefund[];
  calls: { fn: string; args: any }[];
  rpc: (fn: string, args: any) => Promise<{ data: any; error: any }>;
  /** What a `.from("payment_refunds")` read answers: the rows matching client, payment, order,
   *  kind and the states asked for (`in`), older than `lt` created_at. */
  read: (ops: any[][]) => { data: any[]; error: null };
};

const money = (c: number) => (c / 100).toFixed(2);

export function refundLedger(payments: any[], seed: Partial<LedgerRefund>[] = [], opts: { failRpc?: (fn: string) => boolean } = {}): RefundLedger {
  const refunds: LedgerRefund[] = seed.map((r, i) => ({
    id: i + 1, client_id: "", payment_id: "", order_id: "", amount_cents: 0, kind: "gateway", state: "pending",
    request_key: `seed-key-${i + 1}`, method: null, reference: null, reason: null, gateway_orderid: null, gateway_retref: null,
    gateway_respcode: null, gateway_resptext: null, created_by: null, created_at: new Date().toISOString(), completed_at: null, ...r,
  } as LedgerRefund));
  const calls: { fn: string; args: any }[] = [];
  let next = refunds.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  let orderSeq = 0;
  const payView = (p: any) => ({ id: p.id, amount_cents: p.amount_cents, refunded_cents: p.refunded_cents ?? 0, voided_at: p.voided_at ?? null });

  const close = (id: number, state: string, retref: string | null, code: string | null, text: string | null): any => {
    const row = refunds.find((r) => r.id === id);
    if (!row) return { refused: "not_found" };
    const p = payments.find((x) => x.id === row.payment_id);
    if (row.state === "done" || row.state === "failed") return { already: true, refund: { ...row }, payment: payView(p) };
    if (state !== "done") {
      row.state = state as LedgerRefund["state"];
      row.gateway_retref = retref ?? row.gateway_retref;
      row.gateway_respcode = code ?? row.gateway_respcode;
      row.gateway_resptext = text ?? row.gateway_resptext;
      if (state === "failed") row.completed_at = new Date().toISOString();
      return { [state]: true, refund: { ...row } };
    }
    let left = Number(p.amount_cents) - row.amount_cents;
    const short = left < 0;
    if (short) left = 0;
    const refundedBefore = Number(p.refunded_cents ?? 0);
    const line = `Refunded $${money(row.amount_cents)}${row.kind === "manual" && row.method ? ` by ${row.method}` : ""} on ${new Date().toISOString().slice(0, 10)}` +
      ((retref ?? row.reference) ? ` (ref ${retref ?? row.reference})` : "");
    if (left === 0 && !p.voided_at) {
      p.voided_at = new Date().toISOString();
      p.void_reason = `refunded $${money(refundedBefore + row.amount_cents)}`;
    }
    p.amount_cents = left;
    p.refunded_cents = refundedBefore + row.amount_cents;
    p.note = [String(p.note ?? "").trim(), line].filter(Boolean).join("\n").slice(-2000);
    row.state = "done";
    row.completed_at = new Date().toISOString();
    row.gateway_retref = retref ?? row.gateway_retref;
    row.gateway_respcode = code ?? row.gateway_respcode;
    row.gateway_resptext = text ?? row.gateway_resptext;
    return { done: true, short, refund: { ...row }, payment: payView(p) };
  };

  const open = (a: any): any => {
    if (!["gateway", "manual"].includes(a.p_kind)) return { refused: "kind" };
    if (typeof a.p_key !== "string" || a.p_key.length < 8 || a.p_key.length > 100) return { refused: "key" };
    if (a.p_method != null && !["card", "cash", "check", "ach", "other"].includes(a.p_method)) return { refused: "method" };
    const p = payments.find((x) => x.id === a.p_payment && (x.client_id ?? a.p_client) === a.p_client);
    if (!p) return { refused: "not_found" };
    const same = refunds.find((r) => r.client_id === a.p_client && r.request_key === a.p_key);
    if (same) {
      if (same.payment_id !== a.p_payment || same.amount_cents !== a.p_amount) return { refused: "key_reused" };
      return { replay: true, refund: { ...same }, payment: payView(p) };
    }
    const inFlight = refunds.find((r) => r.payment_id === a.p_payment && (r.state === "pending" || r.state === "unknown"));
    if (inFlight) return { refused: "in_flight", refund: { ...inFlight } };
    if (p.voided_at) return { refused: "voided" };
    if (a.p_kind === "gateway" && (p.gateway !== "cardpointe" || !p.gateway_txn_id)) return { refused: "not_gateway" };
    if (a.p_kind === "manual" && p.gateway) return { refused: "not_manual" };
    if (!Number.isInteger(a.p_amount) || a.p_amount <= 0 || a.p_amount > Number(p.amount_cents)) {
      return { refused: "amount", refundable_cents: Number(p.amount_cents) };
    }
    const row: LedgerRefund = {
      id: next++, client_id: a.p_client, payment_id: a.p_payment, order_id: p.order_id, amount_cents: a.p_amount,
      kind: a.p_kind, state: "pending", request_key: a.p_key,
      method: a.p_method ?? (a.p_kind === "gateway" ? p.method ?? null : null),
      reference: a.p_reference ? String(a.p_reference).trim().slice(0, 200) || null : null,
      reason: a.p_reason ? String(a.p_reason).trim().slice(0, 500) || null : null,
      gateway_orderid: a.p_kind === "gateway" ? `ssr_${String(++orderSeq).padStart(20, "0")}` : null,
      gateway_retref: null, gateway_respcode: null, gateway_resptext: null,
      created_by: a.p_actor ?? null, created_at: new Date().toISOString(), completed_at: null,
    };
    refunds.push(row);
    if (a.p_kind === "manual") return { ...close(row.id, "done", null, null, null), opened: true };
    return { opened: true, refund: { ...row } };
  };

  return {
    refunds,
    calls,
    // deno-lint-ignore require-await
    rpc: async (fn: string, args: any) => {
      calls.push({ fn, args });
      if (opts.failRpc?.(fn)) return { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
      if (fn === "payment_refund_open") return { data: open(args), error: null };
      if (fn === "payment_refund_close") return { data: close(Number(args.p_refund), args.p_state, args.p_retref, args.p_respcode, args.p_resptext), error: null };
      throw new Error(`the refund ledger fake has no function ${fn}`);
    },
    read: (ops: any[][]) => {
      const eq = (col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];
      const states = (ops.find((o) => o[0] === "in" && o[1] === "state") ?? [])[2] as string[] | undefined;
      const before = (ops.find((o) => o[0] === "lt" && o[1] === "created_at") ?? [])[2];
      return {
        data: refunds.filter((r) =>
          (eq("client_id") === undefined || r.client_id === eq("client_id")) &&
          (eq("payment_id") === undefined || r.payment_id === eq("payment_id")) &&
          (eq("order_id") === undefined || r.order_id === eq("order_id")) &&
          (eq("kind") === undefined || r.kind === eq("kind")) &&
          (!states || states.includes(r.state)) &&
          (!before || r.created_at < before)
        ).map((r) => ({ ...r })),
        error: null,
      };
    },
  };
}
