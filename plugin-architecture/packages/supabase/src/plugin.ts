import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { SupabaseClient } from "./client.js";
import { SUPABASE_LOGO } from "./logo.js";
import { SUPABASE_PREFLIGHT } from "./preflight.js";
import { resourceTypes } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { supabaseTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "supabase",
  version: "0.1.0",
  displayName: "Supabase",
  description:
    "Supabase projects, branches, Edge Functions, Storage, Auth, API keys, backups and database settings through the Management API.",
  logoSvg: SUPABASE_LOGO,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessToken",
      label: "Access Token",
      description:
        "A Supabase personal access token. Create one in the Supabase dashboard under Account > Access Tokens. A classic token works across every organization you belong to; a scoped token needs at least organizations:read and projects:read, plus secrets, edge_functions, database, storage, auth and analytics read/write scopes for the matching features.",
      sensitive: true,
      placeholder: "sbp_...",
      helpLink: {
        label: "Create an access token",
        url: "https://supabase.com/dashboard/account/tokens",
      },
    },
    caCertCredentialField,
  ],
  // 120 requests a minute per user and per project/organization scope.
  rateLimit: { capacity: 20, refillPerSecond: 2 },
  // Supabase has no billing or invoice API. The only money in the
  // Management API is each project's selected add-ons with list prices, so
  // the rows are an estimate of today's add-on spend (see cost-data.ts).
  costs: {
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 1,
    restatementDays: 1,
    estimated: true,
    focus: { default: { category: "Databases", subcategory: "Relational Databases" } },
  },
  quotas: {
    label: "Database disk",
    partial: true,
    increaseUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
  },
  statusFeed,
  preflight: SUPABASE_PREFLIGHT,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new SupabaseClient(credentials, services),
  parseStatusFeed,
  terraformExport: supabaseTerraformExport,
};
