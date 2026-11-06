// Every object under a storage prefix, at any depth, and removing them (2026-10-21, Track G part 2).
//
// WHY. Storage's list() returns one level: files, plus sub-folders as entries with no id. delete_client
// used to list <clientId>/ once and remove what came back, so a bucket laid out {client}/{unit}/{file}
// (inventory-photos, models, repair-photos, customer-uploads) kept every file, and removing a folder's
// NAME removes nothing. This walks the folders and returns real object paths.
//
// Bounded: at most MAX_OBJECTS paths and MAX_LISTS list calls per walk, so a runaway prefix ends as
// a reported partial instead of an edge function that runs out of time. `complete` says which.
//
// Importers: admin-catalog (delete_client), _shared/tenantExport.ts.

// deno-lint-ignore-file no-explicit-any

export const MAX_OBJECTS = 20000;
const MAX_LISTS = 2000;
const PAGE = 1000;

export interface StoredObject {
  path: string;
  size: number;
  createdAt: string | null;
}

export interface Tree {
  objects: StoredObject[];
  /** false: a list call failed, or a bound was reached; `objects` is what was found before that. */
  complete: boolean;
}

/** Every object under `prefix` (no leading or trailing slash), depth first. */
export async function listTree(sb: any, bucket: string, prefix: string): Promise<Tree> {
  const objects: StoredObject[] = [];
  const folders = [prefix];
  let lists = 0;
  while (folders.length) {
    const dir = folders.pop()!;
    for (let offset = 0; ; offset += PAGE) {
      if (++lists > MAX_LISTS || objects.length >= MAX_OBJECTS) return { objects, complete: false };
      const { data, error } = await sb.storage.from(bucket).list(dir, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) return { objects, complete: false };
      const page = (data ?? []) as any[];
      for (const o of page) {
        const path = `${dir}/${o.name}`;
        // A folder comes back with no id and no metadata.
        if (o.id == null) folders.push(path);
        else objects.push({ path, size: Number(o.metadata?.size ?? 0) || 0, createdAt: o.created_at ?? null });
      }
      if (page.length < PAGE) break;
    }
  }
  return { objects, complete: true };
}

/** Remove the paths, a thousand at a time. `removed` counts what storage confirmed. */
export async function removePaths(sb: any, bucket: string, paths: string[]): Promise<{ removed: number; failed: boolean }> {
  let removed = 0;
  for (let i = 0; i < paths.length; i += PAGE) {
    const batch = paths.slice(i, i + PAGE);
    try {
      const { data, error } = await sb.storage.from(bucket).remove(batch);
      if (error) return { removed, failed: true };
      removed += Array.isArray(data) ? data.length : batch.length;
    } catch (_e) {
      return { removed, failed: true };
    }
  }
  return { removed, failed: false };
}

/** Everything under <prefix>/ in the bucket, gone. `complete` false: the walk or a remove stopped. */
export async function sweepPrefix(sb: any, bucket: string, prefix: string): Promise<{ removed: number; complete: boolean }> {
  const tree = await listTree(sb, bucket, prefix);
  const { removed, failed } = await removePaths(sb, bucket, tree.objects.map((o) => o.path));
  return { removed, complete: tree.complete && !failed };
}
