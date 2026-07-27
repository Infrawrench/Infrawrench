import type {
  AgentClient,
  AgentCreateBody,
  AgentSession,
  AgentSettings,
  AgentVmAccount,
} from "@infrawrench/ui/agents";
import { jsonInit, jsonOrThrow } from "./cookie-json";

// Full openSession response per the shared AgentClient contract — the server
// also returns the managed key (sshKeyId/sshKeyName) alongside command/cwd.
type AgentOpenSessionResult = Awaited<ReturnType<AgentClient["openSession"]>>;

export function createWebAgentClient(orgId: string): AgentClient {
  const base = `/api/org/${orgId}/agents`;
  return {
    listAccounts: () =>
      fetch(`${base}/accounts`, jsonInit("GET")).then((r) => jsonOrThrow<AgentVmAccount[]>(r)),
    getSettings: () =>
      fetch(`${base}/settings`, jsonInit("GET")).then((r) => jsonOrThrow<AgentSettings | null>(r)),
    saveSettings: (settings) =>
      fetch(`${base}/settings`, jsonInit("PUT", settings)).then((r) =>
        jsonOrThrow<AgentSettings>(r),
      ),
    listSessions: () =>
      fetch(`${base}/sessions`, jsonInit("GET")).then((r) => jsonOrThrow<AgentSession[]>(r)),
    createSession: (body: AgentCreateBody) =>
      fetch(`${base}/sessions`, jsonInit("POST", body)).then((r) => jsonOrThrow<AgentSession>(r)),
    openSession: (id: string) =>
      fetch(`${base}/sessions/${id}/open`, jsonInit("POST")).then((r) =>
        jsonOrThrow<AgentOpenSessionResult>(r),
      ),
    reconcileSession: (id: string) =>
      fetch(`${base}/sessions/${id}/reconcile`, jsonInit("POST")).then((r) =>
        jsonOrThrow<{ branchName: string; message: string }>(r),
      ),
    deleteSession: async (id: string) => {
      await fetch(`${base}/sessions/${id}`, jsonInit("DELETE")).then((r) =>
        jsonOrThrow<{ ok: boolean }>(r),
      );
    },
  };
}
