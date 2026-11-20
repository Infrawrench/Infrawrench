import type {
  EnvFilesClient,
  EnvFilesRepoList,
  EnvFilesSecret,
} from "@infrawrench/ui/env-files/types";
import type {
  InfraenvCommitResult,
  InfraenvDescribeResponse,
  InfraenvRepoFile,
  InfraenvResolveResponse,
  InfraenvSource,
} from "@infrawrench/client-core";
import { apiGet, apiPost, apiPut } from "./api";

/**
 * Web implementation of the environment files client, per org. `apiFetch`
 * already turns the structured GitHub 409 into
 * `GithubPermissionRequiredClientError`, which the panel shows as the grant
 * prompt.
 */
export function createWebEnvFilesClient(orgId: string): EnvFilesClient {
  const org = `/api/org/${encodeURIComponent(orgId)}`;
  const base = `${org}/env-files`;
  const secrets = `${org}/workflow-secrets`;
  const query = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
    return search.toString();
  };
  return {
    describe: (source) => apiPost<InfraenvDescribeResponse>(`${base}/describe`, { source }),
    resolve: ({ source, environment, sourceName }) =>
      apiPost<InfraenvResolveResponse>(`${base}/resolve`, {
        source,
        environment,
        ...(sourceName ? { sourceName } : {}),
      }),
    listSources: async (q) =>
      (
        await apiGet<{ sources: InfraenvSource[] }>(
          `${base}/sources?${query({ q: q || undefined, limit: "50" })}`,
        )
      ).sources,
    listRepos: () => apiGet<EnvFilesRepoList>(`${base}/repos`),
    listBranches: (installationId, repo) =>
      apiGet<string[]>(
        `${org}/github-issues/branches?${query({ installationId: String(installationId), repo })}`,
      ),
    readFile: ({ installationId, repo, path, branch }) =>
      apiGet<InfraenvRepoFile>(
        `${base}/repo-file?${query({ installationId: String(installationId), repo, path, branch })}`,
      ),
    commit: (input) => apiPost<InfraenvCommitResult>(`${base}/commit`, input),
    listSecrets: async () =>
      (await apiGet<EnvFilesSecret[]>(secrets)).map(({ id, name, hasValue }) => ({
        id,
        name,
        hasValue,
      })),
    createSecret: async (name, value) => {
      const created = await apiPost<EnvFilesSecret>(secrets, { name });
      const written = await apiPut<EnvFilesSecret>(
        `${secrets}/${encodeURIComponent(created.id)}/value`,
        { value },
      );
      return { id: written.id, name: written.name, hasValue: written.hasValue };
    },
  };
}
