// Admin → Master Catalog → Library and Library requests (migration 339; plan §1 step 6): CSM edits the
// StructureStudio library every builder copies from, and works the queue of builders' requests.
//
// Operator-only, by admin-catalog's gate (checkAdminAuth: an operator JWT or the break-glass password;
// a support operator and a builder are refused there). The two reads are on READ_ONLY_ACTIONS; every
// write needs can_write, and library_request_refund moves money, so it is on the can_bill grant too.
//
// COPY ON WRITE (Ahsan 2026-10-27). Editing a template here never touches a builder's entry: their
// entries are copies (client_library). `version` is bumped on every edit so a builder's copy can later
// say it was made from an older one. Archiving hides a template from new picks; copies stay.
//
// PROMOTING a builder's entry into this library is NOT here (Ahsan 2026-10-27: not in v1).

import { type Category, cleanLook, cleanName, isLibraryId, type Look, templateOut } from "../_shared/libraryLook.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
type Identity = { via: string; userId?: string; email?: string };
type Json = (b: unknown, s?: number) => Response;

const CATEGORIES: readonly Category[] = ["cladding", "door", "window"];
const REQUEST_STATUSES = ["submitted", "in_progress", "done", "refused", "cancelled"];
const TEMPLATE_COLS = "id, category, slug, name, description, search_terms, look, recolourable, leaves, thumb_url, status, version, source, sort_order, updated_at";
const REQUEST_COLS = "id, client_id, category, status, name, width_in, height_in, leaves, photos, supplier_url, notes, charged_cents, refunded_cents, refund_reason, result_library_item_id, result_client_library_id, result_note, requested_by, decided_at, created_at, updated_at";
const missing = (err: unknown) => ["42703", "42P01", "PGRST204", "PGRST205"].includes(String((err as { code?: string } | null)?.code ?? ""));
const NOT_APPLIED = { error: "Migration 339 isn't applied on this database yet.", code: "library_unavailable" };

async function auditRow(sb: Db, identity: Identity, action: string, clientId: string | null, note: string) {
  try {
    await sb.from("admin_audit").insert({
      action, target_client_id: clientId,
      actor_email: identity.via === "operator" ? identity.email ?? null : null,
      actor_user_id: identity.via === "operator" ? identity.userId ?? null : null,
      note: `via=${identity.via} ${note}`.slice(0, 500),
    });
  } catch (_e) { /* best-effort */ }
}

/** The search words: trimmed, de-duplicated (ignoring case), at most 40 of at most 40 characters. */
function cleanTerms(raw: unknown): string[] {
  const src = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of src) {
    const s = String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= 40) break;
  }
  return out;
}

