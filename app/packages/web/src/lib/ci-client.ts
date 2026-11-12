import type { CiClient } from "@infrawrench/ui/ci";
import {
  ciLogEvent,
  parseSseFrames,
  type CiAccessOverview,
  type CiConnectionAccess,
  type CiResourceGrant,
  type CiResourceOutputs,
  type SearchResult,
  type CiAccount,
  type CiCacheCleared,
  type CiCaches,
  type CiDownloadLink,
  type CiLogEvent,
  type CiRun,
  type CiRunDetail,
  type CiSchedules,
  type CiStatus,
  type CiUsage,
  type CiValues,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { fetchPluginCatalog } from "./plugin-catalog";

function scopeQuery(installationId: number, repo: string | null): string {
  const q = new URLSearchParams({ installationId: String(installationId) });
  if (repo) q.set("repo", repo);
  return q.toString();
}

/** Web implementation of the shared CI client, per org. */
export function createWebCiClient(orgId: string): CiClient {
  const org = encodeURIComponent(orgId);
  const base = `/api/org/${org}/ci`;
  return {
    status: () => apiGet<CiStatus>(base),
    setAccount: (installationId, enabled) =>
      apiPut<CiAccount>(`${base}/accounts/${installationId}`, { enabled }),
    installUrl: async () => {
      const res = await apiGet<{ url?: string | null }>(
        `/api/org/${org}/github/install-url?return=ci`,
      );
      return res.url ?? null;
    },
    listRuns: async (status) => {
      const res = await apiGet<{ runs: CiRun[] }>(
        `${base}/runs${status ? `?status=${encodeURIComponent(status)}` : ""}`,
      );
      return res.runs;
    },
    getRun: (id) => apiGet<CiRunDetail>(`${base}/runs/${encodeURIComponent(id)}`),
    async *streamRunLogs(id, signal): AsyncIterable<CiLogEvent> {
      const res = await fetch(`${base}/runs/${encodeURIComponent(id)}/logs`, {
        credentials: "include",
        headers: { Accept: "text/event-stream" },
        signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        let message = text || `HTTP ${res.status}`;
        try {
          const body = JSON.parse(text) as { error?: unknown };
          if (typeof body.error === "string") message = body.error;
        } catch {
          // Not JSON: the text itself.
        }
        throw new Error(message);
      }
      for await (const frame of parseSseFrames(res.body)) {
        const event = ciLogEvent(frame);
        if (event) yield event;
      }
    },
    downloadLink: (id, jobId, path) =>
      apiGet<CiDownloadLink>(
        `${base}/runs/${encodeURIComponent(id)}/download?${new URLSearchParams({ job: jobId, path })}`,
      ),
    approveRun: async (id) => {
      await apiPost(`${base}/runs/${encodeURIComponent(id)}/approve`);
    },
    rejectRun: async (id) => {
      await apiPost(`${base}/runs/${encodeURIComponent(id)}/reject`);
    },
    retryRun: (id, { noTaskCache }) =>
      apiPost<CiRun>(`${base}/runs/${encodeURIComponent(id)}/retry`, { noTaskCache }),
    cancelRun: (id) => apiPost<CiRun>(`${base}/runs/${encodeURIComponent(id)}/cancel`),
    listCaches: () => apiGet<CiCaches>(`${base}/caches`),
    listSchedules: () => apiGet<CiSchedules>(`${base}/schedules`),
    clearCache: (installationId, repo) =>
      apiDelete<CiCacheCleared>(`${base}/caches/${installationId}/${encodeURIComponent(repo)}`),
    usage: () => apiGet<CiUsage>(`${base}/usage`),
    listRepos: async (installationId) => {
      const { repos } = await apiGet<{
        repos: Array<{ installationId: number; fullName: string }>;
      }>(`/api/org/${org}/github/repos`);
      return repos
        .filter((r) => r.installationId === installationId)
        .map((r) => r.fullName.split("/")[1] ?? r.fullName);
    },
    listValues: (installationId, repo) =>
      apiGet<CiValues>(`${base}/values?${scopeQuery(installationId, repo)}`),
    setValue: async (installationId, repo, kind, name, value) => {
      await apiPut(
        `${base}/values/${kind}/${encodeURIComponent(name)}?${scopeQuery(installationId, repo)}`,
        { value },
      );
    },
    deleteValue: async (installationId, repo, kind, name) => {
      await apiDelete(
        `${base}/values/${kind}/${encodeURIComponent(name)}?${scopeQuery(installationId, repo)}`,
      );
    },
    access: () => apiGet<CiAccessOverview>(`${base}/access`),
    setConnectionAccess: (accountId, settings) =>
      apiPut<CiConnectionAccess>(
        `${base}/access/connections/${encodeURIComponent(accountId)}`,
        settings,
      ),
    preflightConnection: (accountId, kind) =>
      apiPost<CiConnectionAccess>(
        `${base}/access/connections/${encodeURIComponent(accountId)}/preflight`,
        { kind },
      ),
    searchResources: (query) =>
      apiGet<SearchResult[]>(
        `/api/org/${org}/search?${new URLSearchParams({ q: query, kinds: "resource" })}`,
      ),
    resourceOutputs: (resourceId) =>
      apiGet<CiResourceOutputs>(
        `${base}/access/resource-outputs?${new URLSearchParams({ resourceId })}`,
      ),
    createGrant: (input) => apiPost<CiResourceGrant>(`${base}/access/grants`, input),
    updateGrant: (id, input) =>
      apiPut<CiResourceGrant>(`${base}/access/grants/${encodeURIComponent(id)}`, input),
    deleteGrant: async (id) => {
      await apiDelete(`${base}/access/grants/${encodeURIComponent(id)}`);
    },
    revokeSshKeyLending: async (sshKeyId) => {
      await apiDelete(`${base}/access/ssh-keys/${encodeURIComponent(sshKeyId)}`);
    },
    listAllRepos: async () => {
      const [{ repos }, status] = await Promise.all([
        apiGet<{ repos: Array<{ installationId: number; fullName: string }> }>(
          `/api/org/${org}/github/repos`,
        ),
        apiGet<CiStatus>(base),
      ]);
      const ci = new Set(status.accounts.filter((a) => a.ciEnabled).map((a) => a.installationId));
      return repos.filter((r) => ci.has(r.installationId)).map((r) => r.fullName);
    },
    pluginLogos: async () =>
      Object.fromEntries((await fetchPluginCatalog(orgId)).map((p) => [p.id, p.logoSvg])),
  };
}
