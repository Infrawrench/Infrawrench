import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { HerokuApi } from "./api.js";
import { HerokuClient } from "./client.js";
import { isStatus } from "./kit.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { herokuRemediationCommands } from "./remediation.js";
import { herokuTerraformExport } from "./terraform.js";
import type { HkTeam } from "./types.js";

const manifest: PluginManifest = {
  id: "heroku",
  version: "0.1.0",
  displayName: "Heroku",
  description:
    "Application platform. Manage apps, dyno formations and scaling, releases with rollback, config vars, add-ons and plans, domains and SSL certificates, pipelines with promotions and review apps, log drains and Private Spaces, with logs, invoices and credits.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Your Heroku API key from Account settings, API Key (Reveal), or a long-lived token from `heroku authorizations:create`. It acts with your account's access to every personal and team app.",
      sensitive: true,
      placeholder: "HRKU-...",
      helpLink: {
        label: "Open Heroku account settings",
        url: "https://dashboard.heroku.com/account",
      },
    },
    {
      key: "team",
      label: "Team",
      description: "Limit this account to one team's apps, or leave on Personal and all teams.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["apiKey"], emptyLabel: "Personal and all teams" },
    },
    caCertCredentialField,
  ],
  // 4,500 requests an hour per user.
  rateLimit: { capacity: 30, refillPerSecond: 1.2 },
  costs: {
    dimensions: ["service", "tag"],
    periodNative: true,
    restatementDays: 62,
    maxHistoryDays: 730,
    chargeTypes: true,
  },
  credits: {
    label: "Heroku credits",
    topUpUrl: "https://dashboard.heroku.com/account/billing",
  },
  statusFeed,
};

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "team") return [];
  const key = (credentials["apiKey"] ?? "").trim();
  if (!key) throw new Error("Enter a Heroku API key first.");
  const api = new HerokuApi(key, credentials["caCert"] ?? "", services);
  try {
    const teams = await api.listAll<HkTeam>("/teams");
    return teams.map((t) => ({
      id: t.id,
      label: t.name,
      description: t.role ? `Your role: ${t.role}` : t.id,
    }));
  } catch (e) {
    if (isStatus(e, 401, 403)) throw new Error("Heroku rejected the API key.");
    throw e;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new HerokuClient(credentials, RESOURCE_TYPES, services),
  parseStatusFeed,
  terraformExport: herokuTerraformExport,
  listCredentialOptions,
  remediationCommands: herokuRemediationCommands,
};
