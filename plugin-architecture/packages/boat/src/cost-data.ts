import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { pathEncode } from "@infrawrench/plugin-base";
import { listSandboxes } from "./api.js";
import type { BoatClient } from "./client.js";
import type { BSandbox } from "./types.js";

/**
 * Daily machine-time cost per sandbox from `GET /sandboxes/{id}/usage?since&until`,
 * the meter boat bills the wallet from: billable seconds (size multiplier
 * applied) and their price at list. boat has no billing export, so this is
 * the finest record there is.
 *
 * It is list price, before the plan's included hours, and the plan fee itself,
 * saved-snapshot overage, extra starts and the AI proxy are not in it (v1 has
 * no billing routes), which is why the capability is declared `estimated`.
 *
 * A sandbox deleted before a collection reached its last day is gone from the
 * list, so that day's tail is lost; days already collected stay stored.
 *
 * Calls are kept down three ways: sandboxes created after the range, or stopped
 * before it, are skipped; one call over the whole range comes first, and only a
 * sandbox that ran in it is read day by day; and those days are clipped to its
 * lifetime.
 */

export const SERVICE = "Sandbox machine time";
const DAY_MS = 86_400_000;
const CONCURRENCY = 4;
const STOPPED: readonly string[] = ["archived", "error", "cancelled"];

function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The part of [from, to) a sandbox could have run in, or null for none. */
export function activeWindow(
  s: Pick<BSandbox, "state" | "createdAt" | "stoppedAt">,
  from: number,
  to: number,
): { from: number; to: number } | null {
  const created = s.createdAt ? Date.parse(s.createdAt) : NaN;
  const stopped = STOPPED.includes(s.state) && s.stoppedAt ? Date.parse(s.stoppedAt) : Number.NaN;
  const start = Number.isFinite(created) ? Math.max(from, created) : from;
  // A stop is the end of the last run; a stopped sandbox that has no stop time
  // (an error on create) still gets read, since the meter is the authority.
  const end = Number.isFinite(stopped) ? Math.min(to, stopped) : to;
  return end > start ? { from: start, to: end } : null;
}

async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await run(item);
    }
  });
  await Promise.all(workers);
}

export async function fetchBoatCosts(
  client: BoatClient,
  _accountId: string,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const from = dayStart(range.fromDate);
  const to = Math.min(dayStart(range.toDate) + DAY_MS, Date.now());
  if (!(to > from)) return [];
  const sandboxes = await listSandboxes(client.api, false);
  const usage = (id: string, since: number, until: number) =>
    client.api.get(`/sandboxes/${pathEncode(id)}/usage`, {
      query: { since: iso(since), until: iso(until) },
    });

  const rows: CostRow[] = [];
  const candidates = sandboxes
    .map((s) => ({ s, window: activeWindow(s, from, to) }))
    .filter((c): c is { s: BSandbox; window: { from: number; to: number } } => c.window !== null);

  await pool(candidates, CONCURRENCY, async ({ s, window }) => {
    const total = await usage(s.id, window.from, window.to);
    if (!total || !(total.seconds > 0)) return;
    // Labels only: boat reports a sandbox's current size, not the size each day ran on.
    const tags = { ...(s.labels ?? {}) };
    // Day boundaries in UTC, clipped to the window.
    for (
      let day = from + Math.floor((window.from - from) / DAY_MS) * DAY_MS;
      day < window.to;
      day += DAY_MS
    ) {
      const since = Math.max(day, window.from);
      const until = Math.min(day + DAY_MS, window.to);
      if (until <= since) continue;
      const u = await usage(s.id, since, until);
      if (!u || !(u.dollars > 0)) continue;
      rows.push({
        date: new Date(day).toISOString().slice(0, 10),
        service: SERVICE,
        resourceId: s.id,
        tags,
        currency: "USD",
        amount: u.dollars,
        usageAmount: Math.round((u.seconds / 3600) * 10000) / 10000,
        usageUnit: "default-size hours",
      });
    }
  });
  return rows;
}
