import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  Api,
  NeonAuthIntegration,
  NeonAuthOauthProvider,
  NeonAuthPluginConfigs,
  NeonAuthRedirectURIWhitelistDomain,
  ProjectListItem,
} from "@neondatabase/api-client";
import { enumerateBranches, isServiceUnavailable, resourceId, type BranchRef } from "./common.js";

/** Neon Auth config spread across several endpoints, gathered for one branch. */
export interface AuthSnapshot {
  integration: NeonAuthIntegration;
  plugins?: NeonAuthPluginConfigs;
}

/**
 * `GET /auth/plugins` returns every sub-config in one payload — oauth providers,
 * email/password, magic link, organization, phone, allow_localhost — so a single
 * call backs both the auth detail view and the child resource listings.
 */
export async function fetchAuthSnapshot(
  api: Api<unknown>,
  ref: BranchRef,
): Promise<AuthSnapshot | undefined> {
  let integration: NeonAuthIntegration;
  try {
    const resp = await api.getNeonAuth(ref.projectId, ref.branchId);
    integration = resp.data;
  } catch (err) {
    // Auth simply isn't enabled on this branch.
    if (isServiceUnavailable(err)) return undefined;
    throw err;
  }

  let plugins: NeonAuthPluginConfigs | undefined;
  try {
    const resp = await api.getNeonAuthPluginConfigs(ref.projectId, ref.branchId);
    plugins = resp.data;
  } catch (err) {
    if (!isServiceUnavailable(err)) throw err;
  }

  return plugins ? { integration, plugins } : { integration };
}

export function buildAuthResource(
  accountId: string,
  ref: BranchRef,
  snapshot: AuthSnapshot,
): ResourceInstance {
  const externalId = `${ref.projectId}/${ref.branchId}`;
  const { integration, plugins } = snapshot;

  return {
    id: resourceId(accountId, "neon-auth", externalId),
    pluginId: "neon",
    resourceTypeId: "neon-auth",
    accountId,
    displayName: integration.name ?? "Auth",
    fields: {
      authProvider: integration.auth_provider,
      projectId: ref.projectId,
      branchId: ref.branchId,
      databaseName: integration.db_name,
      jwksUrl: integration.jwks_url,
      baseUrl: integration.base_url ?? "",
      emailAndPassword: plugins?.email_and_password?.enabled ?? false,
      allowLocalhost: plugins?.allow_localhost ?? false,
      createdAt: integration.created_at,
    },
    resolvedOutputs: {
      jwksUrl: integration.jwks_url,
      baseUrl: integration.base_url ?? "",
      projectId: ref.projectId,
      branchId: ref.branchId,
    },
    secretStates: [],
    externalId,
    parentResourceId: resourceId(accountId, "neon-branch", externalId),
    createdAt: integration.created_at,
    updatedAt: integration.created_at,
  };
}

export async function listAllAuth(
  api: Api<unknown>,
  accountId: string,
  projects: ProjectListItem[],
): Promise<ResourceInstance[]> {
  const branches = await enumerateBranches(api, projects);
  const results: ResourceInstance[] = [];

  for (const ref of branches) {
    const snapshot = await fetchAuthSnapshot(api, ref);
    if (snapshot) results.push(buildAuthResource(accountId, ref, snapshot));
  }
  return results;
}

export function buildOauthProviderResource(
  accountId: string,
  ref: BranchRef,
  provider: NeonAuthOauthProvider,
): ResourceInstance {
  const externalId = `${ref.projectId}/${ref.branchId}/${provider.id}`;
  return {
    id: resourceId(accountId, "neon-auth-oauth-provider", externalId),
    pluginId: "neon",
    resourceTypeId: "neon-auth-oauth-provider",
    accountId,
    displayName: provider.id,
    fields: {
      providerId: provider.id,
      type: provider.type,
      clientId: provider.client_id ?? "",
      projectId: ref.projectId,
      branchId: ref.branchId,
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    parentResourceId: resourceId(accountId, "neon-auth", `${ref.projectId}/${ref.branchId}`),
    createdAt: "",
    updatedAt: "",
  };
}

export async function listAllOauthProviders(
  api: Api<unknown>,
  accountId: string,
  projects: ProjectListItem[],
): Promise<ResourceInstance[]> {
  const branches = await enumerateBranches(api, projects);
  const results: ResourceInstance[] = [];

  for (const ref of branches) {
    try {
      const resp = await api.listBranchNeonAuthOauthProviders(ref.projectId, ref.branchId);
      for (const provider of resp.data.providers) {
        results.push(buildOauthProviderResource(accountId, ref, provider));
      }
    } catch (err) {
      // Auth not enabled on this branch.
      if (!isServiceUnavailable(err)) throw err;
    }
  }
  return results;
}

export function buildDomainResource(
  accountId: string,
  ref: BranchRef,
  entry: NeonAuthRedirectURIWhitelistDomain,
): ResourceInstance {
  const domain = entry.domain;
  const externalId = `${ref.projectId}/${ref.branchId}/${domain}`;
  return {
    id: resourceId(accountId, "neon-auth-domain", externalId),
    pluginId: "neon",
    resourceTypeId: "neon-auth-domain",
    accountId,
    displayName: domain,
    fields: {
      domain,
      authProvider: entry.auth_provider,
      projectId: ref.projectId,
      branchId: ref.branchId,
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    parentResourceId: resourceId(accountId, "neon-auth", `${ref.projectId}/${ref.branchId}`),
    createdAt: "",
    updatedAt: "",
  };
}

export async function listAllAuthDomains(
  api: Api<unknown>,
  accountId: string,
  projects: ProjectListItem[],
): Promise<ResourceInstance[]> {
  const branches = await enumerateBranches(api, projects);
  const results: ResourceInstance[] = [];

  for (const ref of branches) {
    try {
      const resp = await api.listBranchNeonAuthTrustedDomains(ref.projectId, ref.branchId);
      for (const entry of resp.data.domains) {
        results.push(buildDomainResource(accountId, ref, entry));
      }
    } catch (err) {
      if (!isServiceUnavailable(err)) throw err;
    }
  }
  return results;
}
