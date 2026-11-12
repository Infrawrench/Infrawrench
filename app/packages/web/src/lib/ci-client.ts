import type { CiClient } from "@infrawrench/ui/ci";
import {
  ciLogEvent,
  parseSseFrames,
  type CiAccount,
  type CiCacheCleared,
  type CiCaches,
  type CiLogEvent,
  type CiRun,
  type CiRunDetail,
  type CiStatus,
  type CiUsage,
  type CiValues,
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
    approveRun: async (id) => {
      await apiPost(`${base}/runs/${encodeURIComponent(id)}/approve`);
    },
    rejectRun: async (id) => {
      await apiPost(`${base}/runs/${encodeURIComponent(id)}/reject`);
    },
    retryRun: (id, { noTaskCache }) =>
      apiPost<CiRun>(`${base}/runs/${encodeURIComponent(id)}/retry`, { noTaskCache }),
    listCaches: () => apiGet<CiCaches>(`${base}/caches`),
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
  };
}
