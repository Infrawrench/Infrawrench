/**
 * Azure Container Registry — artifact listing.
 *
 * Goes through the three-step OAuth dance (AAD → ACR refresh → ACR access)
 * documented at https://learn.microsoft.com/en-us/azure/container-registry/container-registry-authentication
 * to obtain a bearer token usable against the Docker Registry HTTP API v2.
 */
import type { ArtifactEntry } from "@infrawrench/plugin-base";
import { fetchAcrAccessToken, type AzureCredentials } from "./auth.js";
import { ARM, type AzureHttpContext } from "./shared.js";

async function getAcrBearerToken(creds: AzureCredentials, loginServer: string): Promise<string> {
  // Step 1: AAD token scoped to containerregistry.azure.net
  const aadToken = await fetchAcrAccessToken(creds);

  // Step 2: Exchange AAD token for an ACR refresh token
  const exchangeBody = new URLSearchParams({
    grant_type: "access_token",
    service: loginServer,
    tenant: creds.tenantId,
    access_token: aadToken,
  });
  const exchangeRes = await fetch(`https://${loginServer}/oauth2/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: exchangeBody.toString(),
  });
  if (!exchangeRes.ok) {
    throw new Error(`ACR token exchange failed: ${exchangeRes.status} ${await exchangeRes.text()}`);
  }
  const exchangeData = (await exchangeRes.json()) as { refresh_token: string };

  // Step 3: Exchange refresh token for an ACR access token
  const tokenBody = new URLSearchParams({
    grant_type: "refresh_token",
    service: loginServer,
    scope: "registry:catalog:* repository:*:pull repository:*:metadata_read",
    refresh_token: exchangeData.refresh_token,
  });
  const tokenRes = await fetch(`https://${loginServer}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  if (!tokenRes.ok) {
    throw new Error(`ACR token grant failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokenData = (await tokenRes.json()) as { access_token: string };
  return tokenData.access_token;
}

export async function listAcrArtifacts(
  ctx: AzureHttpContext,
  creds: AzureCredentials,
  typeId: string,
  resourceId: string,
  accountId: string,
  params?: { pageToken?: string; prefix?: string },
): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> {
  if (typeId !== "azure-container-registry") {
    throw new Error(`listArtifacts not supported for type ${typeId}`);
  }
  const marker = `${accountId}:${typeId}:`;
  const externalId = resourceId.startsWith(marker) ? resourceId.slice(marker.length) : resourceId;
  const [rg, name] = externalId.split("/");
  if (!rg || !name) {
    throw new Error(`Invalid azure-container-registry resource id: ${resourceId}`);
  }
  const registry = await ctx.get<{ properties?: { loginServer?: string } }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerRegistry/registries/${name}?api-version=2023-07-01`,
  );
  const loginServer = registry.properties?.loginServer ?? `${name}.azurecr.io`;

  const bearer = await getAcrBearerToken(creds, loginServer);
  const authHeaders = { Authorization: `Bearer ${bearer}` };

  // Page through the catalog
  const catalogUrl = new URL(`https://${loginServer}/v2/_catalog`);
  catalogUrl.searchParams.set("n", "50");
  if (params?.pageToken) catalogUrl.searchParams.set("last", params.pageToken);
  const catalogRes = await fetch(catalogUrl.toString(), { headers: authHeaders });
  if (!catalogRes.ok) {
    throw new Error(`ACR catalog failed: ${catalogRes.status} ${await catalogRes.text()}`);
  }
  const catalog = (await catalogRes.json()) as { repositories?: string[] };
  const repos = catalog.repositories ?? [];

  const prefix = params?.prefix?.trim();
  const filteredRepos = prefix ? repos.filter((r) => r.includes(prefix)) : repos;

  // For each repo, fetch tags (ACR extension: _tags returns rich metadata)
  const items: ArtifactEntry[] = [];
  await Promise.all(
    filteredRepos.map(async (repo) => {
      const tagsUrl = `https://${loginServer}/acr/v1/${encodeURIComponent(repo)}/_tags?n=50&orderby=timedesc`;
      const tagsRes = await fetch(tagsUrl, { headers: authHeaders });
      if (!tagsRes.ok) {
        items.push({ name: repo });
        return;
      }
      const data = (await tagsRes.json()) as {
        tags?: Array<{
          name: string;
          digest?: string;
          createdTime?: string;
          lastUpdateTime?: string;
          signed?: boolean;
        }>;
      };
      const tags = data.tags ?? [];
      if (tags.length === 0) {
        items.push({ name: repo });
        return;
      }
      // Group tags by digest so we can present all tags on the same image together
      const byDigest = new Map<string, ArtifactEntry>();
      for (const t of tags) {
        const key = t.digest ?? `__${t.name}`;
        const existing = byDigest.get(key);
        if (existing) {
          existing.tags = [...(existing.tags ?? []), t.name];
        } else {
          const entry: ArtifactEntry = { name: repo, tags: [t.name] };
          if (t.digest) entry.digest = t.digest;
          if (t.lastUpdateTime) entry.updatedAt = t.lastUpdateTime;
          else if (t.createdTime) entry.updatedAt = t.createdTime;
          byDigest.set(key, entry);
        }
      }
      for (const entry of byDigest.values()) {
        const firstTag = entry.tags?.[0];
        if (firstTag) entry.version = firstTag;
        items.push(entry);
      }
    }),
  );

  // The Docker Registry catalog uses `last=<name>` for pagination —
  // the next page token is the last repo in the current page when it's full.
  const result: { items: ArtifactEntry[]; nextPageToken?: string } = { items };
  const lastRepo = repos[repos.length - 1];
  if (repos.length >= 50 && lastRepo) result.nextPageToken = lastRepo;
  return result;
}
