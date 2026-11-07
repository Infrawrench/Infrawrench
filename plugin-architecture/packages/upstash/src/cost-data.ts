import type { CostFetchRange, CostFetchResult, CostRow } from "@infrawrench/plugin-base";
import type { UpstashContext } from "./api.js";
import { pathEncode } from "@infrawrench/plugin-base";
import { dev } from "./api.js";
import { parseUpstashTime } from "./mappers.js";
import type { Point, UpQStashUser, UpRedis } from "./types.js";

/**
 * Daily spend, verified 2026-10 against the Developer API spec:
 *
 * - `GET /redis/stats/{id}` returns `dailybilling`: one `{x, y}` point per
 *   day (x a Go-formatted timestamp, y US dollars) for the last week.
 * - `GET /qstash/stats/{id}` returns `daily_billings` the same way for a
 *   regional QStash account.
 *
 * Vector and Search stats only carry a month-to-date `monthly_cost`, with no
 * daily breakdown, so they are not turned into cost rows (a month-to-date
 * figure cannot be dated without double counting); their detail pages show
 * it instead. Upstash bills in US dollars.
 */
export const COST_HISTORY_DAYS = 7;

function rowsFrom(
  points: Point[] | undefined,
  range: CostFetchRange,
  base: Omit<CostRow, "date" | "amount" | "currency">,
): CostRow[] {
  const byDay = new Map<string, number>();
  for (const p of points ?? []) {
    const ts = parseUpstashTime(p.x);
    const amount = Number(p.y);
    if (!Number.isFinite(ts) || !Number.isFinite(amount) || amount === 0) continue;
    const date = new Date(ts).toISOString().slice(0, 10);
    if (date < range.fromDate || date > range.toDate) continue;
    byDay.set(date, (byDay.get(date) ?? 0) + amount);
  }
  return [...byDay.entries()].map(([date, amount]) => ({
    ...base,
    date,
    currency: "USD",
    amount: Math.round(amount * 10000) / 10000,
  }));
}

export async function fetchUpstashCostData(
  ctx: UpstashContext,
  range: CostFetchRange,
): Promise<CostRow[] | CostFetchResult> {
  const rows: CostRow[] = [];
  let degraded = false;
  const [dbs, qstash] = await Promise.all([
    dev(ctx, (api) => api.get("/redis/databases")).catch((): UpRedis[] => {
      degraded = true;
      return [];
    }),
    dev(ctx, (api) => api.get("/qstash/users")).catch((): UpQStashUser[] => {
      degraded = true;
      return [];
    }),
  ]);
  for (const db of dbs ?? []) {
    if (!db.database_id || db.type === "free") continue;
    try {
      const id = pathEncode(db.database_id);
      const stats = await dev(ctx, (api) => api.get(`/redis/stats/${id}`));
      rows.push(
        ...rowsFrom(stats?.dailybilling, range, {
          service: "Redis",
          resourceId: db.database_id,
          ...(db.primary_region ? { region: db.primary_region } : {}),
          tags: { name: db.database_name ?? db.database_id, plan: db.type ?? "" },
        }),
      );
    } catch {
      degraded = true;
    }
  }
  for (const q of qstash ?? []) {
    if (!q.id || q.type === "free") continue;
    try {
      const id = pathEncode(q.id);
      const stats = await dev(ctx, (api) =>
        api.get(`/qstash/stats/${id}`, { query: { period: "7d" } }),
      );
      rows.push(
        ...rowsFrom(stats?.daily_billings, range, {
          service: "QStash",
          resourceId: q.id,
          ...(q.region ? { region: q.region } : {}),
        }),
      );
    } catch {
      degraded = true;
    }
  }
  return degraded ? { rows, degraded: true } : rows;
}
