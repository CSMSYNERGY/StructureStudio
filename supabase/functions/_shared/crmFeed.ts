// One normalized activity feed for the Pipedrive-style record page.
//
// A SERVER-SIDE UNION, deliberately not a materialized `activities` table and not a SQL
// view.
//   * Not materialized: it would need a backfill AND a dual-write in six existing writers
//     AND a permanent consistency problem, to buy a performance win that does not exist at
//     this scale (a tenant has hundreds of designs, not millions).
//   * Not a SQL view: it must union email_sends and invoice_sends, which are
//     service-role-only with zero policies, so the view would need SECURITY DEFINER anyway
//     — which an edge function already is, with resolveTenant, GATES and audit attached.
//
// 🚨 THE ONE THING THAT HAD TO CHANGE. portal-settings' existing `contact_activity` pages
// the GHL estimate list — up to 20 requests × 100 — ON EVERY DRAWER OPEN. That is
// survivable in a drawer you open occasionally and fatal on a page you land on. So nothing
// here calls GHL. Almost every signal is already projected locally; the two that are not
// (`ghl_last_visited_at`, `ghl_status_at`) are stamped by sync-design-status, which already
// lists estimates ONCE PER TENANT rather than once per design and which the portal already
// fires on every list load. Zero marginal cost, and it fixes the timezone landmine
// documented in 02-sales.jsx once, at write time, instead of re-deriving it in the browser
// on every render.

export type FeedEvent = {
  id: string;
  type: string;
  at: string;
  actor?: string | null;
  title: string;
  body?: string | null;
  code?: string | null;
  contactId?: string | null;
  meta?: Record<string, unknown> | null;
  icon?: string | null;
  pinned?: boolean;
  /** A file this event IS, rather than describes — the quote PDF, the floor plan, the thing
   *  the customer sent. Present only on document events; the browser opens it in the pop-up
   *  viewer. Signed and short-lived for anything in a private bucket. */
  url?: string | null;
};

// The chip vocabulary, shared with the browser. The chip row and this filter read the SAME
// map, so a chip can never request a type the server does not emit — the RANK/STATUS_RANK
// class of bug, headed off before it can happen again.
export const CRM_FEED_TYPES = {
  activity: ["activity"],
  note: ["note"],
  // Both directions under one chip: Carolyn asked to "see my emails and only emails in a
  // quick and easy way", and a conversation split across two filters is not that.
  email: ["email", "email_in"],
  // SMS, BOTH DIRECTIONS, UNDER ONE "MESSAGES" CHIP — the same reasoning as `email` above:
  // a conversation split across two filters is not a conversation.
  //
  // ⚠️ THIS REVERSES A DECISION THAT WAS TAKEN TWICE, AND THE HISTORY IS THE POINT.
  // This slot used to hold a comment reading "NO SMS TYPE, DELIBERATELY", recording that on
  // 2026-08-25 Ahsan removed a reserved `sms` type and a greyed WhatsApp tab: "we are not
  // using Twilio for conversation or campaigns. We are only using Twilio to get the code to
  // log in. That's it. For conversation, we are using emails." It argued — correctly, at the
  // time — that a reserved seam for a feature nobody intends to build is not foresight but a
  // misleading comment somebody eventually acts on.
  //
  // Then Carolyn asked for it on 2026-08-26 (27:02): "and we have calls. We probably need
  // SMS in there, too. We will need that in there as well." Ahsan approved building it for
  // real on 08-27. What lands now is not a reserved seam — it is a working channel with a
  // table, a send path, an inbound webhook and per-tenant numbers behind it.
  //
  // WhatsApp remains not a feature, and nothing here reserves a slot for it.
  message: ["sms", "sms_in"],
  // CALLS (My Synergy Phone, 2026-09-29). Carolyn, 2026-08-26 27:02: "and we have calls." Three types
  // under one chip, for the reason email and message are one chip each — a conversation split
  // across filters is not a conversation:
  //   call        — a call that connected (either direction), or an outbound one that did not
  //                 (no answer / busy): the builder placed it, so it is theirs to see as a call;
  //   call_missed — an inbound call nobody answered and no message was left;
  //   voicemail   — an inbound call nobody answered where the customer left a message.
  // Read from phone_calls (migration 254) with the voicemail embedded; see the slot-14 read.
  // Mirrors CRM_CHIPS' "calls" in portal/02-sales.jsx; keep the two identical.
  call: ["call", "call_missed", "voicemail"],
  // DOCUMENTS ARE HISTORY, NOT AN ACTION. Carolyn, 2026-08-26 24:01, having found the same
  // documents listed in two places: "the top part is about things to do. The bottom part is
  // about history … instead of in two places." So the record page's Documents TAB is gone
  // and this chip is where documents live — which means it has to carry the actual FILES,
  // not just events describing them.
  //
  // `quote_pdf` and `floor_plan` were in this list once as names nothing emitted (removed
  // 2026-08-28 as phantoms). They are back because they are now genuinely emitted, with a
  // url attached. `customer_file` is what the customer sent (migration 151).
  document: ["change_order", "invoice_created", "invoice_sent", "quote_pdf", "floor_plan", "customer_file"],
  deal: ["design_created", "design_version", "accepted", "quote_opened"],
  invoice: ["invoice_created", "invoice_sent"],
  // CHANGELOG MEANS EVERYTHING THAT HAPPENED TO THIS RECORD. Carolyn, 2026-08-26 25:18,
  // describing what the word meant in Pipedrive: "if they changed ownership of a lead from
  // one person to another person, that was logged. Everything that they did with that lead
  // was logged." On her screen it read 0.
  //
  // It read 0 because it filtered on three types, two of which — stage_change and
  // status_change — are emitted NOWHERE in this file. A chip whose vocabulary names events
  // that do not exist cannot show anything, and it fails silently: an empty changelog reads
  // as "nothing has happened here", which on a contact with four documents and two change
  // orders was simply false. Those two phantom names are gone from every list above, along
  // with quote_pdf, invoice_pdf and payment, which were never emitted either.
  //
  // `field_change` is the contact editor's trail (migration 141) — name, phone and email
  // edits, with both values, which is the "changed ownership was logged" half of what she
  // described.
  //
  // ✅ THE OWNER DEBT IS PAID (2026-09-06). This slot used to read: "⚠️ STILL NOT LOGGED:
  // owner and assignee changes, and permission changes. Those columns exist on crm_contacts
  // (owner_user_id, labels) but nothing writes them yet. When an owner picker lands, it owes
  // this list its event — the same debt the editor just paid." It was written when
  // owner_user_id had zero writers, which is what 130 shipped and called "Pipedrive header
  // furniture".
  //
  // It has a writer now — Carolyn, 2026-09-04, 1:09:30: "we do not ever assign deals. We only
  // assign contacts and followers." Migration 188 makes owner_user_id editable and writes a
  // crm_field_changes row for it under field = 'owner'; 189 writes the same row when a quote
  // assigns the rep automatically. Both surface here as `owner_change`, resolved to people's
  // names rather than uuids — see the field-change loop below.
  //
  // ⚠️ STILL NOT LOGGED, and the note stays because the remainder is real: `labels`, and
  // permission changes. Neither has a writer.
  changelog: ["design_created", "design_version", "accepted", "quote_opened",
    "change_order", "invoice_created", "invoice_sent", "lead_captured", "field_change",
    "owner_change"],
} as const;

