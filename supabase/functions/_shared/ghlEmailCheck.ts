/**
 * ghlEmailCheck.ts: finds out what became of a quote email after GHL accepted it (migration 357).
 *
 * WHY THIS EXISTS. POST /invoices/estimate/{id}/send answers 201 when GHL takes the request, not
 * when the email leaves. In October 2026 one builder's quote emails failed inside GHL after that
 * 201. The design went to `sent`, app_errors stayed empty, and the builder heard about it from
 * customers four weeks later. So submit-estimate queues a row for each accepted send, and the
 * ghl-email-check function comes back to read the result and files a row in app_errors when the
 * email did not go.
 *
 * ── WHAT THE STORED KEY CAN SEE (measured on a real tenant's key, 2026-11-04) ────────────────
 * The tenant's `pit-` key sees much less than a person's browser session does on the same email:
 *
 *                              stored key                     browser session
 *   real failure               status failed, error           status failed, error
 *   silent failure             status pending                 no status at all
 *   healthy email              delivered or clicked           sent or delivered, with counts
 *   events, channel, files     missing                        present
 *
 * ⚠️ So this module decides on status and error only. Do not add a rule on `events` or
 * `meta.email.channel` after reading them in a browser: through the key the counts do not exist
 * and a delivered email has no channel, so such a rule would fire on every healthy email. Do not
 * use a session token either: it belongs to a person and expires.
 *
 * ⚠️ `pending` IS THE SILENT FAILURE. Four quote emails sat at it for weeks and one customer
 * confirmed hers never came. It is only a failure with time behind it, since a healthy email may
 * show it for a moment, which is why it waits for the final look.
 *
 * ── FINDING THE EMAIL ───────────────────────────────────────────────────────────────────────
 * Contact, then conversation, then outbound email rows added inside a short window around the
 * send. Rows appeared 1.1 to 1.5 s after the send started, so the window can be tight, and a tight
 * window keeps out a hand-forwarded email or an invoice email to the same contact. `sourceType` is
 * not used: it can be null, and invoices share its value. The email route answers only to
 * meta.email.messageIds[0]; the message row's own id gets a 400.
 *
 * Dependency-free on purpose (fetch, the database and the filing are parameters), so the test
 * drives every path offline.
 */

/** About when a real failure has settled. They settled within seconds on every one read. */
export const FIRST_LOOK_MINUTES = 5;
/** When no result counts as no delivery. The silent emails never moved off pending in weeks. */
export const FINAL_LOOK_MINUTES = 60;
/** How long a GHL outage may keep a row open before a person is told it could not be read. */
export const GIVE_UP_HOURS = 24;
/** A claimed row that did not finish comes back after this. It is also the tick's period. */
export const RETRY_MINUTES = 5;
/** One run's cap. Up to three GHL reads each, and the Worker waits 25 s for the answer. */
export const CHECKS_PER_RUN = 15;
export const MATCH_BEFORE_MS = 30_000;
export const MATCH_AFTER_MS = 5 * 60_000;

const GHL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const FETCH_TIMEOUT_MS = 8_000;
const CONVERSATIONS_PER_CONTACT = 3;
const EMAILS_PER_CONVERSATION = 50;
const ERROR_TEXT_MAX = 300;

const FAILED_STATUSES = new Set(["failed", "undelivered"]);
const HEALTHY_STATUSES = new Set(["sent", "delivered", "opened", "clicked", "read", "replied"]);

export const COLUMNS = "id, client_id, short_code, ghl_estimate_id, ghl_contact_id, send_started_at, " +
  "next_check_at, looks, ghl_conversation_id, ghl_email_id, test_inbox";

export type CheckRow = {
  id: number;
  client_id: string;
  short_code: string;
  ghl_estimate_id: string;
  ghl_contact_id: string;
  send_started_at: string;
  next_check_at: string;
  looks: number;
  ghl_conversation_id: string | null;
  ghl_email_id: string | null;
  test_inbox: boolean;
};

export type EmailView = { status: string; error: string; channel: string };
export type Decision = "failed" | "wait" | "ok" | "no_delivery" | "unknown_status";

export type FiledError = {
  code: string;
  message: string;
  clientId: string;
  severity: "error" | "warn";
  context: Record<string, unknown>;
};

// deno-lint-ignore no-explicit-any
type Db = { from: (table: string) => any };
type Deps = {
  db: Db;
  fetch: typeof fetch;
  file: (row: FiledError) => Promise<void>;
  now?: () => Date;
};

