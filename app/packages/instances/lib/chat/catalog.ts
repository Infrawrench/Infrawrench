import { env, waitUntil } from "cloudflare:workers";
import { query } from "../warehouse";
import { REGIONS_SQL, VALUES_SQL, VARIANT_SQL, formatCatalog } from "./catalog-text";
import { warehouseVersion } from "./views";

/**
 * The values the chat's model would otherwise query for before it can write
 * the query that answers a question: every value of the variant and pricing
 * columns per platform, and the region codes of each cloud with their names.
 * They go in the system prompt as a block of their own (cached like the rest
 * of it), so the model can go straight to the answering query instead of
 * spending a round trip on `SELECT DISTINCT operating_system ...` first.
 *
 * Built from the warehouse, so it is exactly what the data holds, and kept in
 * `INSTANCES_CHAT` as `catalog` with the data version it was built at. The
 * sync's notify call rebuilds it after each load (`refreshCatalog`); a chat
 * turn that finds it stale or missing goes on with what there is and has it
 * rebuilt in the background. No turn waits on it: the warehouse sometimes
 * takes a minute over the first query after a quiet spell.
 */

const KEY = "catalog";

interface StoredCatalog {
  text: string;
  version: string;
}

async function buildCatalog(): Promise<string> {
  const [values, variants, regions] = await Promise.all([
    query(VALUES_SQL, { maxRows: 100, timeoutMs: 120_000 }),
    query(VARIANT_SQL, { maxRows: 500, timeoutMs: 120_000 }),
    query(REGIONS_SQL, { maxRows: 2_000, timeoutMs: 120_000 }),
  ]);
  return formatCatalog(values, variants, regions);
}

/** Rebuild the catalog for the data version `version`; the notify route calls it after a load. */
export async function refreshCatalog(version?: string): Promise<string> {
  const [text, current] = await Promise.all([buildCatalog(), version ?? warehouseVersion()]);
  const stored: StoredCatalog = { text, version: current };
  await env.INSTANCES_CHAT.put(KEY, JSON.stringify(stored));
  return text;
}

/** The version a background refresh is running (or ran) for in this isolate. */
let refreshing: string | null = null;

/**
 * The catalog for the system prompt, or `""` until one has been built (the
 * chat still works, it just queries for values it would have been given).
 */
export async function catalogText(): Promise<string> {
  try {
    const [stored, version] = await Promise.all([
      env.INSTANCES_CHAT.get<StoredCatalog>(KEY, { type: "json", cacheTtl: 300 }),
      warehouseVersion(),
    ]);
    if (stored?.version !== version && refreshing !== version) {
      // Once per isolate per version: turns arriving meanwhile use what there is.
      refreshing = version;
      waitUntil(
        refreshCatalog(version).catch((error: unknown) => {
          console.warn("catalog refresh failed", error);
          refreshing = null;
        }),
      );
    }
    return stored?.text ?? "";
  } catch (error) {
    console.warn("catalog unavailable", error);
    return "";
  }
}
