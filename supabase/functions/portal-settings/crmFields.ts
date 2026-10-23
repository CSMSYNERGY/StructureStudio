// Settings → Customer Hub → Fields (migration 330, Carolyn 2026-10-22).
//
// "We need to show all the current fields for contacts and designs/deals in the customer hub tab
// under its own tab called fields. We need to allow to add as many custom fields as desired."
//
// Every action is a crm_* name ON PURPOSE, the same reason leadForms.ts gives: index.ts's CRM
// entitlement guard gates by that prefix, so the paid-CRM check covers all of these without a
// hand-kept list. Their GATES lines are settings_crm — view for the register, edit to change it —
// which is the area the Customer Hub already carries. None of them is a contacts:'edit' gate, so
// CONTACT_ROW_SCOPE has nothing to say about them: they write DEFINITIONS, never a customer's row.
// The two actions that write a customer's VALUES (crm_contact_custom_save, crm_deal_custom_save)
// are contacts:'edit' and live in index.ts beside the other contact writes, with their row-scope
// rules, exactly where a reviewer looking for "what can a dealer write?" will find them.
//
// The tenant is resolveTenant's; nothing here reads a client id from the body. Every row is
// matched on (client_id, id), so an id from another builder simply finds nothing.

import {
  CRM_BUILTINS, CRM_FIELD_HELP_MAX, CRM_FIELD_LABEL_MAX,
  CRM_FIELD_MAX_PER_ENTITY, CRM_FIELD_TYPE_IDS, CRM_FIELD_TYPES,
  builtinField, cleanChoices, crmFieldKey, crmFieldKeyUnique, isCrmEntity,
  type CrmEntity, type CrmFieldType,
} from "../_shared/crmFields.ts";

export const CRM_FIELD_ACTIONS = new Set([
  "crm_fields_list", "crm_field_create", "crm_field_save", "crm_field_delete",
  "crm_fields_reorder", "crm_builtin_field_save",
]);

// deno-lint-ignore no-explicit-any
type Db = any;
export type CrmFieldCtx = {
  admin: Db; req: Request; clientId: string; userId: string | null;
  action: string; payload: Record<string, unknown>;
  json: (b: unknown, s?: number) => Response;
  dbFail: (req: Request, clientId: string | null, where: string, err: unknown, status?: number) => Response;
  audit: (what: string, n: number, detail?: string) => Promise<unknown>;
};

const DEF_COLS = "id, entity, source, key, builtin_key, label, field_type, choices, help, required, hidden, position, archived_at, created_at, updated_at";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown) => UUID_RE.test(String(v ?? ""));
const label = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, CRM_FIELD_LABEL_MAX);
const help = (v: unknown) => {
  const s = String(v ?? "").trim().slice(0, CRM_FIELD_HELP_MAX);
  return s || null;
};

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** Position a new field after every live one, leaving room to drag between (the stage-editor rule). */
const nextPosition = (rows: Row[], entity: CrmEntity) => {
  const live = rows.filter((r) => r.entity === entity && r.source === "custom" && !r.archived_at);
  return live.reduce((max, r) => Math.max(max, Number(r.position) || 0), 0) + 1024;
};

