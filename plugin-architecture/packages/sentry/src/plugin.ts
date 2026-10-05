import type {
  CredentialField,
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import type { SentryContext } from "./api.js";
import { isPermissionError, sentryPaged } from "./api.js";
import { SentryClient, assertUsableToken } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import type { SentryOrganization } from "./mappers.js";
import { SENTRY_PREFLIGHT, sentryPolicyTemplate } from "./preflight.js";
import { DEFAULT_RATES, RATE_KEYS } from "./rates.js";
import { DEFAULT_REGION_ID, REGION_PICKER, resolveInstance } from "./regions.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { sentryTerraformExport } from "./terraform.js";

const PRICING_LINK = { label: "Sentry pricing", url: "https://docs.sentry.io/pricing/" };

function rateField(
  key: keyof typeof RATE_KEYS,
  label: string,
  description: string,
): CredentialField {
  const defaultValue = DEFAULT_RATES[key];
  return {
    key: RATE_KEYS[key],
    label,
    description,
    sensitive: false,
    optional: true,
    ...(defaultValue !== undefined ? { defaultValue } : { placeholder: "No published price" }),
    helpLink: PRICING_LINK,
  };
}

const manifest: PluginManifest = {
  id: "sentry",
  version: "0.1.0",
  displayName: "Sentry",
  description:
    "Error and performance monitoring. Track estimated Sentry spend by data category and project, and manage projects, teams, releases, issues, client keys, alerts and monitors with their metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "region",
      label: "Region",
      description:
        "Where your Sentry organization's data is stored: US or DE (EU data residency) on sentry.io, or Self-hosted for your own install. Organization settings, General Settings, shows the data storage location.",
      sensitive: false,
      optional: true,
      defaultValue: DEFAULT_REGION_ID,
      regions: REGION_PICKER,
      helpLink: {
        label: "Data storage location",
        url: "https://docs.sentry.io/organization/data-storage-location/",
      },
    },
    {
      key: "baseUrl",
      label: "Self-hosted URL",
      description:
        "Only for a self-hosted Sentry: the address you open Sentry at, e.g. https://sentry.example.com. Leave empty on sentry.io.",
      sensitive: false,
      optional: true,
      placeholder: "https://sentry.example.com",
    },
    {
      key: "authToken",
      label: "Auth Token",
      description:
        "An internal integration token (Settings, Developer Settings, New Internal Integration; it starts with sntryi_) or a personal token (User Settings, Personal Tokens; sntryu_). Grant Organization, Project, Team, Issue & Event, Release and Alerts permissions: Read for read-only, Read & Write for actions. Organization tokens (sntrys_) cannot be used.",
      sensitive: true,
      placeholder: "sntryi_…",
      helpLink: {
        label: "Sentry auth tokens",
        url: "https://docs.sentry.io/account/auth-tokens/",
      },
    },
    {
      key: "organization",
      label: "Organization",
      description:
        "The Sentry organization to manage. The list shows every organization the token can see in the chosen region.",
      sensitive: false,
      providerOptions: { dependsOn: ["authToken", "region"] },
      placeholder: "Organization slug",
    },
    rateField(
      "planFee",
      "Plan Fee (USD per month)",
      "Your plan's monthly base fee, written on the 1st of each month. List price is $26 for Team and $80 for Business (annual billing). Enter 0 on the free Developer plan.",
    ),
    rateField(
      "errorPrice",
      "Price per Error (USD)",
      "Pay-as-you-go price for each accepted error beyond the included volume. List price is $0.0003625 on Team and $0.0011125 on Business; enter your reserved or contract rate if it differs.",
    ),
    rateField(
      "errorsIncluded",
      "Errors Included per Month",
      "Errors your plan includes each month (50,000 on Team and Business, plus any reserved volume you bought).",
    ),
    rateField(
      "spanPrice",
      "Price per Span (USD)",
      "Pay-as-you-go price for each accepted span beyond the included volume. List price is $0.000002 on Team and $0.000004 on Business.",
    ),
    rateField(
      "spansIncluded",
      "Spans Included per Month",
      "Spans your plan includes each month (5,000,000, plus any reserved volume).",
    ),
    rateField(
      "transactionPrice",
      "Price per Transaction (USD)",
      "Only for older plans billed by transaction instead of span. Sentry no longer publishes a price, so transactions are left out of cost until you enter your contract rate.",
    ),
    rateField(
      "replayPrice",
      "Price per Replay (USD)",
      "Pay-as-you-go price for each accepted session replay beyond the included volume. List price is $0.00375.",
    ),
    rateField(
      "replaysIncluded",
      "Replays Included per Month",
      "Replays your plan includes each month (50, plus any reserved volume).",
    ),
    rateField(
      "attachmentPricePerGb",
      "Attachment Price per GB (USD)",
      "Pay-as-you-go price per GB of attachments beyond the included volume. List price is $0.3125.",
    ),
    rateField(
      "attachmentGbIncluded",
      "Attachment GB Included per Month",
      "Attachment storage your plan includes each month (1 GB, plus any reserved volume).",
    ),
    rateField(
      "logPricePerGb",
      "Log Price per GB (USD)",
      "Price per GB of logs beyond the included volume. List price is $0.50.",
    ),
    rateField(
      "logGbIncluded",
      "Log GB Included per Month",
      "Logs your plan includes each month (5 GB).",
    ),
    rateField(
      "continuousProfilingPricePerHour",
      "Continuous Profiling Price per Hour (USD)",
      "Price per profile hour of continuous (backend) profiling. List price is $0.0315.",
    ),
    rateField(
      "uiProfilingPricePerHour",
      "UI Profiling Price per Hour (USD)",
      "Price per profile hour of UI (browser and mobile) profiling. List price is $0.25.",
    ),
    rateField(
      "cronMonitorPrice",
      "Price per Cron Monitor (USD per month)",
      "Price per active cron monitor each month beyond the included ones. List price is $0.78. Paused monitors are not billed.",
    ),
    rateField(
      "cronMonitorsIncluded",
      "Cron Monitors Included",
      "Cron monitors your plan includes (1).",
    ),
    rateField(
      "uptimeMonitorPrice",
      "Price per Uptime Monitor (USD per month)",
      "Price per active uptime monitor each month beyond the included ones. List price is $1.00.",
    ),
    rateField(
      "uptimeMonitorsIncluded",
      "Uptime Monitors Included",
      "Uptime monitors your plan includes (1).",
    ),
    caCertCredentialField,
  ],
  costs: {
    // Accepted usage from stats_v2 priced at the rates above: data category
    // -> service, the region -> region, the project as a tag. The plan fee
    // and monitors are dated to the 1st of the month they bill (see
    // `cost-data.ts`).
    dimensions: ["service", "region", "tag"],
    // stats_v2 reaches back 90 days.
    maxHistoryDays: 90,
    // Month-to-date differencing: 35 days re-reads the whole current month.
    restatementDays: 35,
    estimated: true,
  },
  preflight: SENTRY_PREFLIGHT,
  statusFeed,
  // Sentry limits per caller and endpoint (about 40 requests a second on most
  // endpoints, 20 on stats_v2); stay well under it.
  rateLimit: { capacity: 10, refillPerSecond: 5 },
};

