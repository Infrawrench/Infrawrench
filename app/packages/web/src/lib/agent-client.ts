import type {
  AgentClient,
  AgentCreateBody,
  AgentSession,
  AgentSettings,
  AgentVmAccount,
} from "@infrawrench/ui/agents";

// Full openSession response per the shared AgentClient contract — the server
// also returns the managed key (sshKeyId/sshKeyName) alongside command/cwd.
type AgentOpenSessionResult = Awaited<ReturnType<AgentClient["openSession"]>>;

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

export function createWebAgentClient(orgId: string): AgentClient {
  const base = `/api/org/${orgId}/agents`;
  const opts = (method: string, body?: unknown): RequestInit => ({
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    listAccounts: () =>
      fetch(`${base}/accounts`, opts("GET")).then((r) => json<AgentVmAccount[]>(r)),
    getSettings: () =>
      fetch(`${base}/settings`, opts("GET")).then((r) => json<AgentSettings | null>(r)),
    saveSettings: (settings) =>
      fetch(`${base}/settings`, opts("PUT", settings)).then((r) => json<AgentSettings>(r)),
    listSessions: () => fetch(`${base}/sessions`, opts("GET")).then((r) => json<AgentSession[]>(r)),
    createSession: (body: AgentCreateBody) =>
      fetch(`${base}/sessions`, opts("POST", body)).then((r) => json<AgentSession>(r)),
    openSession: (id: string) =>
      fetch(`${base}/sessions/${id}/open`, opts("POST")).then((r) =>
        json<AgentOpenSessionResult>(r),
      ),
    reconcileSession: (id: string) =>
      fetch(`${base}/sessions/${id}/reconcile`, opts("POST")).then((r) =>
        json<{ branchName: string; message: string }>(r),
      ),
  };
}