const iso = (v: unknown): string => (typeof v === "string" ? v : new Date(0).toISOString());
const humanSize = (n: number): string =>
  (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * Build the feed for one record.
 *
 * `codes` is every design short_code in scope: one entry for a design record, all of a
 * contact's designs for a contact record. Every query below is keyed on an existing index.
 */
export async function buildCrmFeed(
  admin: any,
  clientId: string,
  opts: {
    codes: string[]; contactId?: string | null; limit?: number; isAdmin?: boolean;
    /**
     * WHO IS LOOKING, for the calls (review SSB-5). The record page's gate is contacts:view or
     * designs:view and says nothing about the PHONE area, so without this every call on the
     * contact — who placed it, who answered, missed calls, the full voicemail transcript — went
     * to anyone who could open the record. The same rule the phone-api Worker applies to the
     * same rows (routes/calls.ts mayViewCall):
     *   "none" (or absent: fails closed) → no call events at all, and phone_calls is not read;
     *   "own"                            → only calls that are theirs (callVisibleToOwn);
     *   "team"                           → every call on the contact (literal view or edit).
     * `contactOwner` is the contact's owner_user_id, which decides whose a missed call is.
     */
    phone?: { level: "none" | "own" | "team"; userId: string | null; contactOwner?: string | null };
  },
): Promise<FeedEvent[]> {
  const phoneScope = opts.phone?.level ?? "none";
  // A code is hand-joined into a PostgREST `or=` string in three of the reads below, where a
  // comma or a paren is GRAMMAR, not data: one crafted entry closes the `in.(...)` list and
  // appends a clause of the caller's choosing, and `contact_id.not.is.null` widens the read to
  // every conversation in the tenant. That matters because crm_feed takes `codes` straight from
  // the request body behind a gate designs:view alone satisfies, and that branch deliberately
  // IGNORES contactId for a caller without contacts:view - so this is the one thing standing
  // between a designs-only caller and the contact half the branch means to withhold.
  // Dropped rather than escaped: a real code is `SS-` + the look-alike-free alphabet
  // (migration 002), so nothing legitimate is being thrown away. Shape is NOT whitelisted on
  // purpose - a single legacy row that failed to match would silently empty that design's whole
  // feed, which is the failure this file keeps trying to stay out of.
  const codes = (opts.codes || []).filter((c) => c && !/[,()"]/.test(String(c))).slice(0, 200);
  const out: FeedEvent[] = [];
  const push = (e: FeedEvent) => { if (e.at) out.push(e); };

  const q = <T>(p: Promise<T>) => p.then((r: any) => r?.data ?? []).catch(() => []);

  // ⚠️ POSITIONAL DESTRUCTURE — each name means the query at the SAME index below, and
  // nothing checks that. This has now gone wrong TWICE: `texts` was appended to the end of
  // the list while its query went in at slot 11, so `fieldChanges` held sms_messages rows
  // and `f.field` threw a TypeError on every record page that had ever seen a text; then
  // `custFiles` was appended while `crm_files` went in at slot 11, which would have put
  // file rows in `fieldChanges` the same way. Insert the NAME where you insert the PROMISE,
  // and count both lists before you commit.
  //   1 designs        2 design_versions  3 email_sends   4 design_acceptances
  //   5 change_orders  6 invoice_sends    7 captured_leads 8 crm_notes
  //   9 crm_activities 10 email_inbound   11 crm_files    12 sms_messages
  //  13 crm_field_changes                14 phone_calls (+ its voicemail)
  const [designs, versions, emails, accepts, changeOrders, invoices, leads, notes, acts, inbound, custFiles, texts, fieldChanges, calls] = await Promise.all([
    // image_url is the floor-plan PDF the `floor_plan` event below carries. It was missing from
    // this list, so `d.image_url` was always undefined and no floor plan ever reached History.
    codes.length ? q(admin.from("designs").select("short_code, created_at, updated_at, status, selections, ghl_estimate_number, ss_quote_number, ss_quote_pdf_url, ss_quote_sent_at, accepted_at, contact, image_url").in("short_code", codes).eq("client_id", clientId)) : Promise.resolve([]),
    codes.length ? q(admin.from("design_versions").select("short_code, version, created_at, selections").in("short_code", codes).eq("client_id", clientId).order("version", { ascending: false }).limit(120)) : Promise.resolve([]),
    // Email is the conversation channel, so this read has to cover BOTH scopes: document
    // mail keyed on a design, and conversation mail keyed on the person — which often is
    // about no design at all ("are you still thinking about the 12x24?"). An `or` rather
    // than two queries so the 80-row cap applies to the merged history, not twice over.
    //
    // ⚠️ NOT q(), because q() turns ANY read error into []: a crmFeed deployed ahead of
    // migration 261 would be refused body_text (no such column), and every sent email would
    // vanish from every record page with nothing logged. On that one error the read is tried
    // again with fewer columns, newest migration first: without 262's opened_at / open_count /
    // complained_at (the email shows no "Opened" or "Marked as spam"), then without 261's body_text too (no words, so the
    // "Emailed to …" line below). delivered_at and bounced_at are 107's and always there.
    (codes.length || opts.contactId)
      ? (async () => {
          const read = (cols: string) => admin.from("email_sends")
            .select(cols)
            .eq("client_id", clientId)
            .or([
              codes.length ? `short_code.in.(${codes.join(",")})` : null,
              opts.contactId ? `contact_id.eq.${opts.contactId}` : null,
            ].filter(Boolean).join(","))
            .order("created_at", { ascending: false }).limit(80);
          const BASE = "id, short_code, contact_id, kind, to_email, subject, status, created_at, delivered_at, bounced_at";
          let r: any = null;
          for (const cols of [`${BASE}, body_text, opened_at, open_count, complained_at`, `${BASE}, body_text`, BASE]) {
            r = await read(cols);
            if (!(r?.error && ["42703", "PGRST204"].includes(String(r.error.code)))) break;
          }
          return r?.data ?? [];
        })().catch(() => [])
      : Promise.resolve([]),
    codes.length ? q(admin.from("design_acceptances").select("id, short_code, subject, quote_number, signer_name, method, created_at").in("short_code", codes).eq("client_id", clientId)) : Promise.resolve([]),
    codes.length ? q(admin.from("change_orders").select("id, short_code, co_no, status, total_before_cents, total_after_cents, created_at").in("short_code", codes).eq("client_id", clientId)) : Promise.resolve([]),
    codes.length ? q(admin.from("invoice_sends").select("short_code, status, invoice_number, issued_by, updated_at, created_at").in("short_code", codes).eq("client_id", clientId)) : Promise.resolve([]),
    opts.contactId ? q(admin.from("captured_leads").select("id, name, source, created_at").eq("client_id", clientId).eq("contact_id", opts.contactId)) : Promise.resolve([]),
    q(opts.contactId
      ? admin.from("crm_notes").select("id, body, pinned, created_by, created_at, short_code").eq("client_id", clientId).eq("contact_id", opts.contactId).is("deleted_at", null)
      : admin.from("crm_notes").select("id, body, pinned, created_by, created_at, short_code").eq("client_id", clientId).in("short_code", codes).is("deleted_at", null)),
    q(opts.contactId
      ? admin.from("crm_activities").select("id, kind, subject, due_at, done, done_at, created_at, short_code").eq("client_id", clientId).eq("contact_id", opts.contactId)
      : admin.from("crm_activities").select("id, kind, subject, due_at, done, done_at, created_at, short_code").eq("client_id", clientId).in("short_code", codes)),
    // INBOUND — the customer's own words. Same both-scopes `or` as the outbound read: a
    // reply threaded via In-Reply-To carries a short_code, one matched only by sender
    // address carries just the contact.
    (codes.length || opts.contactId)
      ? q(admin.from("email_inbound")
          .select("id, short_code, contact_id, from_email, from_name, subject, body_text, received_at, spam_verdict")
          .eq("client_id", clientId)
          .or([
            codes.length ? `short_code.in.(${codes.join(",")})` : null,
            opts.contactId ? `contact_id.eq.${opts.contactId}` : null,
          ].filter(Boolean).join(","))
          .order("received_at", { ascending: false }).limit(80))
      : Promise.resolve([]),
    // FIELD EDITS (migration 141). Contact-scoped only: a field change is a change to the
    // PERSON, and it belongs on their record whichever design you arrived from. A design
    // record with no contact linked simply has none to show.
    // CUSTOMER UPLOADS (migration 151). Contact-scoped: a file the customer sent belongs to
    // the PERSON, not to whichever quote happened to be open when it arrived.
    opts.contactId
      ? q(admin.from("crm_files")
          .select("id, name, size_bytes, mime, short_code, path, created_at")
          .eq("client_id", clientId).eq("contact_id", opts.contactId).is("deleted_at", null)
          .order("created_at", { ascending: false }).limit(80))
      : Promise.resolve([]),
    // SMS, both directions. Same both-scopes `or` as the email reads: a text sent from a
    // design record carries the code, one that is simply a reply to the person carries only
    // the contact, and an `or` keeps the 80-row cap over the merged history rather than
    // applying it twice.
    (codes.length || opts.contactId)
      ? q(admin.from("sms_messages")
          .select("id, direction, short_code, contact_id, from_number, to_number, body, status, error_code, created_at")
          .eq("client_id", clientId)
          .or([
            codes.length ? `short_code.in.(${codes.join(",")})` : null,
            opts.contactId ? `contact_id.eq.${opts.contactId}` : null,
          ].filter(Boolean).join(","))
          .order("created_at", { ascending: false }).limit(80))
      : Promise.resolve([]),
    // FIELD EDITS (migration 141). Contact-scoped only: a field change is a change to the
    // PERSON, and it belongs on their record whichever design you arrived from. A design
    // record with no contact linked simply has none to show.
    opts.contactId
      ? q(admin.from("crm_field_changes")
          .select("id, field, old_value, new_value, changed_by, created_at")
          .eq("client_id", clientId).eq("contact_id", opts.contactId)
          .order("created_at", { ascending: false }).limit(80))
      : Promise.resolve([]),
    // SLOT 14 — CALLS (My Synergy Phone). Contact-scoped only, like texts' person half: phone_calls is
    // keyed on the contact matched from the caller's number, never on a design, so a design
    // record with no contact linked has no calls to show. The voicemail rides along as an
    // embed (phone_voicemails.call_id is a unique FK), which keeps this one round trip.
    //
    // ⚠️ `q` swallows the error, and that is the right answer here: until migration 254 is
    // applied the table does not exist, and "no calls" is the truth of a tenant that cannot
    // have any. It must never be merged into the sms_messages read above — a missing column
    // there would empty the whole texting history instead.
    // Not read at all for someone with no phone access (opts.phone, review SSB-5).
    //
    // CALL RECORDINGS (migration 263) ride along the same way: phone_call_recordings.call_id is a
    // unique FK too. Only what the line needs: the transcript itself is NOT read here (up to
    // 100,000 characters a call, 80 calls), the portal fetches it from the phone-api Worker on
    // "Show transcript", with the Worker's own visibility rule.
    // ⚠️ NOT q() alone, for the reason the email_sends read above gives: before 263 is applied
    // PostgREST refuses the embed (no such relationship), and q() would turn that into "no calls
    // at all". On that one refusal the read is tried again without it.
    opts.contactId && phoneScope !== "none"
      ? (async () => {
          const read = (embed: string) => admin.from("phone_calls")
            .select(`id, direction, status, from_e164, to_e164, started_at, answered_at, duration_s, placed_by, answered_by, transferred_from, rang_user_ids, phone_voicemails(id, duration_s, transcript, listened_at, deleted_at)${embed}`)
            .eq("client_id", clientId).eq("contact_id", opts.contactId)
            .order("started_at", { ascending: false }).limit(80);
          let r = await read(", phone_call_recordings(id, status, duration_s, summary, transcript_status, deleted_at)");
          if (r?.error && ["PGRST200", "42P01", "42703"].includes(String(r.error.code))) r = await read("");
          return r?.data ?? [];
        })().catch(() => [])
      : Promise.resolve([]),
  ]);

  for (const d of designs as any[]) {
    const sel = d.selections || {};
    const what = [sel.style, sel.size].filter(Boolean).join(" ") || "a design";
    push({ id: `d:${d.short_code}`, type: "design_created", at: iso(d.created_at), title: `Design started — ${what}`, code: d.short_code, icon: "design" });
    if (d.ss_quote_sent_at) push({ id: `qs:${d.short_code}`, type: "email", at: iso(d.ss_quote_sent_at), title: `Estimate ${d.ss_quote_number || ""} sent`.trim(), code: d.short_code, icon: "email" });
    if (d.accepted_at) push({ id: `ac:${d.short_code}`, type: "accepted", at: iso(d.accepted_at), title: "Estimate accepted", code: d.short_code, icon: "accept" });
    // The customer OPENED the estimate. The one genuinely GHL-only signal, and it is here
    // as a stamped column rather than a live API call.
    if (d.ghl_last_visited_at) push({ id: `ov:${d.short_code}`, type: "quote_opened", at: iso(d.ghl_last_visited_at), title: "Customer opened the estimate", code: d.short_code, icon: "eye" });

    // THE DOCUMENTS THEMSELVES, as history rather than as a separate tab (Carolyn
    // 2026-08-26 24:01). These two used to be a list at the TOP of the record page, which
    // is what she meant by "instead of in two places" — the events describing them were
    // already down here while the files were up there.
    //
    // Both are public-bucket URLs (floor-plans), so no signing is needed; the browser opens
    // them in the pop-up viewer. Dated to the design, because a quote PDF has no separate
    // "created" stamp and the design's own date is the honest answer.
    if (d.ss_quote_pdf_url) {
      push({
        id: `qp:${d.short_code}`, type: "quote_pdf", at: iso(d.ss_quote_sent_at || d.created_at),
        title: `Estimate ${d.ss_quote_number || ""}`.trim() + ` — ${what}`,
        code: d.short_code, icon: "doc", url: d.ss_quote_pdf_url,
      });
    }
    if (d.image_url) {
      push({
        id: `fp:${d.short_code}`, type: "floor_plan", at: iso(d.created_at),
        title: `Floor plan — ${what}`, code: d.short_code, icon: "doc", url: d.image_url,
      });
    }
  }

  // WHAT THE CUSTOMER SENT, in the same timeline as what we produced. Private bucket, so
  // the URLs are signed here — one batched call, an hour's life, exactly as crm_record did
  // before this list moved down.
  const fileRows = custFiles as any[];
  if (fileRows.length) {
    let signedByPath = new Map<string, string>();
    try {
      const { data: urls } = await admin.storage.from("customer-uploads")
        .createSignedUrls(fileRows.map((f) => f.path), 3600);
      signedByPath = new Map((urls ?? []).map((u: any) => [u.path, u.signedUrl]));
    } catch (_e) { /* the rows still list, without links — see below */ }
    for (const f of fileRows) {
      push({
        id: `cf:${f.id}`, type: "customer_file", at: iso(f.created_at),
        title: f.name,
        body: f.size_bytes ? humanSize(Number(f.size_bytes)) : null,
        code: f.short_code, icon: "upload",
        // A file whose object has gone is listed WITHOUT a url rather than dropped: that the
        // customer sent something is worth seeing even when the file itself is missing.
        url: signedByPath.get(f.path) ?? null,
        meta: { fileId: f.id, customerFile: true },
      });
    }
  }

  // Versions carry a diff. diffVersionSelections moved server-side with this — including
  // its cladding label map and the whole-row paint comparison, both hard-won — so the
  // browser stops reshaping what the server already knows.
  const byCode: Record<string, any[]> = {};
  for (const v of versions as any[]) (byCode[v.short_code] ||= []).push(v);
  for (const code of Object.keys(byCode)) {
    const list = byCode[code].sort((a, b) => a.version - b.version);
    for (let i = 1; i < list.length; i++) {
      const changed = diffSelections(list[i - 1].selections || {}, list[i].selections || {});
      push({
        id: `v:${code}:${list[i].version}`, type: "design_version", at: iso(list[i].created_at),
        title: `Design edited — version ${list[i].version}`,
        body: changed.length ? changed.join("; ") : null, code, icon: "edit",
      });
    }
  }

  // email_sends is the table that makes the Emails chip REAL. Nothing in the portal reads
  // it today, so every quote and invoice email we have ever sent is invisible in the UI.
  for (const e of emails as any[]) {
    // What happened after it left (migration 262) is a label of its own — Opened, Delivered,
    // Bounced or Marked as spam, in `meta.delivery`, which the record page draws beside the title.
    // So those states no longer ride in the text; a send that is still going out or never went ("claimed",
    // "failed") still says so there, as it always has.
    const delivery = emailDelivery(e);
    const st = e.status && !["sent", "delivered", "bounced"].includes(e.status) ? ` (${e.status})` : "";
    const meta = delivery ? { delivery: delivery.label, openedAt: delivery.openedAt, openCount: delivery.openCount } : null;
    // A conversation reads as the SUBJECT, because that is what someone actually wrote and
    // what they will scan for. A document reads as its kind, because "Quote emailed to
    // jane@…" is the useful line and its subject is boilerplate.
    //
    // ITS BODY IS THE WORDS, once there are any (migration 261 keeps them in body_text), so our
    // side of the conversation reads the way the customer's replies already do. An email from
    // before 261 has none and keeps the old "Emailed to …" line. With the words shown, the
    // status moves up to the title, so a send that failed still says so: a failed email that
    // reads like a sent one is the builder finding out from the customer.
    const words = typeof e.body_text === "string" && e.body_text.trim() ? e.body_text : null;
    push(e.kind === "conversation"
      ? { id: `e:${e.id}`, type: "email", at: iso(e.created_at), title: `${e.subject || "(no subject)"}${words ? st : ""}`, body: words ?? `Emailed to ${e.to_email || "customer"}${st}`, code: e.short_code, icon: "email", meta }
      : { id: `e:${e.id}`, type: "email", at: iso(e.created_at), title: `${labelKind(e.kind)} emailed to ${e.to_email || "customer"}${st}`, body: e.subject || null, code: e.short_code, icon: "email", meta });
  }
  for (const a of accepts as any[]) {
    push({ id: `sig:${a.id}`, type: "accepted", at: iso(a.created_at), title: `${a.subject === "change_order" ? "Change order" : "Estimate"} signed by ${a.signer_name || "customer"}`, body: a.quote_number ? `Estimate ${a.quote_number} · ${a.method}` : a.method, code: a.short_code, icon: "accept" });
  }
  for (const c of changeOrders as any[]) {
    const delta = (Number(c.total_after_cents || 0) - Number(c.total_before_cents || 0)) / 100;
    push({ id: `co:${c.id}`, type: "change_order", at: iso(c.created_at), title: `Change order ${c.co_no || ""} — ${c.status}`.trim(), body: delta ? `${delta > 0 ? "+" : ""}$${delta.toFixed(2)}` : null, code: c.short_code, icon: "doc" });
  }
  for (const i of invoices as any[]) {
    // Preserves the existing "created but never emailed" warning the Designs tab shows.
    push({ id: `inv:${i.short_code}`, type: i.status === "sent" ? "invoice_sent" : "invoice_created", at: iso(i.updated_at || i.created_at), title: `Invoice ${i.invoice_number || ""} ${i.status}`.trim(), body: i.issued_by ? `issued by ${i.issued_by}` : null, code: i.short_code, icon: "invoice" });
  }
  // The ONLY event a browsing contact has. Without it a top-of-funnel record page is blank,
  // which reads as broken rather than as early.
  for (const l of leads as any[]) {
    push({ id: `cl:${l.id}`, type: "lead_captured", at: iso(l.created_at), title: `Enquired on the design page${l.source ? ` (${l.source})` : ""}`, icon: "lead" });
  }
  for (const n of notes as any[]) {
    push({ id: `n:${n.id}`, type: "note", at: iso(n.created_at), title: "Note", body: n.body, code: n.short_code, pinned: !!n.pinned, actor: n.created_by, icon: "note" });
  }
  // A REPLY IS A FIRST-CLASS EVENT, and it renders as the customer's own words. `email_in`
  // rather than `email` so the chip can show a conversation both ways while the Emails
  // filter still catches it -- see CRM_FEED_TYPES.email.
  for (const r of inbound as any[]) {
    push({
      id: `in:${r.id}`, type: "email_in", at: iso(r.received_at),
      title: r.subject || "(no subject)",
      body: r.body_text || null,
      actor: r.from_name || r.from_email,
      code: r.short_code, icon: "email_in",
      // senderVerified carries the RECEIVING side's verdict to the screen. It was stored on
      // every row since migration 135 and read by nothing, so a forged From rendered as the
      // customer's own words with no cue at all — in a card whose whole job is to look like
      // the customer speaking.
      //
      // THREE STATES, and the third is why this is not a boolean. true = the provider said
      // pass; false = it said something else; null = it told us nothing. `senderVerdict()`
      // returns null for "unknown", NEVER for "clean", and the UI must not collapse those:
      // a message we know nothing about is not a message we vouched for.
      //
      // DISPLAY ONLY. Nothing gates on this, deliberately — migration 135's posture is that
      // a customer's words are worth more than our confidence in a spam score, and an
      // earlier attempt to GATE on a sender-supplied header was reverted for being
      // trivially defeated by the sender.
      meta: {
        from: r.from_email,
        inbound: true,
        senderVerified: senderVerifiedFrom(r.spam_verdict),
        senderVerdict: r.spam_verdict ?? null,
      },
    });
  }
  for (const a of acts as any[]) {
    push({ id: `a:${a.id}`, type: "activity", at: iso(a.done ? (a.done_at || a.created_at) : a.created_at), title: `${labelActivity(a.kind)}: ${a.subject}`, body: a.done ? "Completed" : (a.due_at ? `Due ${a.due_at}` : "No due date"), code: a.short_code, meta: { kind: a.kind, done: !!a.done, dueAt: a.due_at, id: a.id }, icon: a.kind });
  }
  // SMS, both directions. Outbound carries its delivery state in the title when it is
  // anything other than a clean send: a text that silently failed looks identical to one
  // that arrived, and the builder finds out from the customer.
  for (const t of texts as any[]) {
    const out = t.direction === "out";
    const num = out ? t.to_number : t.from_number;
    const st = String(t.status ?? "");
    // 'sent' means handed to the carrier; 'delivered' is the receipt. Neither is worth
    // saying out loud. The other three are.
    const suffix = out && st && st !== "sent" && st !== "delivered"
      ? ` — ${st}${t.error_code ? ` (carrier code ${t.error_code})` : ""}`
      : "";
    push({
      id: `sm:${t.id}`,
      type: out ? "sms" : "sms_in",
      at: iso(t.created_at),
      title: out ? `Text to ${num}${suffix}` : `Text from ${num}`,
      body: t.body || null,
      // Inbound is the customer speaking, so it gets an actor and renders as their words —
      // the same treatment email_in gets.
      ...(out ? {} : { actor: num }),
      code: t.short_code,
      icon: out ? "sms" : "sms_in",
      meta: { direction: t.direction, status: st || null },
    });
  }
  // FIELD EDITS — the half of "everything that they did with that lead was logged" that had
  // nothing to log until there was an editor (migration 141).
  //
  // Both values are shown. A changelog that says only "phone changed" answers none of the
  // questions someone opens a changelog to ask; the old value is the whole point when the
  // edit was a correction, and it is the only record of what the number used to be.
  //
  // Two of the field names are not fields in the sense the generic line means, and each gets
  // its own shape below. Everything else renders exactly as it always has.
  //
  // OWNER: stored as two uuids, because that is what the column holds and a changelog that
  // stores a resolved name is a changelog that lies the day somebody is renamed. Resolved to
  // people HERE — one batched read of client_users, only when an owner row exists to resolve,
  // because "0f3c… → 8a12…" is not an answer. A uuid with no client_users row is somebody who
  // has since left the tenant; a row with no full_name is one of the users who predate
  // migration 060. Those are different facts and the line says which.
  const ownerRows = (fieldChanges as any[]).filter((f) => f.field === "owner");
  // Scoped to what this viewer may see of the phone (opts.phone) BEFORE anything is read or
  // rendered from them, so a hidden call's people are not even looked up.
  const callRows = scopeCallRows(calls as any[], opts.phone);
  const knownUsers = new Set<string>();
  const nameByUser = new Map<string, string>();
  // ONE read of client_users for every person this feed names: owners on either side of an
  // owner change, and whoever placed or answered a call. Made only when there is someone to
  // resolve, so a record with neither costs nothing extra.
  const peopleIds = Array.from(new Set(
    [
      ...ownerRows.flatMap((f) => [f.old_value, f.new_value]),
      ...callRows.flatMap((c) => [c.placed_by, c.answered_by]),
    ].filter((v: unknown): v is string => typeof v === "string" && !!v),
  ));
  if (peopleIds.length) {
    const users = await q(admin.from("client_users").select("user_id, full_name").in("user_id", peopleIds));
    for (const u of users as any[]) {
      knownUsers.add(u.user_id);
      if (u.full_name) nameByUser.set(u.user_id, u.full_name);
    }
  }
  const whoIs = (v: string | null): string =>
    !v ? "Unassigned"
      : nameByUser.get(v) ?? (knownUsers.has(v) ? "a team member" : "a former team member");

  for (const f of fieldChanges as any[]) {
    if (f.field === "owner") {
      push({
        id: `fc:${f.id}`, type: "owner_change", at: iso(f.created_at),
        title: "Owner changed",
        body: `${whoIs(f.old_value)} → ${whoIs(f.new_value)}`,
        actor: f.changed_by, icon: "edit",
        meta: { field: "owner", from: f.old_value, to: f.new_value },
      });
      continue;
    }
    // MERGE (migration 192). old_value is the folded-in contact's label, new_value its id.
    // Kept as a `field_change` rather than given a type of its own, deliberately: the type
    // vocabulary is duplicated in portal/02-sales.jsx's CRM_CHIPS and the two must stay
    // identical, so a new name there is a change in two files. This one has nothing a chip
    // would filter on that `changelog` does not already cover.
    if (f.field === "merged_from") {
      push({
        id: `fc:${f.id}`, type: "field_change", at: iso(f.created_at),
        title: "Contact merged in",
        body: `${f.old_value || "Another contact"} was merged into this record`,
        actor: f.changed_by, icon: "edit",
        meta: { field: "merged_from", mergedFrom: f.new_value },
      });
      continue;
    }
    const from = f.old_value ? `"${f.old_value}"` : "(empty)";
    const to = f.new_value ? `"${f.new_value}"` : "(empty)";
    // Underscores become spaces: migration 188's second address logs as `billing_street`,
    // and "Billing_street changed" reads like a leaked column name.
    const label = String(f.field).replace(/_/g, " ");
    push({
      id: `fc:${f.id}`, type: "field_change", at: iso(f.created_at),
      title: `${label.charAt(0).toUpperCase()}${label.slice(1)} changed`,
      body: `${from} → ${to}`,
      actor: f.changed_by, icon: "edit",
      meta: { field: f.field },
    });
  }

  // CALLS. Rendered by a pure function (below) so the wording is unit-tested; the names are
  // the same resolution the owner-change lines use. A person with no client_users row any more
  // is "a former team member", the same fact the owner line states.
  const callerName = (v: string) =>
    nameByUser.get(v) ?? (knownUsers.has(v) ? "a team member" : "a former team member");
  for (const e of callFeedEvents(callRows, callerName)) push(e);

  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, opts.limit || 200);
}

/**
 * What happened to one email after it left (Resend's events, recorded by migration 262's
 * record_email_event), as the label the record page shows beside it. Pure — exported for the tests.
 *   complained_at set                               → "Marked as spam" (262 keeps a complaint
 *                                                     there, NOT as a bounce: the email arrived)
 *   bounced                                         → "Bounced"
 *   opened at least once                            → "Opened", with the first time and the count
 *   delivered                                       → "Delivered"
 *   anything else                                   → null (sent, still sending, or failed:
 *                                                     the title says those)
 * A complaint outranks everything: it is the one thing the builder must act on (don't email them
 * again). It is NOT a bounce, though: the email arrived (often it was opened first), so "Bounced,
 * check the address and send again" would be false, and sending again to someone who just reported
 * them is what hurts their sending domain most. A bounce outranks an open: an open recorded before a
 * late bounce does not make the bounce any less the thing to act on. An open outranks a delivery
 * whatever the status says, because a delivery receipt can go missing while the open still arrives.
 *
 * Opens are approximate: some mail apps block the tracking image, and some open mail by
 * themselves. The record page says so where the label is shown.
 */
// deno-lint-ignore no-explicit-any
export function emailDelivery(e: any): { label: "Opened" | "Delivered" | "Bounced" | "Marked as spam"; openedAt: string | null; openCount: number } | null {
  if (!e) return null;
  const openedAt = typeof e.opened_at === "string" && e.opened_at ? e.opened_at : null;
  const openCount = Math.max(Number(e.open_count) || 0, openedAt ? 1 : 0);
  if (typeof e.complained_at === "string" && e.complained_at) return { label: "Marked as spam", openedAt, openCount };
  if (e.status === "bounced") return { label: "Bounced", openedAt, openCount };
  if (openedAt) return { label: "Opened", openedAt, openCount };
  if (e.status === "delivered" || (e.delivered_at && e.status !== "failed" && e.status !== "claimed")) {
    return { label: "Delivered", openedAt: null, openCount: 0 };
  }
  return null;
}

/**
 * The receiving side's verdict on an inbound email (email_inbound.spam_verdict), as the three
 * states the screen shows: true = every check it reported passed; false = one did not; null = it
 * told us nothing we can read. See the email_in loop above for why null is not true.
 *
 * Exported for the phone-api Worker's email thread (workers/phone-api/src/emailThread.ts), so the
 * phone and the portal can never disagree about a reply. The Worker can import it only because
 * this file imports nothing: keep this function pure.
 *
 * TOKENISED, not one regex with a word boundary. The first version wrote a word-boundary escape
 * into this file through a script and got a literal 0x08 BACKSPACE byte instead, so the lookahead
 * could never match, the test always passed, and senderVerified was always false - every reply
 * would have worn the NOT VERIFIED chip, which is precisely the badge-fatigue this design set out
 * to avoid. Nothing threw; the unit test passed because it exercised a retyped copy of the regex
 * rather than this file.
 *
 * No parseable token means UNKNOWN, not verified: a verdict string we cannot read is not a
 * verdict we may vouch for.
 */
export function senderVerifiedFrom(verdict: unknown): boolean | null {
  if (verdict == null) return null;
  const toks = String(verdict).toLowerCase()
    .match(/(?:spam|virus|spf|dkim|dmarc)=[a-z0-9_-]+/g);
  if (!toks || !toks.length) return null;
  return toks.every((t) => t.endsWith("=pass"));
}

/**
 * Is this call one a phone:'own' person may see? The phone-api Worker's rule for the same rows,
 * restated (workers/phone-api/src/scope.ts callIsMine, plus routes/calls.ts mayViewCall's
 * transferred_from clause) because the Worker is a separate deploy:
 *   placed it or answered it                                  → yes
 *   handed it on (transferred_from)                           → yes
 *   unanswered (missed / voicemail / ringing): the contact's owner when it has one, otherwise
 *   everyone the number rang                                  → yes
 *   anything else                                             → no
 * Keep the two identical: a voicemail shown here that the Worker then refuses plays nothing.
 */
// deno-lint-ignore no-explicit-any
export function callVisibleToOwn(userId: string | null, c: any, contactOwner: string | null): boolean {
  if (!userId || !c) return false;
  if (c.placed_by === userId || c.answered_by === userId || c.transferred_from === userId) return true;
  const status = String(c.status ?? "");
  if (status !== "missed" && status !== "voicemail" && status !== "ringing") return false;
  if (contactOwner) return contactOwner === userId;
  return Array.isArray(c.rang_user_ids) && c.rang_user_ids.includes(userId);
}

/** The phone_calls rows this viewer may see (buildCrmFeed's opts.phone). Fails closed: no scope
 *  given is "none". */
// deno-lint-ignore no-explicit-any
export function scopeCallRows(rows: any[], phone?: { level: "none" | "own" | "team"; userId: string | null; contactOwner?: string | null }): any[] {
  const level = phone?.level ?? "none";
  if (level === "team") return rows || [];
  if (level !== "own") return [];
  return (rows || []).filter((c) => callVisibleToOwn(phone?.userId ?? null, c, phone?.contactOwner ?? null));
}

/** 42 → "42s", 192 → "3m 12s", 3720 → "1h 2m". A call length, as a person says it. */
export function fmtCallLength(seconds: unknown): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${m}m`;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/**
 * A call's recording (its phone_call_recordings embed, migration 263) → what the timeline line
 * shows and offers. Null when the call has none (or the embed was not read, before 263).
 *   recordingId     the recording, while its audio exists (null once retention deleted it)
 *   recordingReady  Twilio has finished it: the portal offers Play (GET /recordings/:id/audio)
 *   recordingState  live | paused | processing | ready | failed, the phone-api Worker's words
 *                   (routes/reads.ts recordingOut), so the portal and the apps say the same thing
 *   summary         2-4 sentences and action items; KEPT after the audio is deleted
 *   hasTranscript   the portal may offer "Show transcript" (fetched from the Worker on the press)
 *   transcriptPending  the transcript and summary are still being made
 */
// deno-lint-ignore no-explicit-any
export function recordingMeta(c: any): Record<string, unknown> | null {
  const r = Array.isArray(c?.phone_call_recordings) ? (c.phone_call_recordings[0] ?? null) : (c?.phone_call_recordings ?? null);
  if (!r || !r.id) return null;
  const gone = !!r.deleted_at;
  const status = String(r.status ?? "");
  const live = String(c?.status ?? "") === "ringing" || String(c?.status ?? "") === "in_progress";
  const state = status === "completed" ? "ready"
    : status === "failed" || status === "absent" ? "failed"
    : !live ? "processing"
    : status === "paused" ? "paused" : "live";
  const ts = String(r.transcript_status ?? "");
  const summary = typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : null;
  return {
    recordingId: gone ? null : r.id,
    recordingReady: !gone && status === "completed",
    recordingState: gone ? null : state,
    recordingDurationS: !gone && Number(r.duration_s) > 0 ? Number(r.duration_s) : null,
    recordingDeleted: gone,
    summary,
    hasTranscript: !gone && ts === "done",
    transcriptPending: !gone && (ts === "pending" || ts === "working"),
  };
}

/**
 * phone_calls rows (with their phone_voicemails embed) → timeline events.
 *
 * WHICH TYPE, in this order (plan section 7's outcomes, from the customer's side of the line):
 *   outbound, any outcome          → `call`. The builder placed it; "no answer" is how it went,
 *                                    not a missed call — a MISSED call is one the customer made.
 *   inbound, somebody answered     → `call` — unless a message was left on it after all (a
 *                                    transfer nobody took), which is the `voicemail` line below.
 *   inbound, still ringing/on-line → `call`, said as such (the feed can be opened mid-call).
 *   inbound, a message was left    → `voicemail` (the embed, or status 'voicemail').
 *   inbound, anything else         → `call_missed`.
 *
 * The number is shown as the stored E.164, the same way the texting lines show theirs.
 */
// deno-lint-ignore no-explicit-any
export function callFeedEvents(rows: any[], nameOf: (userId: string) => string): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const c of rows || []) {
    if (!c || !c.id) continue;
    // PostgREST embeds a one-to-one as an object and a one-to-many as an array; call_id is
    // UNIQUE, so it should be the object, and either shape is accepted rather than trusted.
    const vm = Array.isArray(c.phone_voicemails) ? (c.phone_voicemails[0] ?? null) : (c.phone_voicemails ?? null);
    const status = String(c.status ?? "");
    const live = status === "ringing" || status === "in_progress";
    const dur = Number(c.duration_s) || 0;
    const base = {
      id: `pc:${c.id}`,
      at: iso(c.started_at),
      meta: {
        callId: c.id, direction: c.direction, status: status || null, durationS: dur || null,
        voicemailId: vm?.id ?? null, listened: !!vm?.listened_at,
        // The portal plays a voicemail from the Worker (/voicemails/:id/audio) only while the
        // recording still exists at Twilio; a deleted one keeps its line but has nothing to play.
        voicemailDeleted: !!vm?.deleted_at,
        // The call's own recording, its summary and whether there is a transcript (migration
        // 263, recordingMeta above). Absent on a call that was not recorded.
        ...(recordingMeta(c) ?? {}),
      } as Record<string, unknown>,
    };
    if (c.direction === "out") {
      const num = c.to_e164 || "an unknown number";
      const outcome = live ? "In progress"
        : c.answered_at && dur > 0 ? `Talked ${fmtCallLength(dur)}`
        : status === "busy" ? "Busy"
        : status === "failed" ? "Didn't connect"
        : "No answer";
      const by = c.placed_by ? `by ${nameOf(c.placed_by)}` : null;
      out.push({ ...base, type: "call", icon: "call", title: `Call to ${num}`, body: [outcome, by].filter(Boolean).join(" · "), actor: c.placed_by ?? null });
      continue;
    }
    const num = c.from_e164 || "an unknown number";
    // A MESSAGE LEFT IS THE LINE, even on a call that was answered first: a cold transfer nobody
    // took goes to the builder's voicemail on the SAME call, which the Worker keeps answered
    // (fileVoicemail). Read as "Answered", the message had no player and no transcript here,
    // while the apps show it (reads.ts callSummary carries the voicemail whatever the status).
    if ((c.answered_by || (c.answered_at && !live)) && !vm) {
      const who = c.answered_by ? `Answered by ${nameOf(c.answered_by)}` : "Answered";
      out.push({ ...base, type: "call", icon: "call", title: `Call from ${num}`, body: dur > 0 ? `${who} · talked ${fmtCallLength(dur)}` : who, actor: c.answered_by ?? null });
    } else if (live) {
      out.push({ ...base, type: "call", icon: "call", title: `Call from ${num}`, body: status === "ringing" ? "Ringing" : "On the line now" });
    } else if (vm || status === "voicemail") {
      const len = vm && Number(vm.duration_s) > 0 ? `${fmtCallLength(vm.duration_s)} message` : "Left a message";
      const body = vm?.deleted_at ? "The message was deleted."
        : vm?.transcript ? String(vm.transcript)
        : `${len}${vm && !vm.listened_at ? " · not listened to yet" : ""}`;
      out.push({ ...base, type: "voicemail", icon: "voicemail", title: `Voicemail from ${num}`, body });
    } else {
      out.push({ ...base, type: "call_missed", icon: "call_missed", title: `Missed call from ${num}`, body: "Nobody answered" });
    }
  }
  return out;
}

function labelKind(k: string): string {
  return k === "estimate" ? "Estimate" : k === "invoice" ? "Invoice"
    : k === "acceptance" ? "Acceptance receipt" : k === "change_order" ? "Change order"
    : k === "test" ? "Test email" : "Email";
}
function labelActivity(k: string): string {
  return k === "call" ? "Call" : k === "meeting" ? "Meeting" : k === "task" ? "Task"
    : k === "deadline" ? "Deadline" : k === "lunch" ? "Lunch" : "Email";
}

// Moved verbatim in spirit from portal/02-sales.jsx's diffVersionSelections. It lives here
// now so the browser is not re-deriving on every render what the server already assembled.
// The built-in names (D3_CLADDING); lap's became 7" LP Lap Siding and vinyl joined on 2026-10-06.
const CLADDING_LABELS: Record<string, string> = {
  panel: "Panel Siding", lap: '7" LP Lap Siding', vinyl: '4.5" Vinyl Siding', batten: "Board & Batten", agpanel: "AG Panel",
};
// The metal roof profile, a design's own pick since 2026-10-06 (roofProfile.ts). Without these a
// switch read as the raw ids, "roofProfile: agpanel → standingseam".
const ROOF_PROFILE_LABELS: Record<string, string> = { agpanel: "AG Panel", standingseam: "Standing Seam" };
function diffSelections(a: Record<string, any>, b: Record<string, any>): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const av = a?.[k], bv = b?.[k];
    if (String(av ?? "") === String(bv ?? "")) continue;
    const labels = k === "cladding" ? CLADDING_LABELS : k === "roofProfile" ? ROOF_PROFILE_LABELS : null;
    const pretty = (v: any) => (labels ? (labels[String(v)] || String(v || "—")) : String(v || "—"));
    out.push(`${k}: ${pretty(av)} → ${pretty(bv)}`);
  }
  return out.slice(0, 8);
}
