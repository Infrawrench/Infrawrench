/**
 * The org's flow-collection switch.
 *
 * Deliberately its own tiny store rather than a column somewhere convenient:
 * the switch decides whether Infrawrench runs billable queries in the
 * customer's cloud account, and a setting with that consequence should be
 * findable, auditable and obviously separate from the cost preferences it sits
 * next to on screen.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { orgNetworkFlowSettings } from "../db/schema";

export interface NetworkFlowSettings {
  enabled: boolean;
  initialLookbackDays: number;
}

/**
 * Defaults for an org that has never touched the switch.
 *
 * Off. See the table comment in `db/network-flow-schema.ts` — the query costs
 * the customer money, so consent is explicit and the absence of a row is a
 * "no", never an "unset, assume yes".
 */
export const DEFAULT_NETWORK_FLOW_SETTINGS: NetworkFlowSettings = {
  enabled: false,
  initialLookbackDays: 7,
};

/** Bounds on the lookback, so a typo cannot bill someone for a year of scans. */
export const MIN_INITIAL_LOOKBACK_DAYS = 1;
export const MAX_INITIAL_LOOKBACK_DAYS = 30;

export class NetworkFlowSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkFlowSettingsError";
  }
}

export async function getNetworkFlowSettings(organizationId: string): Promise<NetworkFlowSettings> {
  const rows = await db
    .select()
    .from(orgNetworkFlowSettings)
    .where(eq(orgNetworkFlowSettings.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return { ...DEFAULT_NETWORK_FLOW_SETTINGS };
  return { enabled: row.enabled, initialLookbackDays: row.initialLookbackDays };
}

export async function setNetworkFlowSettings(
  organizationId: string,
  input: NetworkFlowSettings,
  updatedByUserId?: string,
): Promise<NetworkFlowSettings> {
  const lookback = Math.floor(input.initialLookbackDays);
  if (
    !Number.isFinite(lookback) ||
    lookback < MIN_INITIAL_LOOKBACK_DAYS ||
    lookback > MAX_INITIAL_LOOKBACK_DAYS
  ) {
    throw new NetworkFlowSettingsError(
      `initialLookbackDays must be between ${MIN_INITIAL_LOOKBACK_DAYS} and ${MAX_INITIAL_LOOKBACK_DAYS}`,
    );
  }
  const now = new Date();
  await db
    .insert(orgNetworkFlowSettings)
    .values({
      organizationId,
      enabled: input.enabled,
      initialLookbackDays: lookback,
      updatedByUserId: updatedByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: orgNetworkFlowSettings.organizationId,
      set: {
        enabled: input.enabled,
        initialLookbackDays: lookback,
        updatedByUserId: updatedByUserId ?? null,
        updatedAt: now,
      },
    });
  return { enabled: input.enabled, initialLookbackDays: lookback };
}
