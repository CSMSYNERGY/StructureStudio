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
  opts: { codes: string[]; contactId?: string | null; limit?: number; isAdmin?: boolean },
): Promise<FeedEvent[]> {
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
  //  13 crm_field_changes
  const [designs, versions, emails, accepts, changeOrders, invoices, leads, notes, acts, inbound, custFiles, texts, fieldChanges] = await Promise.all([
    codes.length ? q(admin.from("designs").select("short_code, created_at, updated_at, status, selections, ghl_estimate_number, ss_quote_number, ss_quote_pdf_url, ss_quote_sent_at, accepted_at, contact").in("short_code", codes).eq("client_id", clientId)) : Promise.resolve([]),
    codes.length ? q(admin.from("design_versions").select("short_code, version, created_at, selections").in("short_code", codes).eq("client_id", clientId).order("version", { ascending: false }).limit(120)) : Promise.resolve([]),
    // Email is the conversation channel, so this read has to cover BOTH scopes: document
    // mail keyed on a design, and conversation mail keyed on the person — which often is
    // about no design at all ("are you still thinking about the 12x24?"). An `or` rather
    // than two queries so the 80-row cap applies to the merged history, not twice over.
    (codes.length || opts.contactId)
      ? q(admin.from("email_sends")
          .select("id, short_code, contact_id, kind, to_email, subject, status, created_at")
          .eq("client_id", clientId)
          .or([
            codes.length ? `short_code.in.(${codes.join(",")})` : null,
            opts.contactId ? `contact_id.eq.${opts.contactId}` : null,
          ].filter(Boolean).join(","))
          .order("created_at", { ascending: false }).limit(80))
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
  ]);

  for (const d of designs as any[]) {
    const sel = d.selections || {};
    const what = [sel.style, sel.size].filter(Boolean).join(" ") || "a design";
    push({ id: `d:${d.short_code}`, type: "design_created", at: iso(d.created_at), title: `Design started — ${what}`, code: d.short_code, icon: "design" });
    if (d.ss_quote_sent_at) push({ id: `qs:${d.short_code}`, type: "email", at: iso(d.ss_quote_sent_at), title: `Quote ${d.ss_quote_number || ""} sent`.trim(), code: d.short_code, icon: "email" });
    if (d.accepted_at) push({ id: `ac:${d.short_code}`, type: "accepted", at: iso(d.accepted_at), title: "Quote accepted", code: d.short_code, icon: "accept" });
    // The customer OPENED the estimate. The one genuinely GHL-only signal, and it is here
    // as a stamped column rather than a live API call.
    if (d.ghl_last_visited_at) push({ id: `ov:${d.short_code}`, type: "quote_opened", at: iso(d.ghl_last_visited_at), title: "Customer opened the quote", code: d.short_code, icon: "eye" });

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
        title: `Quote ${d.ss_quote_number || ""}`.trim() + ` — ${what}`,
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
    const st = e.status && e.status !== "sent" ? ` (${e.status})` : "";
    // A conversation reads as the SUBJECT, because that is what someone actually wrote and
    // what they will scan for. A document reads as its kind, because "Quote emailed to
    // jane@…" is the useful line and its subject is boilerplate.
    push(e.kind === "conversation"
      ? { id: `e:${e.id}`, type: "email", at: iso(e.created_at), title: e.subject || "(no subject)", body: `Emailed to ${e.to_email || "customer"}${st}`, code: e.short_code, icon: "email" }
      : { id: `e:${e.id}`, type: "email", at: iso(e.created_at), title: `${labelKind(e.kind)} emailed to ${e.to_email || "customer"}${st}`, body: e.subject || null, code: e.short_code, icon: "email" });
  }
  for (const a of accepts as any[]) {
    push({ id: `sig:${a.id}`, type: "accepted", at: iso(a.created_at), title: `${a.subject === "change_order" ? "Change order" : "Quote"} signed by ${a.signer_name || "customer"}`, body: a.quote_number ? `Quote ${a.quote_number} · ${a.method}` : a.method, code: a.short_code, icon: "accept" });
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
        // TOKENISED, not one regex with a word boundary. The first version wrote `\b` into
        // this file through a script and got a literal 0x08 BACKSPACE byte instead, so the
        // lookahead could never match, the test always passed, and senderVerified was always
        // false - every reply would have worn the NOT VERIFIED chip, which is precisely the
        // badge-fatigue this design set out to avoid. Nothing threw; the unit test passed
        // because it exercised a retyped copy of the regex rather than this file.
        //
        // No parseable token means UNKNOWN, not verified: a verdict string we cannot read is
        // not a verdict we may vouch for.
        senderVerified: (() => {
          if (r.spam_verdict == null) return null;
          const toks = String(r.spam_verdict).toLowerCase()
            .match(/(?:spam|virus|spf|dkim|dmarc)=[a-z0-9_-]+/g);
          if (!toks || !toks.length) return null;
          return toks.every((t) => t.endsWith("=pass"));
        })(),
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
  const knownUsers = new Set<string>();
  const nameByUser = new Map<string, string>();
  if (ownerRows.length) {
    const ids = Array.from(new Set(
      ownerRows.flatMap((f) => [f.old_value, f.new_value])
        .filter((v: unknown): v is string => typeof v === "string" && !!v),
    ));
    if (ids.length) {
      const users = await q(admin.from("client_users").select("user_id, full_name").in("user_id", ids));
      for (const u of users as any[]) {
        knownUsers.add(u.user_id);
        if (u.full_name) nameByUser.set(u.user_id, u.full_name);
      }
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

  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, opts.limit || 200);
}

function labelKind(k: string): string {
  return k === "estimate" ? "Quote" : k === "invoice" ? "Invoice"
    : k === "acceptance" ? "Acceptance receipt" : k === "change_order" ? "Change order"
    : k === "test" ? "Test email" : "Email";
}
function labelActivity(k: string): string {
  return k === "call" ? "Call" : k === "meeting" ? "Meeting" : k === "task" ? "Task"
    : k === "deadline" ? "Deadline" : k === "lunch" ? "Lunch" : "Email";
}

// Moved verbatim in spirit from portal/02-sales.jsx's diffVersionSelections. It lives here
// now so the browser is not re-deriving on every render what the server already assembled.
const CLADDING_LABELS: Record<string, string> = {
  panel: "Panel Siding", lap: "Lap Siding", batten: "Board & Batten", agpanel: "Metal",
};
function diffSelections(a: Record<string, any>, b: Record<string, any>): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const av = a?.[k], bv = b?.[k];
    if (String(av ?? "") === String(bv ?? "")) continue;
    const pretty = (v: any) => (k === "cladding" ? (CLADDING_LABELS[String(v)] || String(v || "—")) : String(v || "—"));
    out.push(`${k}: ${pretty(av)} → ${pretty(bv)}`);
  }
  return out.slice(0, 8);
}
