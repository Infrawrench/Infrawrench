import { env } from "cloudflare:workers";
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