export async function handleCrmFieldAction(ctx: CrmFieldCtx): Promise<Response> {
  const { admin, req, clientId, userId, action, payload, json, dbFail, audit } = ctx;

  /** Every definition row this tenant has, both kinds, both entities, archived included. One read
   *  serves every action here — the table holds a handful of rows per tenant. */
  const readDefs = async (): Promise<Row[] | Response> => {
    const { data, error } = await admin.from("crm_field_defs").select(DEF_COLS)
      .eq("client_id", clientId).order("position", { ascending: true });
    if (error) return dbFail(req, clientId, "load your fields", error);
    return (data ?? []) as Row[];
  };

  // ── THE REGISTER ────────────────────────────────────────────────────────────────────────
  // The catalogue of what exists, with this builder's overrides folded in, plus their own
  // fields after it. Folded HERE and not in the browser so the rule lives in one place, and
  // so the record page and the Fields tab can never disagree about a field's label.
  if (action === "crm_fields_list") {
    const defs = await readDefs();
    if (defs instanceof Response) return defs;

    const forEntity = (entity: CrmEntity) => {
      const overrides = new Map<string, Row>();
      for (const r of defs) {
        if (r.entity === entity && r.source === "builtin" && r.builtin_key) overrides.set(String(r.builtin_key), r);
      }
      const builtins = CRM_BUILTINS[entity].map((f) => {
        const o = overrides.get(f.id);
        return {
          kind: "builtin" as const,
          id: f.id,
          key: f.id,
          label: o && String(o.label || "").trim() ? String(o.label) : f.label,
          defaultLabel: f.label,
          // `renamed` and `hidden` are what the tab's Reset button keys on: with neither, there is
          // no override row and nothing to reset, so the button is not offered.
          renamed: !!(o && String(o.label || "").trim() && String(o.label) !== f.label),
          hidden: !!(o && o.hidden),
          type: f.type,
          group: f.group,
          editable: f.editable,
          derived: f.derived ?? null,
          note: f.note ?? null,
          relabel: f.relabel !== false,
          hideable: f.hideable !== false,
        };
      });
      const custom = defs
        .filter((r) => r.entity === entity && r.source === "custom" && !r.archived_at)
        .map((r) => ({
          kind: "custom" as const,
          id: String(r.id),
          key: String(r.key),
          label: String(r.label),
          type: String(r.field_type),
          choices: Array.isArray(r.choices) ? r.choices.map(String) : [],
          help: r.help ? String(r.help) : null,
          required: !!r.required,
          hidden: !!r.hidden,
          position: Number(r.position) || 0,
          createdAt: r.created_at ?? null,
        }));
      const archived = defs
        .filter((r) => r.entity === entity && r.source === "custom" && r.archived_at)
        .map((r) => ({
          kind: "custom" as const, id: String(r.id), key: String(r.key), label: String(r.label),
          type: String(r.field_type), archivedAt: r.archived_at,
        }));
      return { builtins, custom, archived };
    };

    return json({
      ok: true,
      contact: forEntity("contact"),
      deal: forEntity("deal"),
      types: CRM_FIELD_TYPES,
      maxPerEntity: CRM_FIELD_MAX_PER_ENTITY,
    });
  }

  // ── ADD A FIELD ─────────────────────────────────────────────────────────────────────────
  if (action === "crm_field_create") {
    const entity = String(payload.entity ?? "");
    if (!isCrmEntity(entity)) return json({ error: "Pick whether this field is on a contact or on a design/deal." }, 400);
    const name = label(payload.label);
    if (!name) return json({ error: "Give the field a name." }, 400);
    const type = String(payload.type ?? "text");
    if (CRM_FIELD_TYPE_IDS.indexOf(type as CrmFieldType) === -1) return json({ error: "Pick what kind of field this is." }, 400);
    const choices = type === "select" ? cleanChoices(payload.choices) : [];
    if (type === "select" && choices.length === 0) {
      return json({ error: "A drop-down needs at least one choice." }, 400);
    }

    const defs = await readDefs();
    if (defs instanceof Response) return defs;
    const live = defs.filter((r) => r.entity === entity && r.source === "custom" && !r.archived_at);
    if (live.length >= CRM_FIELD_MAX_PER_ENTITY) {
      return json({ error: `That is as many custom fields as one ${entity === "contact" ? "contact" : "design/deal"} can carry (${CRM_FIELD_MAX_PER_ENTITY}). Delete one you no longer use first.` }, 400);
    }
    // A name already in use is a mistake worth saying out loud rather than quietly making
    // "visit_date_2" — the builder would have two identical-looking fields and no way to tell
    // which one their old values are in.
    if (live.some((r) => String(r.label).toLowerCase() === name.toLowerCase())) {
      return json({ error: `You already have a field called "${name}" there. Give this one a different name.` }, 409);
    }
    // The key is minted from the label ONCE and never changes (330's header). Unique against
    // every key the tenant has ever used on this entity, archived rows included: re-using an
    // archived field's key would resurrect its old values under a new field's name.
    const taken = defs.filter((r) => r.entity === entity && r.source === "custom").map((r) => String(r.key));
    const key = crmFieldKeyUnique(crmFieldKey(name), taken);

    const { data, error } = await admin.from("crm_field_defs").insert({
      client_id: clientId, entity, source: "custom", key, label: name,
      field_type: type, choices, help: help(payload.help),
      required: payload.required === true,
      position: nextPosition(defs, entity),
      created_by: isUuid(userId) ? userId : null,
    }).select(DEF_COLS).maybeSingle();
    if (error) {
      if (String(error.code) === "23505") {
        return json({ error: "A field with that name was just added. Refresh and have a look." }, 409);
      }
      return dbFail(req, clientId, "add that field", error);
    }
    audit("crm_field_create", 1, `${entity} ${key} ${type}`).catch(() => {});
    return json({ ok: true, field: data });
  }

  // ── CHANGE ONE OF THEIR OWN ─────────────────────────────────────────────────────────────
  // The TYPE may change and the KEY may not. Changing the type leaves the values where they are:
  // a date stored as "2026-01-02" reads fine as text, and a text value that is not a number shows
  // as what was typed until somebody edits it. Refusing the change instead would leave a builder
  // who picked Text by mistake with a field they can only delete — and deleting is the thing that
  // loses the data, which is the outcome a refusal is supposed to prevent.
  if (action === "crm_field_save") {
    const id = String(payload.id ?? "");
    if (!isUuid(id)) return json({ error: "That field wasn't found." }, 400);

    const defs = await readDefs();
    if (defs instanceof Response) return defs;
    const row = defs.find((r) => String(r.id) === id.toLowerCase() || String(r.id) === id);
    if (!row) return json({ error: "That field no longer exists." }, 404);
    if (row.source !== "custom") {
      // A built-in has its own action, because what may be changed about one is a different and
      // much shorter list. Answered in words rather than with a 404 so a stale tab says why.
      return json({ error: "That is one of the built-in fields — rename or hide it from its own row." }, 400);
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (payload.label !== undefined) {
      const name = label(payload.label);
      if (!name) return json({ error: "Give the field a name." }, 400);
      const clash = defs.some((r) => r.entity === row.entity && r.source === "custom" && !r.archived_at
        && String(r.id) !== String(row.id) && String(r.label).toLowerCase() === name.toLowerCase());
      if (clash) return json({ error: `You already have a field called "${name}" there.` }, 409);
      patch.label = name;
    }
    const type = payload.type === undefined ? String(row.field_type) : String(payload.type);
    if (payload.type !== undefined) {
      if (CRM_FIELD_TYPE_IDS.indexOf(type as CrmFieldType) === -1) return json({ error: "Pick what kind of field this is." }, 400);
      patch.field_type = type;
    }
    // The choices and the type travel together, always: a field that is no longer a drop-down must
    // shed its choices (330's CHECK refuses the pair), and one that just became a drop-down has to
    // arrive with some. So the choices are rewritten on any save that touches either.
    if (payload.choices !== undefined || payload.type !== undefined) {
      if (type === "select") {
        const choices = cleanChoices(payload.choices !== undefined ? payload.choices : row.choices);
        if (choices.length === 0) return json({ error: "A drop-down needs at least one choice." }, 400);
        patch.choices = choices;
      } else {
        patch.choices = [];
      }
    }
    if (payload.help !== undefined) patch.help = help(payload.help);
    if (payload.required !== undefined) patch.required = payload.required === true;
    if (payload.hidden !== undefined) patch.hidden = payload.hidden === true;

    const { data, error } = await admin.from("crm_field_defs").update(patch)
      .eq("client_id", clientId).eq("id", row.id).select(DEF_COLS).maybeSingle();
    if (error) return dbFail(req, clientId, "save that field", error);
    if (!data) return json({ error: "That field no longer exists." }, 404);
    audit("crm_field_save", 1, `${row.entity} ${row.key}`).catch(() => {});
    return json({ ok: true, field: data });
  }

  // ── DELETE ONE OF THEIR OWN — ARCHIVE, AND THE VALUES STAY ──────────────────────────────
  // 330's header: nothing here destroys a column of customer data on one click. The definition is
  // archived, so the field leaves every card and every form; the values sit in the jsonb exactly
  // as they were, and Restore brings the whole lot back. The Fields tab lists what is archived and
  // offers Restore, so this is visible rather than a thing only the database knows.
  if (action === "crm_field_delete") {
    const id = String(payload.id ?? "");
    if (!isUuid(id)) return json({ error: "That field wasn't found." }, 400);
    const restore = payload.restore === true;

    const defs = await readDefs();
    if (defs instanceof Response) return defs;
    const row = defs.find((r) => String(r.id) === id.toLowerCase() || String(r.id) === id);
    if (!row) return json({ error: "That field no longer exists." }, 404);
    if (row.source !== "custom") return json({ error: "A built-in field can be hidden, but not deleted." }, 400);

    // Restoring into a key some newer field has taken would break the live unique index — which is
    // the honest answer, so say it rather than letting Postgres phrase it.
    if (restore) {
      const clash = defs.some((r) => r.entity === row.entity && r.source === "custom" && !r.archived_at
        && String(r.key) === String(row.key));
      if (clash) return json({ error: "A field is already using that one's place. Delete or rename it first." }, 409);
    }

    const { data, error } = await admin.from("crm_field_defs")
      .update({ archived_at: restore ? null : new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("client_id", clientId).eq("id", row.id).select("id").maybeSingle();
    if (error) return dbFail(req, clientId, restore ? "restore that field" : "delete that field", error);
    if (!data) return json({ error: "That field no longer exists." }, 404);
    audit("crm_field_delete", 1, `${row.entity} ${row.key} restore=${restore}`).catch(() => {});
    return json({ ok: true });
  }

  // ── THE ORDER THEY SHOW IN ──────────────────────────────────────────────────────────────
  // Custom fields only: the built-ins' order is the catalogue's, which is the order the editor
  // itself builds them in, and letting that be dragged would mean the Fields tab and the contact
  // card disagree about where Phone goes.
  if (action === "crm_fields_reorder") {
    const entity = String(payload.entity ?? "");
    if (!isCrmEntity(entity)) return json({ error: "Pick whether these are contact or design/deal fields." }, 400);
    const ids = Array.isArray(payload.ids) ? payload.ids.map((v) => String(v)) : [];
    if (!ids.length) return json({ error: "Nothing to reorder." }, 400);

    const defs = await readDefs();
    if (defs instanceof Response) return defs;
    const live = defs.filter((r) => r.entity === entity && r.source === "custom" && !r.archived_at);
    const byId = new Map(live.map((r) => [String(r.id), r]));
    // Every id must be one of THIS tenant's live fields on THIS entity. A list that names anything
    // else is a stale tab (or worse), and renumbering a partial list would interleave the ones it
    // left out at their old positions — so the whole call is refused rather than half-applied.
    if (ids.length !== live.length || ids.some((i) => !byId.has(i))) {
      return json({ error: "That list is out of date — refresh and drag again." }, 409);
    }
    const now = new Date().toISOString();
    for (let i = 0; i < ids.length; i++) {
      const target = byId.get(ids[i]);
      if (!target) return json({ error: "That list is out of date — refresh and drag again." }, 409);
      const { error } = await admin.from("crm_field_defs")
        .update({ position: (i + 1) * 1024, updated_at: now })
        .eq("client_id", clientId).eq("id", target.id);
      if (error) return dbFail(req, clientId, "save that order", error);
    }
    return json({ ok: true });
  }

  // ── RENAME OR HIDE ONE OF OURS ──────────────────────────────────────────────────────────
  // An OVERRIDE row, written lazily (330: an untouched account has none, so the catalogue is the
  // whole answer). Putting both back to the default DELETES the row rather than storing a row that
  // says "no change" — which is what keeps "has this builder touched this field?" answerable.
  if (action === "crm_builtin_field_save") {
    const entity = String(payload.entity ?? "");
    if (!isCrmEntity(entity)) return json({ error: "Pick whether this field is on a contact or on a design/deal." }, 400);
    const key = String(payload.builtinKey ?? "");
    const f = builtinField(entity as CrmEntity, key);
    if (!f) return json({ error: "That field wasn't found." }, 404);

    const defs = await readDefs();
    if (defs instanceof Response) return defs;
    const row = defs.find((r) => r.entity === entity && r.source === "builtin" && String(r.builtin_key) === key) ?? null;

    // undefined = not being changed, so a rename does not silently un-hide.
    let name = payload.label === undefined
      ? (row ? String(row.label) : f.label)
      : (label(payload.label) || f.label);
    let hidden = payload.hidden === undefined ? !!(row && row.hidden) : payload.hidden === true;
    if (payload.label !== undefined && f.relabel === false && name !== f.label) {
      return json({ error: `"${f.label}" keeps its name — the rest of the product refers to it by that word.` }, 400);
    }
    if (hidden && f.hideable === false) {
      return json({ error: `"${f.label}" can't be hidden.` }, 400);
    }
    // Reset: both halves back to ours. Also what a rename TO the default label means, so a builder
    // typing the original name back leaves no trace, the same as pressing Reset.
    if (payload.reset === true) { name = f.label; hidden = false; }

    if (name === f.label && !hidden) {
      if (row) {
        const { error } = await admin.from("crm_field_defs").delete()
          .eq("client_id", clientId).eq("id", row.id);
        if (error) return dbFail(req, clientId, "reset that field", error);
      }
      return json({ ok: true, reset: true });
    }

    const patch = {
      client_id: clientId, entity, source: "builtin", builtin_key: key, key: null,
      label: name, hidden, field_type: "text", choices: [] as string[],
      updated_at: new Date().toISOString(),
    };
    if (row) {
      const { error } = await admin.from("crm_field_defs")
        .update({ label: name, hidden, updated_at: patch.updated_at })
        .eq("client_id", clientId).eq("id", row.id);
      if (error) return dbFail(req, clientId, "save that field", error);
    } else {
      const { error } = await admin.from("crm_field_defs")
        .insert({ ...patch, position: 0, created_by: isUuid(userId) ? userId : null });
      if (error) return dbFail(req, clientId, "save that field", error);
    }
    audit("crm_builtin_field_save", 1, `${entity} ${key} hidden=${hidden}`).catch(() => {});
    return json({ ok: true, label: name, hidden });
  }

  return json({ error: "Unknown field action." }, 400);
}

/**
 * The live custom-field definitions for one entity, in display order, as the record page needs
 * them. Used by crm_record so a contact card can draw a builder's own fields without a second
 * round trip, and by the two value-save actions so a value is checked against its real field.
 */
export async function readCustomFields(
  // deno-lint-ignore no-explicit-any
  admin: any, clientId: string, entity: CrmEntity,
): Promise<{ fields: Row[] } | { dbError: unknown }> {
  const { data, error } = await admin.from("crm_field_defs")
    .select("id, key, label, field_type, choices, help, required, hidden, position")
    .eq("client_id", clientId).eq("entity", entity).eq("source", "custom")
    .is("archived_at", null).order("position", { ascending: true });
  if (error) return { dbError: error };
  return { fields: (data ?? []) as Row[] };
}

/** The built-in label/hidden overrides for one entity, as `{ builtin_key: {label, hidden} }`. */
export async function readBuiltinOverrides(
  // deno-lint-ignore no-explicit-any
  admin: any, clientId: string, entity: CrmEntity,
): Promise<{ overrides: Record<string, { label: string; hidden: boolean }> } | { dbError: unknown }> {
  const { data, error } = await admin.from("crm_field_defs")
    .select("builtin_key, label, hidden")
    .eq("client_id", clientId).eq("entity", entity).eq("source", "builtin");
  if (error) return { dbError: error };
  const out: Record<string, { label: string; hidden: boolean }> = {};
  for (const r of (data ?? []) as Row[]) {
    if (!r.builtin_key) continue;
    out[String(r.builtin_key)] = { label: String(r.label || ""), hidden: !!r.hidden };
  }
  return { overrides: out };
}
