/**
 * Reading stored seats back into the client-core `SeatRow` shape, which is
 * what both the findings computation and the wire response use.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { SeatAccountStatus, SeatRow } from "@infrawrench/client-core";
import type { SeatActivityBasis, SeatCategory, SeatPriceSource } from "@infrawrench/plugin-base";
import { SEAT_CATEGORIES } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { accountSeatPolls, accountSeats, accounts } from "../db/schema";
import { getPlugin, loadPlugins } from "../plugin-loader";

type SeatDbRow = typeof accountSeats.$inferSelect;

const BASES: readonly SeatActivityBasis[] = ["last-activity", "last-login", "usage-window", "none"];
const PRICE_SOURCES: readonly SeatPriceSource[] = [
  "billing",
  "catalog",
  "configured",
  "list-price",
];

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** One stored row as the wire shape. Unknown enum values degrade, never throw. */
export function seatRowFromDb(
  row: SeatDbRow,
  names: { accountName: string; pluginName: string },
): SeatRow {
  const downgrade = row.downgrade;
  const downgradeSource = downgrade?.price.source as SeatPriceSource | undefined;
  return {
    id: row.id,
    accountId: row.accountId,
    accountName: names.accountName,
    pluginId: row.pluginId,
    pluginName: names.pluginName,
    memberId: row.memberId,
    seatKey: row.seatKey,
    name: row.name,
    email: row.email,
    login: row.login,
    product: row.product,
    category: SEAT_CATEGORIES.includes(row.category as SeatCategory)
      ? (row.category as SeatCategory)
      : "other",
    seatType: row.seatType,
    monthlyPrice: row.monthlyPrice,
    currency: row.currency,
    priceSource: PRICE_SOURCES.includes(row.priceSource as SeatPriceSource)
      ? (row.priceSource as SeatPriceSource)
      : null,
    priceNote: row.priceNote,
    activityBasis: BASES.includes(row.activityBasis as SeatActivityBasis)
      ? (row.activityBasis as SeatActivityBasis)
      : "none",
    lastActiveAt: iso(row.lastActiveAt),
    activityWindowDays: row.activityWindowDays,
    activitySource: row.activitySource,
    assignedAt: iso(row.assignedAt),
    pendingRemovalOn: iso(row.pendingRemovalOn),
    removable: row.removable,
    removalNote: row.removalNote,
    downgrade:
      downgrade && downgradeSource && PRICE_SOURCES.includes(downgradeSource)
        ? {
            seatType: downgrade.seatType,
            price: {
              monthly: downgrade.price.monthly,
              currency: downgrade.price.currency,
              source: downgradeSource,
              ...(downgrade.price.note ? { note: downgrade.price.note } : {}),
            },
            reason: downgrade.reason,
          }
        : null,
    context: row.context ?? {},
    resource:
      row.resourceTypeId && row.externalId
        ? { resourceTypeId: row.resourceTypeId, externalId: row.externalId }
        : null,
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

async function pluginName(pluginId: string, cache: Map<string, string>): Promise<string> {
  const hit = cache.get(pluginId);
  if (hit !== undefined) return hit;
  const name = (await getPlugin(pluginId))?.plugin.manifest.displayName ?? pluginId;
  cache.set(pluginId, name);
  return name;
}

/** Plugin ids whose manifest declares `seats`. */
export async function seatPluginIds(): Promise<Set<string>> {
  const loaded = await loadPlugins();
  return new Set(loaded.filter((l) => l.plugin.manifest.seats).map((l) => l.plugin.manifest.id));
}

export interface OrgSeatInventory {
  rows: SeatRow[];
  accounts: SeatAccountStatus[];
}

/**
 * The org's stored seats and each seat-capable account's collection state,
 * limited to `visibleAccountIds` when the caller is cost-scoped (null means
 * every account).
 */
export async function loadOrgSeats(
  organizationId: string,
  visibleAccountIds: Set<string> | null,
): Promise<OrgSeatInventory> {
  const capable = await seatPluginIds();
  if (capable.size === 0) return { rows: [], accounts: [] };
  const orgAccounts = (
    await db
      .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organizationId),
          isNull(accounts.deletedAt),
          inArray(accounts.pluginId, [...capable]),
        ),
      )
  ).filter((a) => !visibleAccountIds || visibleAccountIds.has(a.id));
  if (orgAccounts.length === 0) return { rows: [], accounts: [] };
  const ids = orgAccounts.map((a) => a.id);

  const [seatRows, polls] = await Promise.all([
    db
      .select()
      .from(accountSeats)
      .where(
        and(eq(accountSeats.organizationId, organizationId), inArray(accountSeats.accountId, ids)),
      ),
    db
      .select()
      .from(accountSeatPolls)
      .where(
        and(
          eq(accountSeatPolls.organizationId, organizationId),
          inArray(accountSeatPolls.accountId, ids),
        ),
      ),
  ]);

  const names = new Map<string, string>();
  const accountById = new Map(orgAccounts.map((a) => [a.id, a]));
  const rows: SeatRow[] = [];
  const counts = new Map<string, number>();
  for (const row of seatRows) {
    const account = accountById.get(row.accountId);
    if (!account) continue;
    counts.set(row.accountId, (counts.get(row.accountId) ?? 0) + 1);
    rows.push(
      seatRowFromDb(row, {
        accountName: account.displayName,
        pluginName: await pluginName(row.pluginId, names),
      }),
    );
  }
  const pollById = new Map(polls.map((p) => [p.accountId, p]));
  const statuses: SeatAccountStatus[] = [];
  for (const account of orgAccounts) {
    const poll = pollById.get(account.id);
    statuses.push({
      accountId: account.id,
      accountName: account.displayName,
      pluginId: account.pluginId,
      pluginName: await pluginName(account.pluginId, names),
      seatCount: counts.get(account.id) ?? 0,
      lastPolledAt: iso(poll?.lastPolledAt ?? null),
      lastError: poll?.lastError ?? null,
    });
  }
  statuses.sort((a, b) => a.accountName.localeCompare(b.accountName));
  return { rows, accounts: statuses };
}
