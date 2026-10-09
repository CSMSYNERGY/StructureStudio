// The harness deleteClientGateway_test.ts and deleteClientGatewayUnconfigured_test.ts share: the
// SHIPPED admin-catalog handler, a fake database and a fake payment gateway, and one ordered log of
// everything the delete did, so a test can ask "did any gateway call come after a wipe?".
//
// Not a test file itself (no _test suffix), so preflight runs it only through those two.
//
// WHY TWO FILES. nmi.ts reads its keys once, at load, and each test file gets its own module
// instance. So "the gateway is configured" and "it is not" can only both be driven through the real
// handler from two files, each loading admin-catalog under its own environment.
//
// HOW. The deleteDesignWiring_test idiom: Deno.serve is stubbed while admin-catalog/index.ts is
// imported. The import map swaps supabase-js for supabase_stub.ts, whose stubDb / stubStorage route
// every table and bucket call into the fakes below. globalThis.fetch is the gateway and nothing else,
// and no --allow-net is granted, so nothing leaves the box. The caller authenticates with the
// ADMIN_PASSWORD break-glass path (no Authorization header), which is a real path for this action.
// Tenants, ids and keys are made up (the repo is public).

// deno-lint-ignore-file no-explicit-any
import { stubDb, stubRpc, stubStorage } from "./supabase_stub.ts";

export const GATEWAY_URL = "https://gateway.test";
export const SECURITY_KEY = "sk_test_not_a_real_key";
const ADMIN_PASSWORD = "admin-password-test";
export const TENANT = "acme-sheds";

/** Load the real handler with the gateway configured (or not). Env is restored straight after: only
 *  the module-level reads see it. */
