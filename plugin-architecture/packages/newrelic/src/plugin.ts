import type {
  CredentialField,
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import type { NewRelicContext } from "./api.js";
import { isPermissionError, listAccounts } from "./api.js";
import { NewRelicClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { DEFAULT_RATES, RATE_KEYS } from "./rates.js";
import { DEFAULT_REGION_ID, REGION_PICKER, resolveRegion } from "./regions.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { newRelicTerraformExport } from "./terraform.js";

const PRICING_LINK = { label: "New Relic pricing", url: "https://newrelic.com/pricing" };

function rateField(
  key: string,
  label: string,
  description: string,
  defaultValue?: string,
): CredentialField {
  return {
    key,
    label,
    description,
    sensitive: false,
    optional: true,
    ...(defaultValue !== undefined ? { defaultValue } : { placeholder: "No published price" }),
    helpLink: PRICING_LINK,
  };
}

const manifest: PluginManifest = {
  id: "newrelic",
  version: "0.1.0",
  displayName: "New Relic",
  description:
    "Observability platform. Track New Relic spend by product (data ingest, full platform and core users, compute, synthetic checks) and account, and manage APM and browser applications, hosts, synthetic monitors, dashboards, workloads, alert policies and NRQL alert conditions with their metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "region",
      label: "Region",
      description:
        "The data centre region your New Relic organization lives in: the one in the address you sign in at (one.newrelic.com is US, one.eu.newrelic.com is EU). Keys only work in their own region.",
      sensitive: false,
      optional: true,
      defaultValue: DEFAULT_REGION_ID,
      regions: REGION_PICKER,
    },
    {
      key: "apiKey",
      label: "User API Key",
      description:
        "A New Relic user key (it starts with NRAK-). It acts with the permissions of the user it belongs to, so use a user who can read usage in the parent account for cost data. Create one under your user menu, API Keys, Create a key, type User.",
      sensitive: true,
      placeholder: "NRAK-…",
      helpLink: { label: "Manage API keys", url: "https://one.newrelic.com/api-keys" },
    },
    {
      key: "accountId",
      label: "Usage Account",
      description:
        "The account usage and cost are read from. On an organization with several accounts, pick the parent (or reporting) account: New Relic records the usage of all its child accounts there. Resources are listed from every account the key can access.",
      sensitive: false,
      providerOptions: { dependsOn: ["apiKey", "region"] },
      placeholder: "Account ID",
    },
    rateField(
      RATE_KEYS.dataPerGb,
      "Data Ingest Price per GB (USD)",
      "What you pay per GB ingested beyond the free allowance. The list price is $0.40 (Original data option); Data Plus is $0.60, and the EU region adds $0.05. Enter your contract rate if it differs.",
      DEFAULT_RATES.dataPerGb,
    ),
    rateField(
      RATE_KEYS.freeGbPerMonth,
      "Free GB per Month",
      "Data ingest included at no charge each month. New Relic includes 100 GB.",
      DEFAULT_RATES.freeGbPerMonth,
    ),
    rateField(
      RATE_KEYS.fullPlatformUser,
      "Full Platform User Price (USD per month)",
      "List price is $349 on Pro with an annual commitment ($418.80 pay as you go); Standard is $99 per additional user. Enter your contract rate if it differs.",
      DEFAULT_RATES.fullPlatformUser,
    ),
    rateField(
      RATE_KEYS.coreUser,
      "Core User Price (USD per month)",
      "List price is $49 per core user.",
      DEFAULT_RATES.coreUser,
    ),
    rateField(
      RATE_KEYS.coreCcu,
      "Core Compute Price per CCU (USD)",
      "Only for compute-based pricing. New Relic does not publish a CCU price, so compute is left out of cost data until you enter your contract rate.",
    ),
    rateField(
      RATE_KEYS.advancedCcu,
      "Advanced Compute Price per CCU (USD)",
      "Only if you use Advanced Compute. Left out of cost data until you enter your contract rate.",
    ),
    rateField(
      RATE_KEYS.syntheticCheck,
      "Synthetic Check Price (USD)",
      "Price per synthetic check beyond your plan's included checks. List price is $0.005.",
      DEFAULT_RATES.syntheticCheck,
    ),
    caCertCredentialField,
  ],
  costs: {
    // Usage from NrConsumption / NrMTDConsumption in the usage account,
    // priced at the rates above: product -> service, the region -> region,
    // and the consuming account plus the ingest source or compute capability
    // as tags. Monthly charges are spread over the days they accrue on by
    // differencing month-to-date billable amounts (see `cost-data.ts`).
    dimensions: ["service", "region", "tag"],
    maxHistoryDays: 365,
    // Usage lands about three hours late and month-to-date counts move all
    // month; 35 days re-reads the whole of the current month every pass.
    restatementDays: 35,
    estimated: true,
  },
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

/**
 * Options for the usage account picker: every account the user key can see in
 * the chosen region. Runs before an account exists, so it builds its own
 * NerdGraph context from the half-filled form.
 */
async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "accountId") return [];
  const apiKey = (credentials["apiKey"] ?? "").trim();
  if (!apiKey) throw new Error("Enter a user API key first.");
  const caCert = credentials["caCert"] ?? "";
  const ctx: NewRelicContext = {
    apiKey,
    region: resolveRegion(credentials["region"]),
    ...(caCert ? { caCert } : {}),
    ...(services?.http ? { http: services.http } : {}),
  };
  try {
    const accounts = await listAccounts(ctx);
    if (accounts.length === 0) {
      throw new Error(
        `The key can see no accounts in the ${ctx.region.label} region. Check the region, and that this is a user key (NRAK-…).`,
      );
    }
    return accounts.map((a) => ({ id: String(a.id), label: a.name, description: String(a.id) }));
  } catch (err) {
    if (isPermissionError(err)) {
      throw new Error(
        `New Relic rejected the key in the ${ctx.region.label} region. Check that it is a user key (NRAK-…) and that the region matches the one you sign in to.`,
      );
    }
    throw err;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new NewRelicClient(credentials, services),
  parseStatusFeed,
  terraformExport: newRelicTerraformExport,
  listCredentialOptions,
};
