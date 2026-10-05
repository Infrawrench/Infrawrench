/**
 * The process-wide price catalog service, wired to the real database, plugin
 * registry and HTTP plumbing. `service.ts` holds the logic and takes these as
 * dependencies so it can be tested without any of them.
 */
import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { accounts } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { getOrgAccountClient } from "../org-accounts";
import { buildPluginHostServices } from "../host-services";
import { runInEgressScope } from "../egress-guard";
import { getOrgCurrencySettings, loadOrgRateBook } from "../cost/currency-settings";
import { createPriceCatalogService, type PriceCatalogService } from "./service";

export {
  createPriceCatalogService,
  PriceCatalogNotFoundError,
  PriceCatalogQueryError,
  type PriceCatalogDeps,
  type PriceCatalogService,
} from "./service";

let instance: PriceCatalogService | null = null;

export function getPriceCatalogService(): PriceCatalogService {
  if (instance) return instance;
  instance = createPriceCatalogService({
    listPlugins: async () => (await loadPlugins()).map((l) => l.plugin),
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
    getClient: async (accountId, organizationId) =>
      (await getOrgAccountClient(accountId, organizationId))?.client ?? null,
    runPublicFetch: async (plugin, organizationId, fn) => {
      // No credentials and no account: the host's HTTP service still gives
      // the plugin the guarded dispatcher, and the egress scope covers a
      // plugin that calls the global fetch itself.
      const services = await buildPluginHostServices(plugin.manifest, {}, { organizationId });
      const bound = {
        ...plugin,
        fetchPriceCatalog: (request: Parameters<NonNullable<typeof plugin.fetchPriceCatalog>>[0]) =>
          plugin.fetchPriceCatalog!(request, services),
      };
      return runInEgressScope({ organizationId }, () => fn(bound));
    },
    loadConverter: async (organizationId) => {
      // The catalog is a new surface with no pre-conversion behaviour to
      // preserve, so an org that configured a display currency compares in
      // it, at today's rate from the org's rate book: its stated rates first,
      // then the ECB feed when automatic rates are on, the same precedence as
      // every other converter. Still "unconverted" (null) for a currency with
      // no rate either way.
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