const minutesAfter = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/** GHL's status word, safe to store: lower case, and nothing but the characters a status uses. */
function statusWord(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_ -]/g, "").slice(0, 40);
}

/** GHL's error text can name the recipient. Email addresses and phone numbers do not reach a row. */
export function scrubProviderText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ERROR_TEXT_MAX);
}

/** The decision, on what the key can see. `final` means no later look is coming. */
export function decide(view: EmailView, final: boolean): Decision {
  if (FAILED_STATUSES.has(view.status) || view.error) return "failed";
  if (!final) return "wait";
  if (HEALTHY_STATUSES.has(view.status)) return "ok";
  if (!view.status || view.status === "pending") return "no_delivery";
  return "unknown_status";
}

/**
 * Queue one accepted send. NEVER THROWS, and the caller only logs a failure: nothing here may reach
 * the quote or the response the customer is waiting for.
 */
export async function enqueueGhlEmailCheck(db: Db, input: {
  clientId: string;
  shortCode: string;
  estimateId: string;
  contactId: string;
  sendStartedAt: string;
  testInbox: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await db.from("ghl_email_checks").insert({
      client_id: input.clientId,
      short_code: input.shortCode,
      ghl_estimate_id: input.estimateId,
      ghl_contact_id: input.contactId,
      send_started_at: input.sendStartedAt,
      next_check_at: minutesAfter(input.sendStartedAt, FIRST_LOOK_MINUTES),
      test_inbox: input.testInbox,
    });
    return error ? { ok: false, error: String(error.message ?? error) } : { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

type Route = "search" | "messages" | "email";
// deno-lint-ignore no-explicit-any
type Got = { status: number | null; body: any };
type Outcome =
  | { kind: "found"; view: EmailView; conversationId: string | null; emailId: string | null }
  | { kind: "missing" }
  | { kind: "refused"; httpStatus: number; route: Route }
  | { kind: "later"; httpStatus: number | null; route: Route };

async function ghlGet(f: typeof fetch, apiKey: string, path: string): Promise<Got> {
  try {
    const r = await f(`${GHL}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Version: VERSION, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let body = null;
    try { body = await r.json(); } catch { /* not JSON; the status still says enough */ }
    return { status: r.status, body };
  } catch {
    return { status: null, body: null };
  }
}

/** A read that ends the look. 400 and 404 do not: they mean this id is not there, which is an answer. */
function stopped(got: Got, route: Route): Outcome | null {
  if (got.status === 401 || got.status === 403) return { kind: "refused", httpStatus: got.status, route };
  if (got.status === null || got.status === 429 || got.status >= 500) return { kind: "later", httpStatus: got.status, route };
  return null;
}

/** Both are read: a healthy row can have a null status while the email route has one. */
// deno-lint-ignore no-explicit-any
function viewOf(row: any, email: any): EmailView {
  const rowStatus = statusWord(row?.status);
  const emailStatus = statusWord(email?.status);
  return {
    status: FAILED_STATUSES.has(rowStatus) ? rowStatus : (emailStatus || rowStatus),
    error: scrubProviderText(email?.error || row?.error || row?.meta?.email?.error || ""),
    channel: scrubProviderText(email?.meta?.email?.channel || row?.meta?.email?.channel || "").slice(0, 60),
  };
}

// deno-lint-ignore no-explicit-any
const emailOf = (body: any) => body?.emailMessage ?? body;
const emailPath = (id: string) => `/conversations/messages/email/${encodeURIComponent(id)}`;

async function readEmail(f: typeof fetch, apiKey: string, locationId: string, row: CheckRow, claimed: Set<string>): Promise<Outcome> {
  if (row.ghl_email_id) {
    const got = await ghlGet(f, apiKey, emailPath(row.ghl_email_id));
    const stop = stopped(got, "email");
    if (stop) return stop;
    if (got.status === 200) {
      return { kind: "found", view: viewOf(null, emailOf(got.body)), conversationId: row.ghl_conversation_id, emailId: row.ghl_email_id };
    }
    // The stored id stopped answering, so look the email up again below.
  }

  const search = await ghlGet(
    f,
    apiKey,
    `/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(row.ghl_contact_id)}&limit=${CONVERSATIONS_PER_CONTACT}`,
  );
  const searchStop = stopped(search, "search");
  if (searchStop) return searchStop;
  if (search.status !== 200) return { kind: "missing" };

  const start = Date.parse(row.send_started_at);
  // deno-lint-ignore no-explicit-any
  const candidates: { at: number; row: any; conversationId: string }[] = [];
  for (const conv of (search.body?.conversations ?? []).slice(0, CONVERSATIONS_PER_CONTACT)) {
    const got = await ghlGet(
      f,
      apiKey,
      `/conversations/${encodeURIComponent(conv.id)}/messages?type=TYPE_EMAIL&limit=${EMAILS_PER_CONVERSATION}`,
    );
    const stop = stopped(got, "messages");
    if (stop) return stop;
    if (got.status !== 200) continue;
    for (const x of got.body?.messages?.messages ?? []) {
      const at = Date.parse(x?.dateAdded);
      if (x?.direction !== "outbound" || Number.isNaN(at)) continue;
      if (at < start - MATCH_BEFORE_MS || at > start + MATCH_AFTER_MS) continue;
      candidates.push({ at, row: x, conversationId: conv.id });
    }
  }
  candidates.sort((a, b) => a.at - b.at);

  const pick = candidates.find((c) => !claimed.has(String(c.row?.meta?.email?.messageIds?.[0] ?? "")));
  if (!pick) return { kind: "missing" };
  const emailId: string | null = pick.row?.meta?.email?.messageIds?.[0] ?? null;
  if (!emailId) return { kind: "found", view: viewOf(pick.row, null), conversationId: pick.conversationId, emailId: null };

  const got = await ghlGet(f, apiKey, emailPath(emailId));
  const stop = stopped(got, "email");
  if (stop) return stop;
  return {
    kind: "found",
    view: viewOf(pick.row, got.status === 200 ? emailOf(got.body) : null),
    conversationId: pick.conversationId,
    emailId,
  };
}

// Fixed sentences on purpose. They group in triage, and nothing from the email can reach them.
const REPORTS = {
  failed: { code: "ghl_quote_email_failed", severity: "error", message: "GHL accepted a quote email and then failed it." },
  no_delivery: { code: "ghl_quote_email_no_delivery", severity: "error", message: `GHL accepted a quote email and it had not left ${FINAL_LOOK_MINUTES} minutes later.` },
  unknown_status: { code: "ghl_quote_email_no_delivery", severity: "warn", message: `GHL accepted a quote email and showed a status this check does not know ${FINAL_LOOK_MINUTES} minutes later.` },
  not_found: { code: "ghl_quote_email_not_found", severity: "error", message: `GHL accepted a quote email but no email row was in the contact's conversation ${FINAL_LOOK_MINUTES} minutes later.` },
  unreadable: { code: "ghl_quote_email_unreadable", severity: "error", message: "GHL did not let this check read what became of a quote email." },
} as const;

export type RunSummary = {
  ok: boolean;
  error?: string;
  due: number;
  looked: number;
  waiting: number;
  closedOk: number;
  filed: number;
  writeErrors: number;
};

/** One tick's work. Returns ok:false only when the queue itself could not be read. */
export async function runGhlEmailChecks(deps: Deps): Promise<RunSummary> {
  const nowDate = deps.now ?? (() => new Date());
  const summary: RunSummary = { ok: true, due: 0, looked: 0, waiting: 0, closedOk: 0, filed: 0, writeErrors: 0 };

  const { data: due, error: dueErr } = await deps.db.from("ghl_email_checks")
    .select(COLUMNS)
    .eq("state", "pending")
    .lte("next_check_at", nowDate().toISOString())
    .order("next_check_at", { ascending: true })
    .limit(CHECKS_PER_RUN);
  if (dueErr) return { ...summary, ok: false, error: String(dueErr.message ?? dueErr) };
  summary.due = (due ?? []).length;

  // undefined means the read itself failed, which says nothing about the tenant: the row waits for
  // the next tick. Only a read that worked and found no key is reported as no key.
  const credentials = new Map<string, { apiKey: string; locationId: string } | null>();
  const credentialsOf = async (clientId: string) => {
    if (!credentials.has(clientId)) {
      const { data, error } = await deps.db.from("client_settings")
        .select("ghl_api_key, ghl_location_id").eq("client_id", clientId).maybeSingle();
      if (error) return undefined;
      credentials.set(clientId, data?.ghl_api_key && data?.ghl_location_id
        ? { apiKey: String(data.ghl_api_key), locationId: String(data.ghl_location_id) }
        : null);
    }
    return credentials.get(clientId);
  };

  for (const r of (due ?? []) as CheckRow[]) {
    const now = nowDate();
    const nowIso = now.toISOString();

    // Claim it first, and push it out of the due list. Two ticks overlapping would otherwise both
    // read the row and file the failure twice. A run that dies here brings it back in RETRY_MINUTES.
    const { data: claimedRow } = await deps.db.from("ghl_email_checks")
      .update({ looks: r.looks + 1, next_check_at: minutesAfter(nowIso, RETRY_MINUTES) })
      .eq("id", r.id).eq("state", "pending").eq("looks", r.looks)
      .select("id");
    if (!claimedRow || !claimedRow.length) continue;
    summary.looked++;

    const minutes = Math.floor((now.getTime() - Date.parse(r.send_started_at)) / 60_000);
    const baseContext = {
      designId: r.short_code,
      estimateId: r.ghl_estimate_id,
      minutesAfterSend: minutes,
      ...(r.test_inbox ? { testInbox: true } : {}),
    };

    // Filed before the row closes, so a failed write repeats a report rather than losing it.
    const close = async (
      state: "ok" | "failed" | "no_delivery" | "not_found" | "unreadable",
      report: keyof typeof REPORTS | null,
      fields: Record<string, unknown>,
      context: Record<string, unknown> = {},
    ) => {
      if (report) {
        await deps.file({ ...REPORTS[report], clientId: r.client_id, context: { ...baseContext, ...context } });
        summary.filed++;
      } else {
        summary.closedOk++;
      }
      const { error } = await deps.db.from("ghl_email_checks")
        .update({ state, closed_at: nowIso, ...fields }).eq("id", r.id);
      if (error) {
        summary.writeErrors++;
        await deps.file({
          code: "ghl_email_check_write_failed",
          severity: "error",
          message: `Could not close a quote email check: ${scrubProviderText(error.message ?? error)}`,
          clientId: r.client_id,
          context: { ...baseContext, state },
        });
      }
    };

    const creds = await credentialsOf(r.client_id);
    if (creds === undefined) {
      summary.waiting++;
      continue;
    }
    if (!creds) {
      await close("unreadable", "unreadable", {}, { reason: "no_ghl_key" });
      continue;
    }

    const { data: others } = await deps.db.from("ghl_email_checks")
      .select("id, ghl_email_id")
      .eq("client_id", r.client_id).eq("ghl_contact_id", r.ghl_contact_id).not("ghl_email_id", "is", null);
    const claimed = new Set<string>(
      (others ?? []).filter((o: { id: number }) => o.id !== r.id).map((o: { ghl_email_id: string }) => o.ghl_email_id),
    );

    const final = minutes >= FINAL_LOOK_MINUTES;
    const out = await readEmail(deps.fetch, creds.apiKey, creds.locationId, r, claimed);

    if (out.kind === "refused") {
      await close("unreadable", "unreadable", {}, { route: out.route, httpStatus: out.httpStatus });
      continue;
    }
    if (out.kind === "later") {
      // GHL is down or busy. The claim already set the next try.
      if (minutes >= GIVE_UP_HOURS * 60) await close("unreadable", "unreadable", {}, { route: out.route, httpStatus: out.httpStatus });
      else summary.waiting++;
      continue;
    }
    if (out.kind === "missing") {
      if (final) {
        await close("not_found", "not_found", {});
      } else {
        await deps.db.from("ghl_email_checks")
          .update({ next_check_at: minutesAfter(r.send_started_at, FINAL_LOOK_MINUTES) }).eq("id", r.id);
        summary.waiting++;
      }
      continue;
    }

    const fields = { ghl_conversation_id: out.conversationId, ghl_email_id: out.emailId, last_status: out.view.status || null };
    const detail = {
      emailId: out.emailId,
      status: out.view.status || null,
      ...(out.view.channel ? { channel: out.view.channel } : {}),
      ...(out.view.error ? { providerError: out.view.error } : {}),
    };
    const decision = decide(out.view, final);
    if (decision === "wait") {
      const { error } = await deps.db.from("ghl_email_checks")
        .update({ ...fields, next_check_at: minutesAfter(r.send_started_at, FINAL_LOOK_MINUTES) }).eq("id", r.id);
      if (error) summary.writeErrors++;
      summary.waiting++;
    } else if (decision === "ok") {
      await close("ok", null, fields);
    } else if (decision === "failed") {
      await close("failed", "failed", fields, detail);
    } else {
      await close("no_delivery", decision, fields, detail);
    }
  }
  return summary;
}
