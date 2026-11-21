/**
 * The process-wide migration estimate service, wired to the real database,
 * plugin registry, cost data and price catalog. `service.ts` holds the logic
 * and takes these as dependencies so it can be tested without any of them.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { MigrationMoney } from "@infrawrench/client-core";

import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { getOrgAccountClient } from "../org-accounts";
import { getResourceCostTotals } from "../analytics/cost-readers";
import { addDays, isoDay } from "../cost/dates";
import { cachedCreateConfig } from "../cost/carbon";
import { estimateResourceCost } from "../cost/estimate";
import { getOrgCurrencySettings, loadOrgRateBook } from "../cost/currency-settings";
import { getPriceCatalogService } from "../price-catalog";
import { getServiceRecord, resolveServiceMembers } from "../service-catalog/store";
import {
  createMigrationEstimateService,
  type MigrationEstimateService,
  type MigrationSourceResource,
} from "./service";

export {
  createMigrationEstimateService,
  MigrationEstimateInputError,
  MigrationEstimateSourceNotFoundError,
  type MigrationCatalogSlice,
  type MigrationEstimateDeps,
  type MigrationEstimateService,
  type MigrationSourceResource,
} from "./service";
export {
  createMigrationEstimate,
  deleteMigrationEstimate,
  getMigrationEstimate,
  listMigrationEstimates,
  MigrationEstimateLimitError,
  updateMigrationEstimate,
} from "./store";

/** Billed spend is read over this many trailing days. */
const SPEND_WINDOW_DAYS = 30;
/** Far past any one provider's machine list in one region. */
const CATALOG_ROW_LIMIT = 20_000;

let instance: MigrationEstimateService | null = null;

export function getMigrationEstimateService(): MigrationEstimateService {
  if (instance) return instance;
  instance = createMigrationEstimateService({
    listPlugins: async () => (await loadPlugins()).map((l) => l.plugin),
    loadService: async (organizationId, serviceId) => {
      const record = await getServiceRecord(organizationId, serviceId);
      if (!record) return null;
      const members = (await resolveServiceMembers(organizationId, [record])).get(record.id);
      return {
        name: record.name,
        resourceIds: (members?.members ?? []).filter((m) => !m.missing).map((m) => m.resourceId),
      };
    },
    loadResources: async (organizationId, ids): Promise<MigrationSourceResource[]> => {
      const rows = await db
        .select({
          id: resources.id,
          pluginId: resources.pluginId,
          resourceTypeId: resources.resourceTypeId,
          accountId: resources.accountId,
          displayName: resources.displayName,
          externalId: resources.externalId,
          parentResourceId: resources.parentResourceId,
          fields: resources.fieldsJson,
        })
        .from(resources)
        .innerJoin(accounts, eq(accounts.id, resources.accountId))
        .where(
          and(
            eq(resources.organizationId, organizationId),
            inArray(resources.id, ids),
            isNull(resources.deletedAt),
            isNull(accounts.deletedAt),
          ),
        );
      return rows;
    },
    loadSpend: async (organizationId) => {
      // `getResourceCostTotals` reads through `costDailyOrgCondition`, so a
      // request under a cost visibility scope sees only what it allows.
      const to = isoDay(new Date());
      const from = addDays(to, -(SPEND_WINDOW_DAYS - 1));
      const totals = await getResourceCostTotals(organizationId, from, to);
      const out = new Map<string, MigrationMoney[]>();
      for (const t of totals) {
        if (!t.currency) continue;
        const key = `${t.accountId} ${t.resourceId}`;
        const list = out.get(key) ?? [];
        const same = list.find((m) => m.currency === t.currency);
        if (same) same.amount += t.amount;
        else list.push({ amount: t.amount, currency: t.currency });
        out.set(key, list);
      }
      return out;
    },
    estimateExisting: (organizationId, resource) =>
      estimateResourceCost(organizationId, {
        accountId: resource.accountId,
        resourceTypeId: resource.resourceTypeId,
        resourceId: resource.id,
      }),
    catalogRows: async (organizationId, pluginId, region) => {
      const response = await getPriceCatalogService().search(organizationId, {
        pluginIds: [pluginId],
        families: ["compute", "gpu"],
        ...(region ? { region } : {}),
        rateType: "on-demand",
        limit: CATALOG_ROW_LIMIT,
      });
      const status = response.providers.find((p) => p.pluginId === pluginId);
      return {
        state: status?.state ?? "error",
        region: status?.region ?? null,
        rows: response.rows,
      };
    },
    listAccountIds: async (organizationId, pluginId) => {
      const rows = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.organizationId, organizationId),
            eq(accounts.pluginId, pluginId),
            isNull(accounts.deletedAt),
          ),
        )
        .orderBy(asc(accounts.createdAt))
        .limit(5);
      return rows.map((r) => r.id);
    },
    createConfig: (organizationId, accountId, typeId) =>
      cachedCreateConfig(organizationId, accountId, typeId),
    sizePricing: async (organizationId, accountId, typeId, request) => {
      const ctx = await getOrgAccountClient(accountId, organizationId);
      if (!ctx?.client.getCreateSizePricing) return null;
      return ctx.client.getCreateSizePricing(typeId, request);
    },
    estimateTarget: async (organizationId, accountId, typeId, fields) => {
      const ctx = await getOrgAccountClient(accountId, organizationId);
      if (!ctx?.client.estimateCost) return null;
      return ctx.client.estimateCost(typeId, fields);
    },
    loadConverter: async (organizationId) => {
      // The price catalog's stance: an org with a display currency compares
      // in it, at today's rate from its rate book; a currency with no rate
      // stays unconverted (null), which keeps the totals per currency.
      const settings = await getOrgCurrencySettings(organizationId);
      const displayCurrency = settings.displayCurrency;
      if (!displayCurrency) {
        return { displayCurrency: null, convert: (amount, currency) => ({ amount, currency }) };
      }
      const rates = await loadOrgRateBook(organizationId, settings);
      const today = new Date().toISOString().slice(0, 10);
      return {
        displayCurrency,
        convert: (amount, currency) => {
          if (currency === displayCurrency) return { amount, currency };
          const resolved = rates.resolve(currency, displayCurrency, today);
          if (!resolved) return null;
          return { amount: amount * resolved.rate, currency: displayCurrency };
        },
      };
    },
    now: () => Date.now(),
  });
  return instance;
}