export async function loadAdminCatalog(gatewayConfigured: boolean): Promise<(req: Request) => Promise<Response>> {
  const env: Record<string, string> = gatewayConfigured
    ? { NMI_SECURITY_KEY: SECURITY_KEY, NMI_TOKENIZATION_KEY: "tok_test_not_a_real_key", NMI_GATEWAY_URL: GATEWAY_URL }
    : {};
  const cleared = ["NMI_SECURITY_KEY", "NMI_TOKENIZATION_KEY", "NMI_GATEWAY_URL"];
  const prior = Object.fromEntries(cleared.map((k) => [k, Deno.env.get(k)]));
  for (const k of cleared) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    // Computed specifier, as in aiDraftStreamWiring_test: a literal one would type-check
    // admin-catalog against the stub's partial client type.
    await import(new URL("../../admin-catalog/index.ts", import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
  if (!handler) throw new Error("admin-catalog did not hand Deno.serve a handler");
  return handler;
}

/** The tenant's billing state. It CHANGES as the delete runs, the way the database would: the
 *  gateway step's mirror-row hooks mark a subscription cancelled and drop the vault row, so a second
 *  delete_client on the same world sees what a retry would. */
export interface World {
  subs: { id: string; status: string | null }[];
  vault: string | null;
  /** Other tenants' billing_customers rows holding the same vault id. */
  sharedVault?: number;
  /** Rows each wipe finds, by table (0 when absent). */
  rows?: Record<string, number>;
  /** Rows the head counts find, by table: the retained ledgers and the left-behind tables. */
  retained?: Record<string, number>;
  /** A table whose wipe fails (a statement timeout, say), to drive a delete that stops part-way. */
  failWipe?: string;
  /** The gateway's answer to one call: a body string, an HTTP status, or a throw (no answer). */
  gateway?: (params: Record<string, string>) => string | number;
  /** Workstream 2, phase 9: the tenant's twilio_accounts row and what Twilio holds for it. Absent:
   *  no row (every test before phase 9), and Twilio is never called. */
  twilio?: {
    row: { kind: string; status: string; account_sid: string | null } | null;
    /** Numbers Twilio lists in the sub (IncomingPhoneNumbers). */
    numbers?: string[];
    /** Twilio's HTTP status for the close; 200 by default. */
    closeStatus?: number;
    /** The twilio_accounts read fails with this code (PGRST205: the table is not there yet). */
    readError?: string;
    /** The accounts Twilio lists under the tenant's FriendlyName (a create whose answer was lost). */
    named?: { sid: string; status: string }[];
    /** twilio_account_forget fails with this code (PGRST202: migration 295 not applied). */
    forgetError?: string;
  };
}

export interface Run {
  status: number;
  body: any;
  raw: string;
  /** Everything in order: "gw <op> <id>", "db <op> <table>". */
  log: string[];
  gatewayCalls: Record<string, string>[];
  wipes: string[];
  audits: any[];
  updates: { table: string; payload: any; filters: [string, string, unknown][] }[];
  faultRows: any[];
  /** Twilio requests, in order: "<METHOD> <path>" (also in `log` as "tw ..."). */
  twilioCalls: string[];
}

export async function deleteClient(handler: (req: Request) => Promise<Response>, world: World): Promise<Run> {
  const run: Run = { status: 0, body: null, raw: "", log: [], gatewayCalls: [], wipes: [], audits: [], updates: [], faultRows: [], twilioCalls: [] };

  const from = (table: string) => {
    const call: any = { table, op: "select", filters: [] as [string, string, unknown][], opts: undefined, payload: undefined };
    const eqv = (col: string) => call.filters.find((f: any) => f[0] === "eq" && f[1] === col)?.[2];
    const answer = (): any => {
      run.log.push(`db ${call.op} ${table}`);
      if (call.op === "delete") {
        if (table === world.failWipe) return { error: { message: "canceling statement due to statement timeout" }, count: null };
        if (table !== "admin_auth_attempts") run.wipes.push(table);
        if (table === "billing_customers" && eqv("client_id") === TENANT) {
          const had = world.vault ? 1 : 0;
          world.vault = null;
          return { error: null, count: had };
        }
        return { error: null, count: table === "client_configs" ? 1 : (world.rows?.[table] ?? 0) };
      }
      if (call.op === "insert") {
        if (table === "admin_audit") run.audits.push(call.payload);
        if (table === "app_errors") run.faultRows.push(call.payload);
        return { error: null };
      }
      if (call.op === "update") {
        run.updates.push({ table, payload: call.payload, filters: call.filters });
        if (table === "twilio_accounts" && world.twilio?.row && eqv("client_id") === TENANT) {
          world.twilio.row = { ...world.twilio.row, ...call.payload };
          return { data: [{ client_id: TENANT }], error: null, count: 1 };
        }
        if (table === "billing_subscriptions" && eqv("client_id") === TENANT) {
          // A new array: callers share fixture arrays across tests, so the rows are never mutated.
          world.subs = world.subs.map((s) => (s.id === eqv("id") ? { ...s, status: call.payload?.status ?? s.status } : s));
        }
        return { error: null, count: 1 };
      }
      // reads
      if (call.opts?.head) {
        if (table === "billing_customers") return { error: null, count: world.sharedVault ?? 0 };
        return { error: null, count: world.retained?.[table] ?? 0 };
      }
      switch (table) {
        case "client_configs":
          return { data: eqv("client_id") === TENANT ? { client_id: TENANT } : null, error: null };
        case "billing_subscriptions":
          return { data: eqv("client_id") === TENANT ? world.subs : [], error: null };
        case "billing_customers":
          return { data: eqv("client_id") === TENANT && world.vault ? { vault_id: world.vault } : null, error: null };
        case "twilio_accounts":
          if (world.twilio?.readError) return { data: null, error: { code: world.twilio.readError, message: "twilio_accounts read failed" } };
          return { data: eqv("client_id") === TENANT && world.twilio?.row ? { ...world.twilio.row } : null, error: null };
        default:
          return { data: table === "client_users" ? [] : null, error: null };
      }
    };
    const b: any = {
      select: (_c?: string, o?: any) => { if (call.op === "select") call.opts = o; return b; },
      insert: (p: any) => { call.op = "insert"; call.payload = p; return b; },
      update: (p: any, o?: any) => { call.op = "update"; call.payload = p; call.opts = o; return b; },
      upsert: (p: any, o?: any) => { call.op = "upsert"; call.payload = p; call.opts = o; return b; },
      delete: (o?: any) => { call.op = "delete"; call.opts = o; return b; },
      eq: (c: string, v: unknown) => { call.filters.push(["eq", c, v]); return b; },
      neq: (c: string, v: unknown) => { call.filters.push(["neq", c, v]); return b; },
      lt: (c: string, v: unknown) => { call.filters.push(["lt", c, v]); return b; },
      is: (c: string, v: unknown) => { call.filters.push(["is", c, v]); return b; },
      maybeSingle: () => Promise.resolve(answer()),
      single: () => Promise.resolve(answer()),
      then: (res: any, rej: any) => Promise.resolve(answer()).then(res, rej),
    };
    return b;
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (world.twilio && url.startsWith("https://api.twilio.com/")) {
      const u = new URL(url);
      const line = `${init?.method ?? "GET"} ${u.pathname}`;
      run.twilioCalls.push(line);
      run.log.push(`tw ${line}`);
      if (/\/IncomingPhoneNumbers\.json$/.test(u.pathname)) {
        return Promise.resolve(new Response(JSON.stringify({ incoming_phone_numbers: (world.twilio.numbers ?? []).map((n) => ({ phone_number: n })) }), { status: 200 }));
      }
      if (/\/Accounts\.json$/.test(u.pathname) && (init?.method ?? "GET") === "GET") {
        const named = (world.twilio.named ?? []).map((a) => ({ sid: a.sid, status: a.status, friendly_name: u.searchParams.get("FriendlyName") }));
        return Promise.resolve(new Response(JSON.stringify({ accounts: named }), { status: 200 }));
      }
      const status = world.twilio.closeStatus ?? 200;
      return Promise.resolve(new Response(JSON.stringify(status === 200 ? { status: "closed" } : { code: 20005 }), { status }));
    }
    if (url !== `${GATEWAY_URL}/api/transact.php`) {
      return Promise.reject(new Error(`deleteClientHarness: unexpected fetch to ${url}`));
    }
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    run.gatewayCalls.push(params);
    run.log.push(params.recurring
      ? `gw delete_subscription ${params.subscription_id}`
      : `gw ${params.customer_vault} ${params.customer_vault_id}`);
    let out: string | number;
    try {
      out = world.gateway ? world.gateway(params) : "response=1&responsetext=OK&response_code=100";
    } catch (e) {
      return Promise.reject(e); // no answer: nmi.ts turns it into GATEWAY_UNKNOWN
    }
    return Promise.resolve(typeof out === "number" ? new Response("", { status: out }) : new Response(out, { status: 200 }));
  }) as typeof fetch;

  const env: Record<string, string> = { SUPABASE_URL: "http://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-role-test", ADMIN_PASSWORD };
  // The parent's SID and auth token: closing a sub-account is done with them (Workstream 2).
  if (world.twilio) Object.assign(env, { TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32), TWILIO_AUTH_TOKEN: "parent-auth-token-test" });
  const prior = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  stubDb.from = from;
  // 295's twilio_account_forget, the delete's last Twilio step (only ever called with a row).
  stubRpc.rpc = (fn: string, args?: any) => {
    run.log.push(`db rpc ${fn}`);
    if (fn === "twilio_account_forget" && args?.p_client_id === TENANT) {
      if (world.twilio?.forgetError) return Promise.resolve({ data: null, error: { code: world.twilio.forgetError, message: "forget failed" } });
      const r = world.twilio?.row;
      world.twilio = world.twilio ? { ...world.twilio, row: null } : world.twilio;
      return Promise.resolve({ data: !r ? "none" : r.kind === "parent" ? "parent_pin" : r.account_sid ? "closed_sub" : "never_created", error: null });
    }
    return Promise.reject(new Error(`deleteClientHarness: unexpected rpc ${fn}`));
  };
  stubStorage.from = (bucket: string) => ({
    list: () => { run.log.push(`storage list ${bucket}`); return Promise.resolve({ data: [], error: null }); },
    remove: () => Promise.resolve({ data: [], error: null }),
  });
  try {
    const res = await handler(new Request("http://localhost/functions/v1/admin-catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ action: "delete_client", clientId: TENANT, confirmClientId: TENANT, adminPassword: ADMIN_PASSWORD }),
    }));
    run.status = res.status;
    run.raw = await res.text();
    run.body = JSON.parse(run.raw);
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubStorage.from = null;
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
  return run;
}

/** Index of the first table wipe in the log, or Infinity when nothing was wiped. */
export const firstWipe = (run: Run) => {
  const i = run.log.findIndex((l) => l.startsWith("db delete ") && l !== "db delete admin_auth_attempts");
  return i < 0 ? Infinity : i;
};
