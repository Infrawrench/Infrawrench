import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import type { CircleContext } from "./api.js";
import { circleFetch, isPermissionError } from "./api.js";
import { CircleCIClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import type { CircleCollaboration } from "./mappers.js";
import { DEFAULT_PRICE_PER_CREDIT, RATE_KEYS } from "./rates.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const PRICING_LINK = { label: "CircleCI pricing", url: "https://circleci.com/pricing/" };

const manifest: PluginManifest = {
  id: "circleci",
  version: "0.1.0",
  displayName: "CircleCI",
  description:
    "Continuous integration and delivery. Track estimated CircleCI spend by project, resource class and executor, and manage projects, workflows with Insights metrics, pipelines, contexts, variables, schedules, triggers and self-hosted runners.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "Personal API Token",
      description:
        "A personal API token (User Settings, Personal API Tokens). It acts as your user, so it sees the organizations and projects you can. Cost needs a user who can see the organization's plan usage, normally an organization admin. Project API tokens do not work with the API this plugin uses. Personal tokens can expire: CircleCI emails you beforehand, and Edit credentials takes the new one.",
      sensitive: true,
      placeholder: "Personal API token",
      helpLink: {
        label: "Managing API tokens",
        url: "https://circleci.com/docs/guides/toolkit/managing-api-tokens/",
      },
    },
    {
      key: "organization",
      label: "Organization",
      description:
        "The CircleCI organization to manage. The list shows every organization your user belongs to.",
      sensitive: false,
      providerOptions: { dependsOn: ["apiToken"] },
      placeholder: "Organization ID",
    },
    {
      key: RATE_KEYS.pricePerCredit,
      label: "Price per Credit (USD)",
      description:
        "What one credit costs you, used to turn credits into money. The published price is $0.0006 ($15 for 25,000 credits); enter your contract rate if it differs.",
      sensitive: false,
      optional: true,
      defaultValue: String(DEFAULT_PRICE_PER_CREDIT),
      helpLink: PRICING_LINK,
    },
    {
      key: RATE_KEYS.includedCredits,
      label: "Credits Included per Month",
      description:
        "Credits your plan gives you each month at no charge, priced at zero until the month's usage passes them. 30,000 on the Free plan; leave 0 when every credit is billed.",
      sensitive: false,
      optional: true,
      defaultValue: "0",
      helpLink: PRICING_LINK,
    },
  ],
  costs: {
    // Usage export credits priced at the rate above: the kind of credit
    // (compute, Docker layer caching, storage, network, users…) -> service,
    // with project, resource class and executor as tags.
    dimensions: ["service", "tag"],
    // Each month is one usage export and CircleCI allows about 10 an hour per
    // organization, so the first backfill stays at seven.
    maxHistoryDays: 180,
    // Re-read the whole current month (and the end of the previous one) so
    // the included-credit allowance and late usage are absorbed.
    restatementDays: 35,
    estimated: true,
  },
  statusFeed,
  // 5,000 requests an hour per token across the v2 API; stay well under it.
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

/**
 * Options for the organization picker: every organization the token's user
 * belongs to (`GET /me/collaborations`). Runs before an account exists, so it
 * builds its own context.
 */
async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "organization") return [];
  const token = (credentials["apiToken"] ?? "").trim();
  if (!token) throw new Error("Enter a personal API token first.");
  const ctx: CircleContext = { token, ...(services?.http ? { http: services.http } : {}) };
  try {
    const orgs = await circleFetch<CircleCollaboration[]>(ctx, "/me/collaborations");
    if (!orgs || orgs.length === 0) {
      throw new Error("The token's user belongs to no CircleCI organizations.");
    }
    return orgs
      .map((o) => ({
        id: o.id || o.slug,
        label: o.name,
        description: o.slug,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    if (isPermissionError(err)) {
      throw new Error(
        "CircleCI rejected the token. Check that it is a personal API token, not a project token.",
      );
    }
    throw err;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new CircleCIClient(credentials, services),
  parseStatusFeed,
  listCredentialOptions,
};