/**
 * Options for the organization picker: every organization the token can see
 * in the chosen region (organization listing is per region on sentry.io).
 * Runs before an account exists, so it builds its own context.
 */
async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "organization") return [];
  const token = (credentials["authToken"] ?? "").trim();
  if (!token) throw new Error("Enter an auth token first.");
  assertUsableToken(token);
  const caCert = credentials["caCert"] ?? "";
  const ctx: SentryContext = {
    token,
    instance: resolveInstance(credentials["region"], credentials["baseUrl"]),
    ...(caCert ? { caCert } : {}),
    ...(services?.http ? { http: services.http } : {}),
  };
  try {
    const orgs = await sentryPaged<SentryOrganization>(ctx, "/organizations/", {}, 5);
    if (orgs.length === 0) {
      throw new Error(
        `The token can see no organizations in the ${ctx.instance.label} region. Check the region (Organization Settings shows the data storage location).`,
      );
    }
    return orgs
      .map((o) => ({ id: o.slug, label: o.name ?? o.slug, description: o.slug }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    if (isPermissionError(err)) {
      throw new Error(
        "Sentry rejected the token. Check that it is an internal integration or personal token with the org:read scope.",
      );
    }
    throw err;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new SentryClient(credentials, services),
  parseStatusFeed,
  policyTemplate: sentryPolicyTemplate,
  terraformExport: sentryTerraformExport,
  listCredentialOptions,
};
