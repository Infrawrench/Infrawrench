/**
 * Maps environment variables to plugin credential objects.
 * Returns undefined for a plugin when its required env vars are not set,
 * signalling the runner to skip that provider.
 */

import { readFileSync, existsSync } from "node:fs";

interface CredentialMapping {
  pluginId: string;
  /** Map from plugin credential key → env var name */
  envMap: Record<string, string>;
  /** Keys that must all be present for the test to run */
  required: string[];
}

const MAPPINGS: CredentialMapping[] = [
  {
    pluginId: "aws",
    envMap: {
      accessKeyId: "AWS_ACCESS_KEY_ID",
      secretAccessKey: "AWS_SECRET_ACCESS_KEY",
      region: "AWS_REGION",
    },
    required: ["accessKeyId", "secretAccessKey"],
  },
  {
    pluginId: "gcp",
    envMap: {
      serviceAccountJson: "GCP_SERVICE_ACCOUNT_JSON",
      project: "GCP_PROJECT",
    },
    required: ["serviceAccountJson"],
  },
  {
    pluginId: "azure",
    envMap: {
      tenantId: "AZURE_TENANT_ID",
      clientId: "AZURE_CLIENT_ID",
      clientSecret: "AZURE_CLIENT_SECRET",
      subscriptionId: "AZURE_SUBSCRIPTION_ID",
    },
    required: ["tenantId", "clientId", "clientSecret", "subscriptionId"],
  },
  {
    pluginId: "digitalocean",
    envMap: { apiToken: "DIGITALOCEAN_API_TOKEN" },
    required: ["apiToken"],
  },
  {
    pluginId: "hetzner",
    envMap: { apiToken: "HETZNER_API_TOKEN" },
    required: ["apiToken"],
  },
  {
    pluginId: "scaleway",
    envMap: {
      accessKey: "SCALEWAY_ACCESS_KEY",
      secretKey: "SCALEWAY_SECRET_KEY",
      defaultProjectId: "SCALEWAY_DEFAULT_PROJECT_ID",
    },
    required: ["accessKey", "secretKey", "defaultProjectId"],
  },
  {
    pluginId: "ovh",
    envMap: {
      applicationKey: "OVH_APPLICATION_KEY",
      applicationSecret: "OVH_APPLICATION_SECRET",
      consumerKey: "OVH_CONSUMER_KEY",
      endpoint: "OVH_ENDPOINT",
      projectId: "OVH_PROJECT_ID",
    },
    required: ["applicationKey", "applicationSecret", "consumerKey", "projectId"],
  },
  {
    pluginId: "cloudflare",
    envMap: { apiToken: "CLOUDFLARE_API_TOKEN" },
    required: ["apiToken"],
  },
  {
    pluginId: "neon",
    envMap: { apiKey: "NEON_API_KEY" },
    required: ["apiKey"],
  },
  {
    pluginId: "planetscale",
    envMap: {
      serviceTokenId: "PLANETSCALE_SERVICE_TOKEN_ID",
      serviceTokenSecret: "PLANETSCALE_SERVICE_TOKEN_SECRET",
      organizationName: "PLANETSCALE_ORGANIZATION_NAME",
    },
    required: ["serviceTokenId", "serviceTokenSecret", "organizationName"],
  },
  {
    pluginId: "turso",
    envMap: {
      apiToken: "TURSO_API_TOKEN",
      organizationName: "TURSO_ORGANIZATION_NAME",
    },
    required: ["apiToken", "organizationName"],
  },
  {
    pluginId: "databricks",
    envMap: {
      host: "DATABRICKS_HOST",
      token: "DATABRICKS_TOKEN",
    },
    required: ["host", "token"],
  },
  {
    pluginId: "postgres",
    envMap: { connectionString: "POSTGRES_CONNECTION_STRING" },
    required: ["connectionString"],
  },
  {
    pluginId: "mysql",
    envMap: { connectionString: "MYSQL_CONNECTION_STRING" },
    required: ["connectionString"],
  },
  {
    pluginId: "mongodb",
    envMap: { connectionString: "MONGODB_CONNECTION_STRING" },
    required: ["connectionString"],
  },
  {
    pluginId: "redis",
    envMap: { connectionString: "REDIS_CONNECTION_STRING" },
    required: ["connectionString"],
  },
  {
    pluginId: "memcached",
    envMap: { connectionString: "MEMCACHED_CONNECTION_STRING" },
    required: ["connectionString"],
  },
  {
    pluginId: "docker",
    envMap: { dockerHost: "DOCKER_HOST" },
    required: ["dockerHost"],
  },
  {
    pluginId: "ssh",
    envMap: {
      host: "SSH_HOST",
      port: "SSH_PORT",
      username: "SSH_USERNAME",
      privateKey: "SSH_PRIVATE_KEY",
    },
    required: ["host", "username", "privateKey"],
  },
  {
    pluginId: "kubernetes",
    envMap: { kubeconfig: "KUBECONFIG" },
    required: ["kubeconfig"],
  },
];

export interface ResolvedCredentials {
  pluginId: string;
  credentials: Record<string, string>;
}

/**
 * Resolve environment variables into plugin credentials.
 * Only returns entries for providers whose required env vars are all set.
 */
export function resolveCredentials(): ResolvedCredentials[] {
  const results: ResolvedCredentials[] = [];

  for (const mapping of MAPPINGS) {
    const creds: Record<string, string> = {};
    let allPresent = true;

    for (const [credKey, envVar] of Object.entries(mapping.envMap)) {
      const value = process.env[envVar];
      if (value) {
        creds[credKey] = value;
      } else if (mapping.required.includes(credKey)) {
        allPresent = false;
        break;
      }
    }

    // Fill in defaults for non-required keys
    if (allPresent) {
      for (const [credKey, envVar] of Object.entries(mapping.envMap)) {
        if (!(credKey in creds)) {
          const value = process.env[envVar];
          if (value) creds[credKey] = value;
        }
      }
      // Special handling: if KUBECONFIG points to a file, read its contents
      if (mapping.pluginId === "kubernetes" && creds["kubeconfig"]) {
        const kc = creds["kubeconfig"];
        if (!kc.includes("\n") && existsSync(kc)) {
          creds["kubeconfig"] = readFileSync(kc, "utf-8");
        }
      }

      // Special handling: if GCP_SERVICE_ACCOUNT_JSON points to a file, read it
      if (mapping.pluginId === "gcp" && creds["serviceAccountJson"]) {
        const saj = creds["serviceAccountJson"];
        if (!saj.startsWith("{") && existsSync(saj)) {
          creds["serviceAccountJson"] = readFileSync(saj, "utf-8");
        }
      }

      results.push({ pluginId: mapping.pluginId, credentials: creds });
    }
  }

  return results;
}

/** Get the full list of plugin IDs that have credential mappings defined */
export function allPluginIds(): string[] {
  return MAPPINGS.map((m) => m.pluginId);
}
