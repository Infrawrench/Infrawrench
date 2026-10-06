import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { RenderApi } from "./api.js";
import { RenderClient } from "./client.js";
import { isStatus } from "./kit.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { renderTerraformExport } from "./terraform.js";
import type { RenderOwner } from "./types.js";

const manifest: PluginManifest = {
  id: "render",
  version: "0.1.0",
  displayName: "Render",
  description:
    "Cloud application platform. Manage web services, private services, workers, cron jobs and static sites with deploys, rollbacks, scaling and logs, plus Render Postgres, Key Value, disks, environment groups, custom domains, projects and Blueprints.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Render API key from Account Settings, API Keys. Keys are per user and carry that user's access to every workspace they belong to; Render keys have no scopes.",
      sensitive: true,
      placeholder: "rnd_...",
      helpLink: {
        label: "Create a Render API key",
        url: "https://dashboard.render.com/u/settings#api-keys",
      },
    },
    {
      key: "workspaceId",
      label: "Workspace",
      description:
        "Limit this account to one workspace. Leave on All workspaces to see everything the key can reach.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["apiKey"], emptyLabel: "All workspaces" },
    },
    caCertCredentialField,
  ],
  // 400 GETs a minute per user; the poller fans out per service.
  rateLimit: { capacity: 40, refillPerSecond: 5 },
  statusFeed,
};

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "workspaceId") return [];
  const apiKey = (credentials["apiKey"] ?? "").trim();
  if (!apiKey) throw new Error("Enter a Render API key first.");
  const api = new RenderApi(apiKey, credentials["caCert"] ?? "", services);
  try {
    const owners = await api.listAll<RenderOwner>("/owners", "owner");
    return owners.map((o) => ({
      id: o.id,
      label: o.name || o.email || o.id,
      description: `${o.type === "team" ? "Team" : "Personal"} · ${o.id}`,
    }));
  } catch (e) {
    if (isStatus(e, 401, 403)) throw new Error("Render rejected the API key.");
    throw e;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new RenderClient(credentials, RESOURCE_TYPES, services),
  parseStatusFeed,
  terraformExport: renderTerraformExport,
  listCredentialOptions,
};
