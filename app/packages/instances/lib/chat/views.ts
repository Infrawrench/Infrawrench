import { env, waitUntil } from "cloudflare:workers";
import { query } from "../warehouse";
import type { StoredView, ViewData, ViewSpec } from "./types";

export { checkAgainstResult, parseViewSpec } from "./spec";

/**
 * Saved views: a table or chart the chat showed, kept in the `INSTANCES_CHAT`
 * namespace as `view:<id>` so `/v/<id>` can show it again, with fresh data,
 * and alerts can re-run it. A view stores its query and presentation, never
 * the conversation it came from.
 */

/** Rows a table loads (filtering and sorting happen in the browser). */
export const TABLE_ROWS = 2000;
/** Rows a chart loads. */
export const CHART_ROWS = 1000;

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A random id, `length` base-62 characters. Long enough to be unguessable at 16+. */
export function randomId(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  // 248 is the largest multiple of 62 under 256; rejecting above it keeps the draw uniform.
  let out = "";
  for (const b of bytes) out += b < 248 ? ID_ALPHABET[b % 62] : "";
  return out.length === length ? out : out + randomId(length - out.length);
}

export async function saveView(spec: ViewSpec): Promise<StoredView> {
  const view: StoredView = { ...spec, id: randomId(10), createdAt: Date.now() };
  await env.INSTANCES_CHAT.put(`view:${view.id}`, JSON.stringify(view));
  return view;
}

export async function loadView(id: string): Promise<StoredView | null> {
  if (!/^[0-9A-Za-z]{6,32}$/.test(id)) return null;
  return env.INSTANCES_CHAT.get<StoredView>(`view:${id}`, { type: "json", cacheTtl: 3600 });
}

/** Run a view's query, with the row cap its kind gets. */
export async function runView(view: StoredView): Promise<ViewData> {
  const result = await query(view.sql, {
    maxRows: view.kind === "table" ? TABLE_ROWS : CHART_ROWS,
  });
  return { view, result, ranAt: Date.now() };
}

/**
 * Each view's last result, so a shared link or a restored conversation shows
 * at once instead of waiting on the warehouse. `result:<id>` holds it with the
 * data version it was run at; `warehouse-version` is bumped by
 * `POST /api/internal/notify` after every sync load. A result from an older
 * version is still served, and re-run in the background for the next visit.
 */
interface CachedResult {
  data: ViewData;
  version: string;
}

const resultKey = (id: string) => `result:${id}`;
const VERSION_KEY = "warehouse-version";

/** The version of the warehouse's data; changes when the sync loads something. */
export async function warehouseVersion(): Promise<string> {
  return (await env.INSTANCES_CHAT.get(VERSION_KEY, { cacheTtl: 60 })) ?? "0";
}

/** Record that the warehouse's data changed; returns the new version. */
export async function bumpWarehouseVersion(): Promise<string> {
  const version = String(Date.now());
  await env.INSTANCES_CHAT.put(VERSION_KEY, version);
  return version;
}

export async function storeResult(data: ViewData, version?: string): Promise<void> {
  const cached: CachedResult = { data, version: version ?? (await warehouseVersion()) };
  await env.INSTANCES_CHAT.put(resultKey(data.view.id), JSON.stringify(cached));
}

/** A view with its data: the cached result when there is one, else a fresh run (then cached). */
export async function viewData(view: StoredView): Promise<ViewData> {
  const [cached, version] = await Promise.all([
    env.INSTANCES_CHAT.get<CachedResult>(resultKey(view.id), { type: "json", cacheTtl: 60 }),
    warehouseVersion(),
  ]);
  if (cached) {
    if (cached.version !== version) {
      waitUntil(
        runView(view)
          .then((fresh) => storeResult(fresh, version))
          .catch((error: unknown) => console.warn(`view ${view.id}: refresh failed`, error)),
      );
    }
    return cached.data;
  }
  const data = await runView(view);
  waitUntil(storeResult(data, version));
  return data;
}
