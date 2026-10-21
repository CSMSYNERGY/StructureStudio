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
  /** Tables whose head count fails with something other than "no such table". */
  countErrors?: string[];
  /** The client_settings row the delete reads for what is connected outside the database. */
  settings?: Record<string, unknown> | null;
  /** Files under <tenant>/ per bucket, as paths below it ("a.png", "unit-1/b.png"). A bucket in
   *  `failList` refuses to list. The delete-time export is written to tenant-exports. */
  files?: Record<string, string[]>;
  /** Every file's size in bytes (10 by default). */
  fileSize?: number;
  failList?: string[];
  /** Migration 321: what tenant_purge answers. Absent: a dry run finds nothing and the purge
   *  reports `purged` = {} in one pass. `missing` = the function is not there (PGRST202). */
  purge?: { purged?: Record<string, number>; passes?: number; error?: string; dryError?: string; missing?: boolean };
  /** Rows the export reads, by table (each needs an `id`). */
  exportRows?: Record<string, Record<string, unknown>[]>;
  /** The export's upload to tenant-exports fails with this message. */
  uploadError?: string;
  /** Other builders' client_settings rows naming the same Resend domain id. */
  sharedDomain?: number;
  /** Numbers and A2P registration a builder NOT on a closed sub-account still holds. */
  parentNumbers?: string[];
  a2p?: { brand_sid: string | null; campaign_sid: string | null } | null;
  /** HTTP status Resend answers a domain delete with, and Intuit a revoke with (200 by default). */
  resendStatus?: number;
  qboRevokeStatus?: number;
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
  /** Migration 319: the tenant's tax charges still waiting on tax_charge_retry, which the delete
   *  closes (taxMeter.ts closeTenantTaxCharges). Absent: none. */
  taxOpenCharges?: number;
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
  /** tenant_purge calls, in order, with their arguments. */
  purges: any[];
  /** Objects written to storage: the export. */
  uploads: { bucket: string; path: string; bytes: Uint8Array; opts: any }[];
  /** Paths removed, by bucket. */
  removed: Record<string, string[]>;
  /** Resend and Intuit calls: "<METHOD> <url path>". */
  outsideCalls: string[];
}

