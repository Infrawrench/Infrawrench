/**
 * Browser-side WorkflowClient for the web app — talks to the org-scoped
 * `/api/org/:orgId/workflows` routes over fetch (session cookie auth).
 */
import type {
  WorkflowClient,
  WorkflowMetricRow,
  WorkflowRunRow,
  WorkflowSaveBody,
  WorkflowSummary,
} from "@infrawrench/ui/workflows";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ? `: ${body.error}` : "";
    } catch {
      // ignore
    }
    throw new Error(`Request failed (${res.status})${detail}`);
  }
  return (await res.json()) as T;
}

export function createWebWorkflowClient(orgId: string): WorkflowClient {
  const base = `/api/org/${orgId}/workflows`;
  const opts = (method: string, body?: unknown): RequestInit => ({
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  return {
    list: () => fetch(base, opts("GET")).then((r) => json<WorkflowSummary[]>(r)),
    create: (b: WorkflowSaveBody) =>
      fetch(base, opts("POST", b)).then((r) => json<WorkflowSummary>(r)),
    update: (id: string, b: WorkflowSaveBody) =>
      fetch(`${base}/${id}`, opts("PUT", b)).then((r) => json<WorkflowSummary>(r)),
    remove: (id: string) =>
      fetch(`${base}/${id}`, opts("DELETE"))
        .then((r) => json<{ ok: boolean }>(r))
        .then(() => undefined),
    getTypings: (id: string) =>
      fetch(`${base}/${id}/typings`, opts("GET"))
        .then((r) => json<{ dts: string }>(r))
        .then((d) => d.dts),
    run: (id: string) =>
      fetch(`${base}/${id}/run`, opts("POST")).then((r) =>
        json<{ runId: string; result: WorkflowRunRow }>(r),
      ),
    listRuns: (id: string) =>
      fetch(`${base}/${id}/runs`, opts("GET")).then((r) => json<WorkflowRunRow[]>(r)),
    listMetrics: (id: string) =>
      fetch(`${base}/${id}/metrics`, opts("GET")).then((r) => json<WorkflowMetricRow[]>(r)),
  };
}
