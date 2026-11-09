import type { CiClient } from "@infrawrench/ui/ci";
import type {
  CiAccount,
  CiRun,
  CiRunDetail,
  CiStatus,
  CiUsage,
  CiValues,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

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
    approveRun: async (id) => {
      await apiPost(`${base}/runs/${encodeURIComponent(id)}/approve`);
    },
    rejectRun: async (id) => {
      await apiPost(`${base}/runs/${encodeURIComponent(id)}/reject`);
    },
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
  };
}