export async function deleteClient(handler: (req: Request) => Promise<Response>, world: World): Promise<Run> {
  const run: Run = {
    status: 0, body: null, raw: "", log: [], gatewayCalls: [], wipes: [], audits: [], updates: [], faultRows: [], twilioCalls: [],
    purges: [], uploads: [], removed: {}, outsideCalls: [],
  };
  const files: Record<string, string[]> = Object.fromEntries(Object.entries(world.files ?? {}).map(([b, p]) => [b, [...p]]));

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
        if (table === "tax_lookups") {
          return { data: Array.from({ length: world.taxOpenCharges ?? 0 }, (_, i) => ({ id: `lookup-${i}` })), error: null };
        }
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
        if (table === "client_settings" && call.filters.some((f: any) => f[0] === "or")) return { error: null, count: world.sharedDomain ?? 0 };
        if (world.countErrors?.includes(table)) return { error: { message: "" }, count: null };
        return { error: null, count: world.retained?.[table] ?? 0 };
      }
      // The export's paged reads.
      if (call.range && eqv("client_id") === TENANT) {
        return { data: (world.exportRows?.[table] ?? []).slice(call.range[0], call.range[1] + 1), error: null };
      }
      switch (table) {
        case "sms_numbers":
          return { data: (world.parentNumbers ?? []).map((n) => ({ phone_number: n })), error: null };
        case "sms_registrations":
          return { data: world.a2p ?? null, error: null };
        case "client_configs":
          return { data: eqv("client_id") === TENANT ? { client_id: TENANT } : null, error: null };
        case "client_settings":
          return { data: eqv("client_id") === TENANT ? (world.settings ?? null) : null, error: null };
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
      in: (c: string, v: unknown) => { call.filters.push(["in", c, v]); return b; },
      is: (c: string, v: unknown) => { call.filters.push(["is", c, v]); return b; },
      or: (expr: string) => { call.filters.push(["or", expr, null]); return b; },
      order: (_c: string) => b,
      limit: (_n: number) => b,
      range: (a: number, z: number) => { call.range = [a, z]; return b; },
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
    if (url.startsWith("https://api.resend.com/")) {
      const line = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
      run.outsideCalls.push(line);
      run.log.push(`out ${line}`);
      const status = world.resendStatus ?? 200;
      return Promise.resolve(new Response(status === 200 ? "{}" : JSON.stringify({ name: "not_found", message: "nope" }), { status }));
    }
    if (/intuit\.com\//.test(url)) {
      const u = new URL(url);
      // The discovery document is never served here, so qboDiscovery.ts falls back to its defaults.
      if (/openid_configuration|\.well-known/.test(u.pathname)) return Promise.resolve(new Response("", { status: 503 }));
      const line = `${init?.method ?? "GET"} ${u.hostname}${u.pathname}`;
      run.outsideCalls.push(line);
      run.log.push(`out ${line}`);
      return Promise.resolve(new Response("", { status: world.qboRevokeStatus ?? 200 }));
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
  // Resend and QuickBooks keys, read at call time, so they can be set per run.
  Object.assign(env, { RESEND_API_KEY: "re_test_not_a_real_key", QBO_CLIENT_ID: "qbo-client-test", QBO_CLIENT_SECRET: "qbo-secret-test" });
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
    // 321's tenant_purge: a dry run first, then the purge (logged as a wipe, so "nothing was deleted"
    // assertions see it).
    if (fn === "tenant_purge" && args?.p_client_id === TENANT) {
      run.purges.push(args);
      const p = world.purge ?? {};
      if (p.missing) return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function public.tenant_purge" } });
      if (args.p_dry_run) {
        run.log[run.log.length - 1] = "db rpc tenant_purge (dry run)";
        if (p.dryError) return Promise.resolve({ data: null, error: { code: "57014", message: p.dryError } });
        return Promise.resolve({ data: { dryRun: true, clientId: TENANT, purge: p.purged ?? {}, kept: {}, tombstoned: false }, error: null });
      }
      if (p.error) return Promise.resolve({ data: null, error: { code: "23503", message: p.error } });
      run.wipes.push("tenant_purge");
      return Promise.resolve({ data: { dryRun: false, clientId: TENANT, purged: p.purged ?? {}, kept: {}, passes: p.passes ?? 1 }, error: null });
    }
    return Promise.reject(new Error(`deleteClientHarness: unexpected rpc ${fn}`));
  };
  // Storage as a tree of full paths per bucket ("<tenant>/a.png"). list() answers one level, the
  // way storage does: files with an id and a size, sub-folders with no id.
  const tree = (bucket: string) => (files[bucket] ??= []);
  for (const [b, paths] of Object.entries(files)) files[b] = paths.map((p) => `${TENANT}/${p}`);
  stubStorage.from = (bucket: string) => ({
    list: (dir: string, o?: { limit?: number; offset?: number }) => {
      run.log.push(`storage list ${bucket}`);
      if (world.failList?.includes(bucket)) return Promise.resolve({ data: null, error: { message: "list failed" } });
      const pre = dir ? `${dir}/` : "";
      const entries = new Map<string, any>();
      for (const p of tree(bucket)) {
        if (!p.startsWith(pre)) continue;
        const rest = p.slice(pre.length);
        const slash = rest.indexOf("/");
        if (slash < 0) entries.set(rest, { name: rest, id: `obj-${rest}`, metadata: { size: world.fileSize ?? 10 }, created_at: "2026-10-21T00:00:00Z" });
        else entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null, metadata: null });
      }
      const all = [...entries.values()].sort((a, z) => a.name.localeCompare(z.name));
      const off = o?.offset ?? 0;
      return Promise.resolve({ data: all.slice(off, off + (o?.limit ?? 100)), error: null });
    },
    remove: (paths: string[]) => {
      run.log.push(`storage remove ${bucket}`);
      const gone = paths.filter((p) => tree(bucket).includes(p));
      files[bucket] = tree(bucket).filter((p) => !paths.includes(p));
      (run.removed[bucket] ??= []).push(...gone);
      return Promise.resolve({ data: gone.map((name) => ({ name })), error: null });
    },
    download: (path: string) =>
      Promise.resolve(tree(bucket).includes(path) ? { data: new Blob([`bytes of ${path}`]), error: null } : { data: null, error: { message: "not found" } }),
    upload: (path: string, bytes: Uint8Array, opts: any) => {
      run.log.push(`storage upload ${bucket}`);
      if (world.uploadError) return Promise.resolve({ data: null, error: { message: world.uploadError } });
      run.uploads.push({ bucket, path, bytes, opts });
      tree(bucket).push(path);
      return Promise.resolve({ data: { path }, error: null });
    },
    createSignedUrl: (path: string, secs: number, _o?: any) =>
      Promise.resolve({ data: { signedUrl: `https://storage.test/sign/${bucket}/${path}?token=t&secs=${secs}` }, error: null }),
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

/** Index of the first table wipe in the log (a delete, or tenant_purge's real run), or Infinity
 *  when nothing was wiped. */
export const firstWipe = (run: Run) => {
  const i = run.log.findIndex((l) => (l.startsWith("db delete ") && l !== "db delete admin_auth_attempts") || l === "db rpc tenant_purge");
  return i < 0 ? Infinity : i;
};