export async function handleAdminLibraryAction(sb: Db, action: string, p: Record<string, unknown>, identity: Identity, json: Json): Promise<Response> {
  // ── The StructureStudio library ────────────────────────────────────────────────────────────
  if (action === "library_items_list") {
    const [items, copies] = await Promise.all([
      sb.from("library_items").select(TEMPLATE_COLS).order("category").order("sort_order").order("name"),
      sb.from("client_library").select("library_item_id"),
    ]);
    if (items.error && missing(items.error)) return json({ ok: true, installed: false, items: [] });
    if (items.error) throw items.error;
    if (copies.error) throw copies.error;
    const n = new Map<string, number>();
    for (const r of (copies.data ?? []) as { library_item_id: string | null }[]) if (r.library_item_id) n.set(r.library_item_id, (n.get(r.library_item_id) ?? 0) + 1);
    // deno-lint-ignore no-explicit-any
    return json({ ok: true, installed: true, items: ((items.data ?? []) as any[]).map((r) => ({ ...templateOut(r), source: r.source, updatedAt: r.updated_at, copies: n.get(r.id) ?? 0 })) });
  }

  if (action === "library_item_save") {
    const id = p.id == null || p.id === "" ? null : String(p.id).toLowerCase();
    if (id !== null && !isLibraryId(id)) return json({ error: "No such template." }, 404);
    const cur = id ? await sb.from("library_items").select(TEMPLATE_COLS).eq("id", id).maybeSingle() : { data: null, error: null };
    if (cur.error && missing(cur.error)) return json(NOT_APPLIED, 503);
    if (cur.error) throw cur.error;
    if (id && !cur.data) return json({ error: "No such template." }, 404);
    const category = (cur.data?.category ?? String(p.category ?? "")) as Category;
    if (!CATEGORIES.includes(category)) return json({ error: "category must be cladding, door or window." }, 400);
    if (cur.data && p.category !== undefined && p.category !== cur.data.category) return json({ error: "A template's category cannot change." }, 400);
    const row: Record<string, unknown> = {};
    if (!cur.data || p.name !== undefined) {
      const name = cleanName(p.name, 80);
      if (!name) return json({ error: "Name it (1 to 80 characters)." }, 400);
      row.name = name;
    }
    if (!cur.data || p.slug !== undefined) {
      const slug = String(p.slug ?? row.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) return json({ error: "The slug needs letters or numbers." }, 400);
      row.slug = slug;
    }
    if (!cur.data || p.look !== undefined) {
      const look: Look | null = cleanLook(category, p.look ?? {});
      if (!look) return json({ error: "That look isn't valid for this kind of template." }, 400);
      if (cur.data && category === "cladding" && look.profile !== (cur.data.look as Look).profile) {
        return json({ error: "A cladding template keeps its profile: builders' style rows are drawn by it. Add a new template instead." }, 400);
      }
      row.look = look;
    }
    if (p.description !== undefined) {
      const d = String(p.description ?? "").trim();
      if (d.length > 600) return json({ error: "The description is 600 characters at most." }, 400);
      row.description = d || null;
    }
    if (p.searchTerms !== undefined) row.search_terms = cleanTerms(p.searchTerms);
    if (p.recolourable !== undefined) row.recolourable = p.recolourable !== false;
    if (p.leaves !== undefined) {
      const l = p.leaves == null || p.leaves === "" ? null : Number(p.leaves);
      if (l !== null && l !== 1 && l !== 2) return json({ error: "Leaves is 1, 2 or blank." }, 400);
      row.leaves = l;
    }
    if (p.thumbUrl !== undefined) {
      const u = String(p.thumbUrl ?? "").trim();
      if (u && (!/^https:\/\/\S+$/.test(u) || u.length > 500)) return json({ error: "The picture must be an https address." }, 400);
      row.thumb_url = u || null;
    }
    if (p.sortOrder !== undefined) {
      const s = Number(p.sortOrder);
      if (!Number.isInteger(s)) return json({ error: "sortOrder must be a whole number." }, 400);
      row.sort_order = s;
    }
    if (p.status !== undefined) {
      if (p.status !== "active" && p.status !== "archived") return json({ error: "status must be active or archived." }, 400);
      row.status = p.status;
    }
    const now = new Date().toISOString();
    let res;
    if (cur.data) {
      if (!Object.keys(row).length) return json({ ok: true, item: templateOut(cur.data) });
      // Every edit is a new version (archiving included), so a copy can tell how old its template is.
      res = await sb.from("library_items").update({ ...row, version: Number(cur.data.version ?? 1) + 1, updated_at: now })
        .eq("id", id).select(TEMPLATE_COLS).single();
    } else {
      res = await sb.from("library_items").insert({ category, source: "csm", ...row, updated_at: now }).select(TEMPLATE_COLS).single();
    }
    if (res.error && missing(res.error)) return json(NOT_APPLIED, 503);
    if (res.error && String(res.error.code ?? "") === "23505") return json({ error: `There is already a ${category} template with that slug.` }, 409);
    if (res.error) throw res.error;
    await auditRow(sb, identity, "library_item_save", null, `item=${res.data.id} ${cur.data ? "edit" : "add"} fields=${Object.keys(row).join(",")}`);
    return json({ ok: true, item: templateOut(res.data) });
  }

  if (action === "library_items_reorder") {
    const category = String(p.category ?? "") as Category;
    if (!CATEGORIES.includes(category)) return json({ error: "category must be cladding, door or window." }, 400);
    const ids = Array.isArray(p.orderedIds) ? p.orderedIds.map((x) => String(x).toLowerCase()).filter(isLibraryId) : [];
    if (!ids.length || ids.length > 500) return json({ error: "orderedIds[] required." }, 400);
    for (let i = 0; i < ids.length; i++) {
      const { error } = await sb.from("library_items").update({ sort_order: (i + 1) * 10 }).eq("id", ids[i]).eq("category", category);
      if (error && missing(error)) return json(NOT_APPLIED, 503);
      if (error) throw error;
    }
    await auditRow(sb, identity, "library_items_reorder", null, `category=${category} n=${ids.length}`);
    return json({ ok: true });
  }

  // ── The request queue (every builder's) ────────────────────────────────────────────────────
  if (action === "library_requests_list") {
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const [open, closed, names] = await Promise.all([
      sb.from("library_requests").select(REQUEST_COLS).in("status", ["submitted", "in_progress", "generating", "review", "ready"]).order("created_at", { ascending: true }).limit(200),
      sb.from("library_requests").select(REQUEST_COLS).in("status", ["done", "refused", "failed", "cancelled"]).gte("updated_at", since).order("updated_at", { ascending: false }).limit(100),
      sb.from("client_configs").select("client_id, company_name"),
    ]);
    if (open.error && missing(open.error)) return json({ ok: true, installed: false, requests: [] });
    if (open.error) throw open.error;
    if (closed.error) throw closed.error;
    const nameOf = new Map(((names.data ?? []) as { client_id: string; company_name: string | null }[]).map((c) => [String(c.client_id), c.company_name ?? null]));
    // Photos are private: a one-hour signed link each, made here, so the console never holds a key.
    // deno-lint-ignore no-explicit-any
    const view = async (r: any) => {
      const photos: { role: string; url: string | null }[] = [];
      for (const ph of (Array.isArray(r.photos) ? r.photos : []).slice(0, 4)) {
        const path = String(ph?.path ?? "");
        // Only this request's own builder's folder, by exact shape (the path was minted for it).
        if (!path.startsWith(`${r.client_id}/requests/`) || path.includes("..")) { photos.push({ role: String(ph?.role ?? "front"), url: null }); continue; }
        const s = await sb.storage.from("library-refs").createSignedUrl(path, 3600).catch(() => ({ data: null }));
        photos.push({ role: String(ph?.role ?? "front"), url: s?.data?.signedUrl ?? null });
      }
      return {
        id: r.id, clientId: r.client_id, companyName: nameOf.get(String(r.client_id)) ?? null, category: r.category, status: r.status,
        name: r.name, widthIn: r.width_in ?? null, heightIn: r.height_in ?? null, leaves: r.leaves ?? null, photos,
        supplierUrl: r.supplier_url ?? null, notes: r.notes ?? null, chargedCents: r.charged_cents ?? 0, refundedCents: r.refunded_cents ?? 0,
        refundReason: r.refund_reason ?? null, resultItemId: r.result_library_item_id ?? null, resultEntryId: r.result_client_library_id ?? null,
        resultNote: r.result_note ?? null, createdAt: r.created_at, updatedAt: r.updated_at, decidedAt: r.decided_at ?? null,
      };
    };
    const rows = [...(open.data ?? []), ...(closed.data ?? [])];
    return json({ ok: true, installed: true, requests: await Promise.all(rows.map(view)) });
  }

  if (action === "library_request_set") {
    const id = String(p.id ?? "").toLowerCase();
    if (!isLibraryId(id)) return json({ error: "No such request." }, 404);
    const status = String(p.status ?? "");
    if (!REQUEST_STATUSES.includes(status)) return json({ error: `status must be one of ${REQUEST_STATUSES.join(", ")}.` }, 400);
    const cur = await sb.from("library_requests").select("id, client_id, name, category, status").eq("id", id).maybeSingle();
    if (cur.error && missing(cur.error)) return json(NOT_APPLIED, 503);
    if (cur.error) throw cur.error;
    if (!cur.data) return json({ error: "No such request." }, 404);
    const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (status === "submitted" || status === "in_progress") { patch.decided_at = null; patch.decided_by = null; }
    else { patch.decided_at = new Date().toISOString(); patch.decided_by = identity.via === "operator" ? identity.userId ?? null : null; }
    if (p.resultNote !== undefined) {
      const note = String(p.resultNote ?? "").trim();
      if (note.length > 1000) return json({ error: "The note to the builder is 1,000 characters at most." }, 400);
      patch.result_note = note || null;
    }
    // THE RESULT LINK: the StructureStudio template this request became, and (addToBuilder) a copy of
    // it in the builder's own library under the name they asked for, so it is in their pickers at once.
    if (p.resultItemId !== undefined) {
      const tid = p.resultItemId == null || p.resultItemId === "" ? null : String(p.resultItemId).toLowerCase();
      if (tid !== null) {
        if (!isLibraryId(tid)) return json({ error: "No such template." }, 404);
        const t = await sb.from("library_items").select("id, category, name, look, version, status").eq("id", tid).maybeSingle();
        if (t.error) throw t.error;
        if (!t.data) return json({ error: "No such template." }, 404);
        if (t.data.category !== cur.data.category) return json({ error: `That template is a ${t.data.category}; this request is for a ${cur.data.category}.` }, 400);
        patch.result_library_item_id = tid;
        if (p.addToBuilder === true) {
          const taken = new Set(((await sb.from("client_library").select("name").eq("client_id", cur.data.client_id).eq("category", t.data.category)).data ?? [])
            .map((r: { name: string }) => String(r.name).toLowerCase()));
          let name = String(cleanName(cur.data.name) ?? t.data.name).slice(0, 60), k = 2;
          while (taken.has(name.toLowerCase())) { const suf = ` (${k++})`; name = String(cleanName(cur.data.name) ?? t.data.name).slice(0, 60 - suf.length) + suf; }
          const ins = await sb.from("client_library").insert({
            client_id: cur.data.client_id, category: t.data.category, library_item_id: t.data.id, template_version: t.data.version, name, look: t.data.look,
          }).select("id").single();
          if (ins.error) throw ins.error;
          patch.result_client_library_id = ins.data.id;
        }
      } else {
        patch.result_library_item_id = null;
      }
    }
    const up = await sb.from("library_requests").update(patch).eq("id", id).select(REQUEST_COLS).single();
    if (up.error) throw up.error;
    await auditRow(sb, identity, "library_request_set", String(cur.data.client_id), `request=${id} ${cur.data.status}->${status}${patch.result_client_library_id ? " added" : ""}`);
    return json({ ok: true, request: { id: up.data.id, status: up.data.status, resultItemId: up.data.result_library_item_id ?? null, resultEntryId: up.data.result_client_library_id ?? null } });
  }

  if (action === "library_request_refund") {
    const id = String(p.id ?? "").toLowerCase();
    if (!isLibraryId(id)) return json({ error: "No such request." }, 404);
    const reason = String(p.reason ?? "").replace(/\s+/g, " ").trim();
    if (!reason || reason.length > 300) return json({ error: "Say why (1 to 300 characters): the builder sees it." }, 400);
    const cur = await sb.from("library_requests").select("id, client_id, charged_cents, refunded_cents").eq("id", id).maybeSingle();
    if (cur.error && missing(cur.error)) return json(NOT_APPLIED, 503);
    if (cur.error) throw cur.error;
    if (!cur.data) return json({ error: "No such request." }, 404);
    const owed = Number(cur.data.charged_cents ?? 0) - Number(cur.data.refunded_cents ?? 0);
    const want = p.amountCents == null || p.amountCents === "" ? owed : Number(p.amountCents);
    if (!Number.isInteger(want) || want <= 0) return json({ error: owed > 0 ? "Refund a whole number of cents above 0." : "Nothing was charged for this request, so there is nothing to refund." }, 400);
    if (want > owed) return json({ error: `At most $${(owed / 100).toFixed(2)} is left to refund on this request.` }, 400);
    // The credit's key names the request and the total refunded after it, so a double click is one
    // credit while a second, later partial refund is its own.
    const after = Number(cur.data.refunded_cents ?? 0) + want;
    const { data: bal, error } = await sb.rpc("wallet_credit", {
      p_client_id: cur.data.client_id, p_amount_cents: want, p_kind: "refund", p_ref_type: "library_request", p_ref_id: id,
      p_memo: `Library request refund: ${reason}`.slice(0, 300), p_idem: `libreq-refund:${id}:${after}`, p_actor: identity.via === "operator" ? identity.userId ?? null : null,
    });
    if (error) throw error;
    const up = await sb.from("library_requests").update({ refunded_cents: after, refund_reason: reason, updated_at: new Date().toISOString() })
      .eq("id", id).eq("refunded_cents", Number(cur.data.refunded_cents ?? 0)).select("id").maybeSingle();
    if (up.error) throw up.error;
    await auditRow(sb, identity, "library_request_refund", String(cur.data.client_id), `request=${id} cents=${want} reason=${reason}`);
    return json({ ok: true, refundedCents: after, balanceCents: bal ?? null });
  }

  return json({ error: "Unknown library action." }, 400);
}
